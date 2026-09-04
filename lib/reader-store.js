// lib/reader-store.js — persistence for reader sessions (chrome.storage.local).
//
// A session is one article opened in the reader: its title, source URL, and the
// list of paragraph blocks with whatever results have been generated for them
// (furigana tokens, translation, grammar). Sessions survive tab refreshes and
// browser restarts, so previously paid-for API results are never regenerated.
//
// Layout: a small index key listing every session (for the "recent sessions"
// list) plus one key per session holding the actual blocks. Splitting them means
// a debounced save rewrites a single session, not the whole library.
//
// DOM-free by design — the service worker imports this to create a session when
// the content script sends "openInReader".

import { getLocal, setLocal, removeLocal } from "./storage.js";

export const SESSION_INDEX_KEY = "readerSessionIndex";
export const SESSION_KEY_PREFIX = "readerSession:";
export const MAX_SESSIONS = 30;
export const SESSION_VERSION = 1;

const ID_RE = /^[a-z0-9]+$/;
const PREVIEW_LENGTH = 80;

export function sessionKey(id) {
  return `${SESSION_KEY_PREFIX}${id}`;
}

// Lowercase alphanumeric, sortable-ish by creation time. Kept free of separators
// so it is safe in a URL query without escaping.
export function newId(prefix = "") {
  const rand = Math.random().toString(36).slice(2).padEnd(5, "0").slice(0, 5);
  return `${prefix}${Date.now().toString(36)}${rand}`;
}

// A block record is the persisted half of a paragraph. `text` (ruby-free plain
// text) is the source of truth; results are null until generated. `stale` means
// the text was edited after results existed — they are kept so the user can see
// them dimmed, but furigana is no longer rendered over mismatched text.
export function makeBlock(tag, text) {
  return {
    id: newId("b"),
    tag: typeof tag === "string" && tag ? tag.toLowerCase() : "p",
    text: typeof text === "string" ? text : "",
    tokens: null,
    rawTokens: null,
    translation: null,
    translationLang: null,
    grammar: null,
    stale: false,
  };
}

// Fill in fields a record may lack (older sessions, or blocks built by callers).
function normalizeBlock(block) {
  if (!block || typeof block !== "object") return makeBlock("p", "");
  const base = makeBlock(block.tag, block.text);
  base.id = typeof block.id === "string" && block.id ? block.id : base.id;
  base.tokens = block.tokens || null;
  base.rawTokens = block.rawTokens || null;
  base.translation = block.translation || null;
  base.translationLang = block.translationLang || null;
  base.grammar = block.grammar || null;
  base.stale = !!block.stale;
  return base;
}

export function makeSession({ title = "", url = "", blocks = [] } = {}) {
  const now = Date.now();
  return {
    v: SESSION_VERSION,
    id: newId(),
    title,
    url,
    createdAt: now,
    updatedAt: now,
    blocks: blocks.map(normalizeBlock),
  };
}

export function summarize(session) {
  const blocks = session.blocks || [];
  const preview = blocks.find((b) => b.text && b.text.trim())?.text.trim() || "";
  return {
    id: session.id,
    title: session.title || "",
    url: session.url || "",
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    blockCount: blocks.length,
    annotatedCount: blocks.filter((b) => b.tokens && b.tokens.length).length,
    translatedCount: blocks.filter((b) => b.translation).length,
    preview: preview.slice(0, PREVIEW_LENGTH),
  };
}

// --- Index cache -----------------------------------------------------------
// Kept warm so saveSession() can reach chrome.storage.local.set synchronously,
// which is what makes the `pagehide` flush in the reader actually land.

let indexCache = null;

function sortIndex(list) {
  return list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

async function loadIndex() {
  if (indexCache) return indexCache;
  const stored = await getLocal(SESSION_INDEX_KEY);
  indexCache = sortIndex(Array.isArray(stored[SESSION_INDEX_KEY]) ? stored[SESSION_INDEX_KEY] : []);
  return indexCache;
}

// Another tab (or the service worker) may write the index; drop our copy so the
// next read picks theirs up instead of resurrecting deleted entries.
if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[SESSION_INDEX_KEY]) {
      const next = changes[SESSION_INDEX_KEY].newValue;
      indexCache = Array.isArray(next) ? sortIndex(next) : null;
    }
  });
}

// --- Public API ------------------------------------------------------------

export async function listSessions() {
  return (await loadIndex()).slice();
}

export async function getSession(id) {
  if (typeof id !== "string" || !ID_RE.test(id)) return null;
  const key = sessionKey(id);
  const stored = await getLocal(key);
  const session = stored[key];
  if (!session || !Array.isArray(session.blocks)) return null;
  session.blocks = session.blocks.map(normalizeBlock);
  return session;
}

export async function saveSession(session) {
  session.updatedAt = Date.now();
  if (!indexCache) await loadIndex();

  const summary = summarize(session);
  const rest = indexCache.filter((s) => s.id !== session.id);
  const next = [summary, ...rest]; // newest first; the saved session always survives eviction
  const evicted = next.slice(MAX_SESSIONS);
  indexCache = next.slice(0, MAX_SESSIONS);

  // No await before this line when the cache is warm — see the note above.
  const written = setLocal({ [SESSION_INDEX_KEY]: indexCache, [sessionKey(session.id)]: session });
  if (evicted.length) written.then(() => removeLocal(evicted.map((s) => sessionKey(s.id)))).catch(() => {});
  await written;
  return session;
}

export async function createSession(fields) {
  return saveSession(makeSession(fields));
}

export async function deleteSession(id) {
  if (!indexCache) await loadIndex();
  indexCache = indexCache.filter((s) => s.id !== id);
  await setLocal({ [SESSION_INDEX_KEY]: indexCache });
  await removeLocal(sessionKey(id));
}

// Bump a session to the top of the recent list without rewriting its blocks.
// Moved explicitly rather than by re-sorting: sessions created in the same
// millisecond share an updatedAt, and a stable sort would leave them put.
export async function touchSession(id) {
  if (!indexCache) await loadIndex();
  const entry = indexCache.find((s) => s.id === id);
  if (!entry) return;
  entry.updatedAt = Date.now();
  indexCache = [entry, ...indexCache.filter((s) => s.id !== id)];
  await setLocal({ [SESSION_INDEX_KEY]: indexCache });
}
