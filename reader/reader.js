import { escapeHtml, tokensToHtml } from "../lib/api.js";
import { t, applyI18n } from "../lib/i18n.js";
import { DEFAULTS } from "../lib/storage.js";
import {
  makeBlock,
  makeSession,
  createSession,
  getSession,
  saveSession,
  listSessions,
  deleteSession,
  touchSession,
} from "../lib/reader-store.js";

// Shared DOM selection helpers (loaded via lib/shared.js before this module — see reader.html).
// getTextWithoutRuby stays local (reader keeps <code>, unlike the content script).
const {
  formatDate,
  hasJapanese,
  applyLangDir,
  showVocabPopup,
  extractFromSelection,
  getWordFromRuby,
  extractSentence,
} = globalThis.KanaShared;

applyI18n();

// Read once and kept live, so rendering a restored session does not cost one
// storage round-trip per block.
let debugMode = false;

function showDebugTokens(view) {
  view.wrapper.querySelector(".kana-debug")?.remove();
  const tokens = view.record.rawTokens || view.record.tokens;
  if (!debugMode || !tokens) return;

  const json = JSON.stringify(tokens, null, 2);
  const debugDiv = document.createElement("div");
  debugDiv.className = "kana-debug";
  debugDiv.textContent = json;
  const copyBtn = document.createElement("button");
  copyBtn.className = "kana-debug-copy";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(json).then(() => {
      copyBtn.textContent = "Copied";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
    });
  });
  debugDiv.appendChild(copyBtn);
  view.el.after(debugDiv);
}

function refreshDebug() {
  for (const view of views.values()) showDebugTokens(view);
}

const annotateBtn = document.getElementById("annotateBtn");
const translateBtn = document.getElementById("translateBtn");
const cancelBtn = document.getElementById("cancelBtn");
const deleteSelBtn = document.getElementById("deleteSelBtn");
const progress = document.getElementById("progress");
const toolbarProgress = document.getElementById("toolbarProgress");
const toolbarProgressFill = document.getElementById("toolbarProgressFill");
const readerTitle = document.getElementById("reader-title");
const readerBody = document.getElementById("reader-body");
const originalLink = document.getElementById("originalLink");
const sessionHome = document.getElementById("sessionHome");
const sessionList = document.getElementById("sessionList");
const sessionEmpty = document.getElementById("sessionEmpty");
let originalUrl = "";

// --- Session state ---
// `session` is the persisted document; `views` holds the transient half of each
// block (DOM nodes, in-flight run, error) keyed by block id. A view's `record`
// is the very object that gets written back to storage.
let session = null;
let isDraft = false;
const views = new Map();
let activeBatch = null;

// --- Selection state ---
let lastClickedBlock = null;

function getAllBlocks() {
  return Array.from(readerBody.querySelectorAll(".reader-block"));
}

function viewOf(block) {
  return block ? views.get(block.dataset.blockId) : undefined;
}

function getAllViews() {
  return getAllBlocks().map(viewOf).filter(Boolean);
}

function clearSelection() {
  for (const b of getAllBlocks()) b.classList.remove("block-selected");
  lastClickedBlock = null;
  updateDeleteBtn();
}

function getSelectedBlocks() {
  return getAllBlocks().filter((b) => b.classList.contains("block-selected"));
}

function updateDeleteBtn() {
  const count = getSelectedBlocks().length;
  deleteSelBtn.hidden = count === 0;
  deleteSelBtn.textContent = t("deleteCount", { n: count });
}

function deleteSelected() {
  for (const b of getSelectedBlocks()) removeBlockView(viewOf(b));
  lastClickedBlock = null;
  updateDeleteBtn();
}

function handleBlockClick(e) {
  const block = e.target.closest(".reader-block");
  if (!block) return;

  if (e.target.closest(".block-actions, .block-status")) return;
  if (e.target.isContentEditable && !e.shiftKey) return;

  if (e.shiftKey && lastClickedBlock) {
    e.preventDefault();
    const blocks = getAllBlocks();
    const from = blocks.indexOf(lastClickedBlock);
    const to = blocks.indexOf(block);
    if (from === -1 || to === -1) return;
    const [start, end] = from < to ? [from, to] : [to, from];
    for (let i = start; i <= end; i++) {
      blocks[i].classList.add("block-selected");
    }
  } else {
    block.classList.toggle("block-selected");
    lastClickedBlock = block.classList.contains("block-selected") ? block : null;
  }

  updateDeleteBtn();
  if (e.shiftKey) window.getSelection()?.removeAllRanges();
}

readerBody.addEventListener("click", handleBlockClick);
deleteSelBtn.addEventListener("click", deleteSelected);

document.addEventListener("keydown", (e) => {
  if (e.target.isContentEditable) return;

  if ((e.key === "Delete" || e.key === "Backspace") && getSelectedBlocks().length > 0) {
    e.preventDefault();
    deleteSelected();
  }
  if (e.key === "Escape") {
    clearSelection();
  }
});

// --- Block views ---
// A view owns one paragraph: its DOM, its persisted record, and its state.
// `data-state` on the wrapper is the single hook every CSS rule keys off.

function deriveStatus(view) {
  if (view.run) return "loading";
  if (view.error) return "error";
  if (view.record.stale) return "stale";
  if (view.record.tokens || view.record.translation) return "done";
  return "idle";
}

// Results and the error row live inside the block, ahead of the action buttons,
// so deleting a paragraph takes its translation with it.
function ensureTransDiv(view) {
  if (view.transDiv) return view.transDiv;
  const div = document.createElement("div");
  div.className = "reader-translation";
  view.wrapper.insertBefore(div, view.statusRow || view.actions);
  view.transDiv = div;
  return div;
}

function ensureStatusRow(view) {
  if (view.statusRow) return view.statusRow;
  const row = document.createElement("div");
  row.className = "block-status";
  const msg = document.createElement("span");
  msg.className = "block-status-msg";
  const retry = document.createElement("button");
  retry.className = "block-status-retry";
  retry.textContent = t("retry");
  retry.addEventListener("click", (e) => {
    e.stopPropagation();
    retryBlock(view);
  });
  row.append(msg, retry);
  view.wrapper.insertBefore(row, view.actions);
  view.statusRow = row;
  return row;
}

// `content: false` leaves the text element untouched — used while the caret is in it.
function renderBlock(view, { content = true } = {}) {
  const r = view.record;
  view.status = deriveStatus(view);
  view.wrapper.dataset.state = view.status;
  view.wrapper.dataset.hasFurigana = String(!!(r.tokens && r.tokens.length));
  view.wrapper.dataset.hasTranslation = String(!!r.translation);
  // The only thing keeping a streamed innerHTML rewrite from clobbering typing.
  view.el.contentEditable = String(view.status !== "loading");

  if (content && view.status !== "loading") {
    if (r.tokens && r.tokens.length && !r.stale) {
      view.el.innerHTML = tokensToHtml(r.tokens);
      view.el.classList.add("kana-annotated");
    } else {
      view.el.textContent = r.text;
      view.el.classList.remove("kana-annotated");
    }
  }

  if (r.translation || view.pendingTranslation !== null) {
    const div = ensureTransDiv(view);
    if (view.status !== "loading") div.textContent = r.translation || "";
    applyLangDir(div, r.translationLang);
  } else if (view.transDiv) {
    view.transDiv.remove();
    view.transDiv = null;
  }

  if (view.status === "error") {
    ensureStatusRow(view).querySelector(".block-status-msg").textContent = t("blockError", {
      message: view.error,
    });
  } else if (view.statusRow) {
    view.statusRow.remove();
    view.statusRow = null;
  }

  view.reannotateBtn.title = r.stale
    ? t("staleTooltip")
    : r.translation
      ? t("regenerateTooltip")
      : t("reAnnotateTooltip");
}

function createBlockView(record) {
  const wrapper = document.createElement("div");
  wrapper.className = "reader-block";
  wrapper.dataset.blockId = record.id;
  wrapper.dataset.tag = record.tag;

  const el = document.createElement(record.tag);
  el.className = "block-content";
  el.setAttribute("contenteditable", "true");
  el.setAttribute("spellcheck", "false");

  const actions = document.createElement("div");
  actions.className = "block-actions";

  const reannotateBtn = document.createElement("button");
  reannotateBtn.className = "block-action block-reannotate";
  reannotateBtn.textContent = "↻";

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "block-action block-delete";
  deleteBtn.textContent = "×";
  deleteBtn.title = t("removeParagraph");

  actions.append(reannotateBtn, deleteBtn);
  wrapper.append(el, actions);

  const view = {
    record,
    wrapper,
    el,
    actions,
    reannotateBtn,
    transDiv: null,
    statusRow: null,
    status: "idle",
    error: null,
    run: null,
    pendingTranslation: null,
    lastRun: null,
    got: null,
  };
  views.set(record.id, view);

  // Editing invalidates results, so catch the intent before the text changes:
  // beforeinput fires ahead of the mutation, compositionstart ahead of any IME
  // composition (which must never begin inside a <ruby>).
  el.addEventListener("beforeinput", () => invalidateBlock(view));
  el.addEventListener("compositionstart", () => invalidateBlock(view));
  el.addEventListener("input", () => {
    record.text = getTextWithoutRuby(el);
    scheduleSave();
  });

  reannotateBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    redoBlock(view);
  });
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    removeBlockView(view);
  });

  renderBlock(view);
  return view;
}

function addBlockView(record, beforeWrapper = null) {
  const view = createBlockView(record);
  if (beforeWrapper) readerBody.insertBefore(view.wrapper, beforeWrapper);
  else readerBody.appendChild(view.wrapper);
  return view;
}

function removeBlockView(view) {
  if (!view) return;
  views.delete(view.record.id);
  view.wrapper.remove();
  updateDeleteBtn();
  scheduleSave();
}

function stripRuby(el) {
  el.querySelectorAll("ruby").forEach((ruby) => {
    const clone = ruby.cloneNode(true);
    clone.querySelectorAll("rt, rp").forEach((n) => n.remove());
    ruby.replaceWith(...clone.childNodes);
  });
  el.classList.remove("kana-annotated");
}

// Caret position measured in the plain (ruby-free) text, so it survives unwrapping.
function getCaretOffset(el) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer)) return null;
  const probe = document.createRange();
  probe.selectNodeContents(el);
  probe.setEnd(range.startContainer, range.startOffset);
  const box = document.createElement("div");
  box.appendChild(probe.cloneContents());
  box.querySelectorAll("rt, rp").forEach((n) => n.remove());
  return box.textContent.length;
}

function setCaretOffset(el, offset) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest("rt, rp") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  let node = null;
  let last = null;
  let remaining = offset;
  while ((node = walker.nextNode())) {
    last = node;
    if (remaining <= node.length) break;
    remaining -= node.length;
  }
  const range = document.createRange();
  if (node) range.setStart(node, remaining);
  else if (last) range.setStart(last, last.length);
  else range.setStart(el, 0);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// Editing text that carries furigana: drop the ruby (it no longer lines up) but
// keep the record's tokens and translation so the redo button knows what to
// regenerate, and mark the block stale so the mismatch is visible.
function invalidateBlock(view) {
  let changed = false;

  if (view.error) {
    view.error = null;
    changed = true;
  }

  const r = view.record;
  if (r.tokens && !r.stale) {
    if (view.el.querySelector("ruby")) {
      const offset = getCaretOffset(view.el);
      stripRuby(view.el);
      if (offset !== null) setCaretOffset(view.el, offset);
    }
    r.stale = true;
    changed = true;
  }

  if (changed) {
    renderBlock(view, { content: false });
    scheduleSave();
  }
}

function redoBlock(view) {
  const r = view.record;
  const mode =
    r.tokens && r.translation ? "both" : r.translation && !r.tokens ? "translate" : "annotate";
  runStream([view], mode, { upgrade: !!(r.tokens && r.tokens.length) });
}

function retryBlock(view) {
  const last = view.lastRun || { mode: "annotate", upgrade: false };
  runStream([view], last.mode, { upgrade: last.upgrade });
}

// --- Session load / save ---

function renderSession(loaded) {
  session = loaded;
  isDraft = false;
  sessionHome.hidden = true;
  document.title = loaded.title ? `${loaded.title} - 読める` : "読める Reader";
  readerTitle.textContent = loaded.title || "読める";
  originalUrl = loaded.url || "";
  if (originalUrl) {
    originalLink.href = originalUrl;
    originalLink.hidden = false;
  }
  readerBody.replaceChildren();
  views.clear();
  for (const record of loaded.blocks) addBlockView(record);
  refreshDebug();
}

// The blank reader: one paste target plus the recent-sessions list. Nothing is
// written to storage until there is actual text (see flushSave).
async function showHome(notice) {
  session = makeSession({});
  isDraft = true;
  document.title = "読める Reader";
  readerTitle.textContent = "読める";
  readerBody.replaceChildren();
  views.clear();

  const view = addBlockView(makeBlock("p", ""));
  view.el.setAttribute("placeholder", t("pasteHint"));
  view.el.classList.add("reader-empty-hint");
  view.el.addEventListener("paste", (e) => {
    const text = (e.clipboardData || window.clipboardData)?.getData("text");
    if (!text || !text.includes("\n")) return; // single line: let the browser insert it
    e.preventDefault();
    const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    for (const line of lines) addBlockView(makeBlock("p", line), view.wrapper);
    removeBlockView(view);
  });

  sessionHome.hidden = false;
  if (notice) {
    progress.textContent = notice;
    progress.classList.add("error");
  }
  await renderSessionList();
}

async function renderSessionList() {
  const sessions = await listSessions();
  sessionList.replaceChildren();
  sessionEmpty.hidden = sessions.length > 0;

  for (const summary of sessions) {
    const item = document.createElement("li");
    item.className = "session-item";

    const main = document.createElement("div");
    main.className = "session-item-main";
    const title = document.createElement("div");
    title.className = "session-item-title";
    title.textContent = summary.title || summary.preview || t("untitledSession");
    const meta = document.createElement("div");
    meta.className = "session-item-meta";
    const count = document.createElement("span");
    count.textContent = t("nParagraphs", { n: summary.blockCount });
    const when = document.createElement("span");
    when.textContent = formatDate(summary.updatedAt);
    meta.append(count, when);
    main.append(title, meta);

    const del = document.createElement("button");
    del.className = "session-delete";
    del.textContent = "×";
    del.title = t("deleteSession");
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteSession(summary.id);
      await renderSessionList();
    });

    item.append(main, del);
    item.addEventListener("click", () => {
      location.href = `reader.html?id=${summary.id}`;
    });
    sessionList.appendChild(item);
  }
}

let saveTimer = null;
let saveDirty = false;

function scheduleSave() {
  saveDirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}

function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!saveDirty || !session) return;

  session.blocks = getAllViews().map((v) => v.record);
  // An untouched blank reader should not litter the session list.
  if (isDraft && !session.blocks.some((b) => b.text.trim())) return;

  saveDirty = false;
  if (isDraft) {
    isDraft = false;
    history.replaceState(null, "", `?id=${session.id}`);
    sessionHome.hidden = true;
  }
  saveSession(session).catch((err) => {
    progress.textContent = err.message;
    progress.classList.add("error");
  });
}

window.addEventListener("pagehide", flushSave);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) flushSave();
});

async function loadContent() {
  const id = new URLSearchParams(location.search).get("id");

  if (id) {
    const loaded = await getSession(id);
    if (loaded) {
      renderSession(loaded);
      touchSession(id).catch(() => {});
      return;
    }
    await deleteSession(id); // the index claimed it existed; prune the stale entry
    await showHome(t("sessionNotFound"));
    return;
  }

  // One-time migration of the pre-session handoff key.
  const { readerData } = await chrome.storage.local.get("readerData");
  if (readerData?.content?.length) {
    const blocks = readerData.content
      .filter((item) => item.tag !== "img")
      .map((item) => makeBlock(item.tag, item.text));
    const created = await createSession({ title: readerData.title, url: readerData.url, blocks });
    await chrome.storage.local.remove("readerData");
    history.replaceState(null, "", `?id=${created.id}`);
    renderSession(created);
    return;
  }

  await showHome();
}

// --- Streaming annotation/translation via port ---

// Pull any un-debounced edits out of the DOM before a run reads block texts.
function syncTexts() {
  for (const view of getAllViews()) {
    if (view.status === "loading") continue;
    view.record.text = getTextWithoutRuby(view.el);
  }
}

function hasFresh(view, mode) {
  const r = view.record;
  if (r.stale) return false;
  return mode === "annotate" ? !!(r.tokens && r.tokens.length) : !!r.translation;
}

// With a selection, act on exactly those blocks (an explicit redo). Without one,
// act on every Japanese block that lacks a fresh result of this kind.
function collectTargets(mode) {
  const selected = getSelectedBlocks();
  const forced = selected.length > 0;
  const pool = (forced ? selected : getAllBlocks()).map(viewOf).filter(Boolean);
  const japanese = pool.filter(
    (v) => v.status !== "loading" && v.record.text.trim() && hasJapanese(v.record.text)
  );
  if (japanese.length === 0) return { targets: [], reason: "noJapanese" };
  const targets = forced ? japanese : japanese.filter((v) => !hasFresh(v, mode));
  return { targets, reason: targets.length ? null : "nothingToDo" };
}

function setToolbarProgress(done, total) {
  progress.textContent = t("progressFormat", { done, total });
  toolbarProgressFill.style.width = `${Math.round((done / total) * 100)}%`;
}

function setToolbarRunning(running, total, reason, failed) {
  annotateBtn.disabled = running;
  translateBtn.disabled = running;
  cancelBtn.hidden = !running;

  if (running) {
    progress.classList.remove("error");
    toolbarProgress.hidden = false;
    setToolbarProgress(0, total);
    return;
  }

  toolbarProgressFill.style.width = "100%";
  setTimeout(() => {
    toolbarProgress.hidden = true;
  }, 800);

  if (reason === "cancelled") {
    progress.textContent = t("cancelled");
  } else if (reason === "disconnected") {
    progress.textContent = t("connectionLost");
    progress.classList.add("error");
  } else if (failed > 0) {
    progress.textContent = t("doneWithErrors", { n: failed });
    progress.classList.add("error");
  } else {
    progress.textContent = t("doneParagraphs", { n: total });
  }
}

// One streaming run over a set of blocks. Batch runs drive the toolbar; the
// per-block redo and retry buttons open their own port and touch only their own
// block, so they can overlap a batch.
function runStream(targetViews, mode, { upgrade = false, batch = false } = {}) {
  const targets = targetViews.filter(Boolean);
  if (targets.length === 0) return null;

  syncTexts();
  const total = targets.length;
  const run = { mode, upgrade, batch, finished: false, failed: 0, targetLang: null, cancel: null };

  for (const view of targets) {
    view.run = run;
    view.error = null;
    view.lastRun = { mode, upgrade };
    view.pendingTranslation = mode === "annotate" ? null : "";
    view.got = { furigana: false, translation: false };
    view.el.blur();
    renderBlock(view);
    if (view.pendingTranslation !== null) ensureTransDiv(view).textContent = "";
  }

  if (batch) {
    activeBatch = run;
    setToolbarRunning(true, total);
  }

  const byIndex = (i) => {
    const view = targets[i];
    return view && view.run === run && view.wrapper.isConnected ? view : null;
  };

  const finish = (reason) => {
    if (run.finished) return;
    run.finished = true;
    try {
      port.disconnect();
    } catch {
      /* already gone */
    }
    if (batch) {
      activeBatch = null;
      setToolbarRunning(false, total, reason, run.failed);
    }
    scheduleSave();
  };

  // A block is done once every result this mode promised has arrived. Staleness
  // only clears when everything the block already had got refreshed.
  const maybeComplete = (view) => {
    const need =
      mode === "annotate"
        ? view.got.furigana
        : mode === "translate"
          ? view.got.translation
          : view.got.furigana && view.got.translation;
    if (!need) return;

    const r = view.record;
    const furiganaFresh = !r.tokens || (mode !== "translate" && view.got.furigana);
    const translationFresh = !r.translation || (mode !== "annotate" && view.got.translation);
    if (furiganaFresh && translationFresh) r.stale = false;

    view.run = null;
    view.pendingTranslation = null;
    renderBlock(view);
    showDebugTokens(view);
    scheduleSave();
  };

  let port;
  try {
    port = chrome.runtime.connect({ name: "kana-stream" });
  } catch (err) {
    for (const view of targets) {
      view.run = null;
      view.pendingTranslation = null;
      view.error = err.message;
      renderBlock(view);
    }
    if (batch) {
      activeBatch = null;
      setToolbarRunning(false, total, "disconnected", total);
    }
    return null;
  }

  port.onMessage.addListener((msg) => {
    if (run.finished) return;

    if (msg.type === "langInfo") {
      run.targetLang = msg.targetLang;
      for (const view of targets) {
        if (view.transDiv) applyLangDir(view.transDiv, msg.targetLang);
      }
      return;
    }

    const view = byIndex(msg.index);

    switch (msg.type) {
      case "furiganaPartial":
        if (view && msg.tokens?.length) view.el.innerHTML = tokensToHtml(msg.tokens);
        break;

      case "furigana":
        if (!view) break;
        if (msg.tokens?.length) {
          view.record.tokens = msg.tokens;
          view.record.rawTokens = msg.rawTokens || null;
        }
        view.got.furigana = true;
        maybeComplete(view);
        break;

      case "translationChunk":
        if (!view || view.pendingTranslation === null) break;
        view.pendingTranslation += msg.text;
        ensureTransDiv(view).textContent = view.pendingTranslation;
        break;

      case "translationDone":
        if (!view) break;
        view.record.translation = view.pendingTranslation || null;
        view.record.translationLang = run.targetLang;
        view.got.translation = true;
        maybeComplete(view);
        break;

      case "error":
        if (!view) break;
        run.failed++;
        view.run = null;
        view.pendingTranslation = null;
        view.error = msg.message;
        renderBlock(view);
        scheduleSave();
        break;

      case "progress":
        if (batch) setToolbarProgress(msg.done, total);
        break;

      case "allDone":
        finish("done");
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    if (run.finished) return; // we disconnected on purpose
    for (const view of targets) {
      if (view.run !== run) continue;
      view.run = null;
      view.pendingTranslation = null;
      view.error = t("connectionLost");
      renderBlock(view);
    }
    finish("disconnected");
  });

  run.cancel = () => {
    if (run.finished) return;
    // Records only ever change on a terminal message, so re-rendering from the
    // record is all it takes to undo a half-streamed block.
    for (const view of targets) {
      if (view.run !== run) continue;
      view.run = null;
      view.pendingTranslation = null;
      renderBlock(view);
    }
    finish("cancelled");
  };

  port.postMessage({
    type: "streamTranslate",
    paragraphs: targets.map((v) => v.record.text),
    mode,
    upgrade,
  });
  return run;
}

function runBatch(mode) {
  if (activeBatch) return;
  syncTexts();
  const { targets, reason } = collectTargets(mode);
  if (targets.length === 0) {
    progress.classList.remove("error");
    progress.textContent = reason === "noJapanese" ? t("noJapaneseText") : t("nothingToProcess");
    return;
  }
  runStream(targets, mode, { batch: true });
}

annotateBtn.addEventListener("click", () => runBatch("annotate"));
translateBtn.addEventListener("click", () => runBatch("translate"));
cancelBtn.addEventListener("click", () => activeBatch?.cancel());

// --- TTS bottom playbar ---

const ttsLoadingText = document.getElementById("ttsLoadingText");
const ttsProgressTrack = document.getElementById("ttsProgressTrack");
const ttsProgressFill = document.getElementById("ttsProgressFill");
const ttsProgressThumb = document.getElementById("ttsProgressThumb");
const ttsCurrentTime = document.getElementById("ttsCurrentTime");
const ttsTotalTime = document.getElementById("ttsTotalTime");
const ttsPrevBtn = document.getElementById("ttsPrevBtn");
const ttsPlayBtn = document.getElementById("ttsPlayBtn");
const ttsNextBtn = document.getElementById("ttsNextBtn");
const ttsSpeedSelect = document.getElementById("ttsSpeedSelect");
const ttsCloseBtn = document.getElementById("ttsCloseBtn");

let ttsState = null;
let ttsDragging = false;
let ttsDragWasPlaying = false;

function ttsFormatTime(secs) {
  if (!isFinite(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function ttsDataUrlToArrayBuffer(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const buf = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return buf;
}

function ttsGetCurrentPos() {
  if (!ttsState) return 0;
  if (ttsState.playing) {
    return ttsState.playStartOffset +
      (ttsState.audioCtx.currentTime - ttsState.playStartWallTime) * ttsState.speed;
  }
  return ttsState.pausedOffset;
}

function ttsHighlightAt(pos) {
  const { segmentOffsets, segmentIndexMap, elements, currentParaIdx } = ttsState;
  if (segmentOffsets.length === 0) return;

  let newIdx = segmentIndexMap[0];
  for (let i = segmentOffsets.length - 1; i >= 0; i--) {
    if (pos >= segmentOffsets[i]) { newIdx = segmentIndexMap[i]; break; }
  }
  if (newIdx === currentParaIdx) return;

  if (currentParaIdx >= 0) {
    const oldEl = elements[currentParaIdx];
    const oldBlock = oldEl?.closest(".reader-block") || oldEl?.parentElement;
    if (oldBlock) oldBlock.classList.remove("tts-playing");
  }
  const newEl = elements[newIdx];
  const newBlock = newEl?.closest(".reader-block") || newEl?.parentElement;
  if (newBlock) newBlock.classList.add("tts-playing");
  newEl?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  ttsState.currentParaIdx = newIdx;
}

function ttsRafUpdate() {
  if (!ttsState) return;
  ttsState.rafId = requestAnimationFrame(ttsRafUpdate);

  const pos = ttsGetCurrentPos();
  const { concatBuffer } = ttsState;

  if (concatBuffer && !ttsDragging) {
    const pct = Math.min(100, (pos / concatBuffer.duration) * 100);
    ttsProgressFill.style.width = pct + "%";
    ttsProgressThumb.style.left = pct + "%";
    ttsCurrentTime.textContent = ttsFormatTime(pos);
  }

  if (concatBuffer && ttsState.segmentOffsets.length > 0) {
    ttsHighlightAt(pos);
  }
}

function ttsRebuildBuffer() {
  const { audioCtx, decodedBuffers, errors } = ttsState;
  const validIdxs = [...decodedBuffers.keys()].filter(i => !errors.has(i)).sort((a, b) => a - b);
  if (validIdxs.length === 0) return;

  const first = decodedBuffers.get(validIdxs[0]);
  const sr = first.sampleRate;
  const ch = first.numberOfChannels;

  const offsets = [];
  const indexMap = [];
  let totalSamples = 0;
  let offsetSec = 0;
  const gapSec = 1;
  const gapSamples = Math.round(gapSec * sr);

  for (let i = 0; i < validIdxs.length; i++) {
    if (i > 0) { offsetSec += gapSec; totalSamples += gapSamples; }
    offsets.push(offsetSec);
    indexMap.push(validIdxs[i]);
    const b = decodedBuffers.get(validIdxs[i]);
    offsetSec += b.duration;
    totalSamples += b.length;
  }

  const concat = audioCtx.createBuffer(ch, totalSamples, sr);
  let samplePos = 0;
  for (let i = 0; i < validIdxs.length; i++) {
    if (i > 0) samplePos += gapSamples;
    const b = decodedBuffers.get(validIdxs[i]);
    for (let c = 0; c < ch; c++) concat.getChannelData(c).set(b.getChannelData(c), samplePos);
    samplePos += b.length;
  }

  ttsState.concatBuffer = concat;
  ttsState.segmentOffsets = offsets;
  ttsState.segmentIndexMap = indexMap;
  ttsTotalTime.textContent = ttsFormatTime(concat.duration);
}

function ttsCheckAllReceived() {
  if (!ttsState) return;
  if (ttsState.received.size + ttsState.errors.size < ttsState.totalSegments) return;
  ttsState.loadingDone = true;
  try { ttsState.port.disconnect(); } catch {}
  ttsPlayBtn.classList.remove("loading");
  ttsLoadingText.hidden = true;
  if (ttsState.concatBuffer) playTTS(0);
}

function ttsUpdateLoadingText() {
  if (!ttsState) return;
  const done = ttsState.received.size + ttsState.errors.size;
  ttsLoadingText.textContent = `${done} / ${ttsState.totalSegments}`;
}

async function handleTTSMessage(msg) {
  const state = ttsState;
  if (!state) return;

  if (msg.type === "ttsAudio") {
    let audioBuf;
    try {
      const arrayBuf = ttsDataUrlToArrayBuffer(msg.audioDataUrl);
      audioBuf = await state.audioCtx.decodeAudioData(arrayBuf);
    } catch (err) {
      console.warn("Yomeru: TTS decode error for segment", msg.index, err);
      if (ttsState !== state) return;
      state.errors.add(msg.index);
      ttsUpdateLoadingText();
      ttsCheckAllReceived();
      return;
    }
    if (ttsState !== state) return;
    state.decodedBuffers.set(msg.index, audioBuf);
    state.received.add(msg.index);
    ttsRebuildBuffer();
    ttsUpdateLoadingText();
    ttsCheckAllReceived();
  } else if (msg.type === "ttsError") {
    console.warn("Yomeru: TTS error for segment", msg.index, msg.message);
    state.errors.add(msg.index);
    ttsUpdateLoadingText();
    ttsCheckAllReceived();
  }
}

function playTTS(offsetSeconds) {
  if (!ttsState || !ttsState.concatBuffer) return;
  if (ttsState.sourceNode) {
    ttsState.sourceNode.onended = null;
    ttsState.sourceNode.stop();
    ttsState.sourceNode = null;
  }
  if (ttsState.audioCtx.state === "suspended") ttsState.audioCtx.resume();

  const offset = Math.max(0, Math.min(offsetSeconds, ttsState.concatBuffer.duration - 0.001));
  const node = ttsState.audioCtx.createBufferSource();
  node.buffer = ttsState.concatBuffer;
  node.playbackRate.value = ttsState.speed;
  node.connect(ttsState.audioCtx.destination);
  node.onended = () => { if (ttsState && ttsState.playing) onTTSEnded(); };
  node.start(0, offset);

  ttsState.sourceNode = node;
  ttsState.playStartWallTime = ttsState.audioCtx.currentTime;
  ttsState.playStartOffset = offset;
  ttsState.playing = true;
  ttsPlayBtn.textContent = "⏸";
}

function pauseTTS() {
  if (!ttsState || !ttsState.playing) return;
  ttsState.pausedOffset = ttsGetCurrentPos();
  if (ttsState.sourceNode) {
    ttsState.sourceNode.onended = null;
    ttsState.sourceNode.stop();
    ttsState.sourceNode = null;
  }
  ttsState.playing = false;
  ttsPlayBtn.textContent = "▶";
}

function seekTTS(offsetSeconds) {
  if (!ttsState || !ttsState.concatBuffer) return;
  const offset = Math.max(0, Math.min(offsetSeconds, ttsState.concatBuffer.duration));
  if (ttsState.playing) {
    playTTS(offset);
  } else {
    ttsState.pausedOffset = offset;
    const pct = (offset / ttsState.concatBuffer.duration) * 100;
    ttsProgressFill.style.width = pct + "%";
    ttsProgressThumb.style.left = pct + "%";
    ttsCurrentTime.textContent = ttsFormatTime(offset);
  }
}

function skipParagraph(dir) {
  if (!ttsState || !ttsState.concatBuffer || ttsState.segmentOffsets.length === 0) return;
  const pos = ttsGetCurrentPos();
  let curIdx = 0;
  for (let i = ttsState.segmentOffsets.length - 1; i >= 0; i--) {
    if (pos >= ttsState.segmentOffsets[i]) { curIdx = i; break; }
  }
  const target = Math.max(0, Math.min(curIdx + dir, ttsState.segmentOffsets.length - 1));
  seekTTS(ttsState.segmentOffsets[target]);
}

function setTTSSpeed(value) {
  if (!ttsState) return;
  const wasPlaying = ttsState.playing;
  const pos = ttsGetCurrentPos();
  ttsState.speed = value;
  if (ttsState.sourceNode) {
    ttsState.sourceNode.onended = null;
    ttsState.sourceNode.stop();
    ttsState.sourceNode = null;
    ttsState.playing = false;
  }
  if (wasPlaying && ttsState.concatBuffer) {
    playTTS(pos);
  } else {
    ttsState.pausedOffset = pos;
  }
}

function onTTSEnded() {
  if (!ttsState) return;
  ttsState.playing = false;
  ttsState.sourceNode = null;
  ttsState.pausedOffset = 0;
  ttsPlayBtn.textContent = "▶";
  ttsState.elements.forEach(el => {
    const block = el.closest(".reader-block") || el.parentElement;
    if (block) block.classList.remove("tts-playing");
  });
  ttsState.currentParaIdx = -1;
  ttsProgressFill.style.width = "0%";
  ttsProgressThumb.style.left = "0%";
  ttsCurrentTime.textContent = "0:00";
}

function stopTTS() {
  if (!ttsState) return;
  cancelAnimationFrame(ttsState.rafId);
  if (ttsState.sourceNode) {
    ttsState.sourceNode.onended = null;
    ttsState.sourceNode.stop();
  }
  try { ttsState.audioCtx.close(); } catch {}
  try { ttsState.port.disconnect(); } catch {}
  ttsState.elements.forEach(el => {
    const block = el.closest(".reader-block") || el.parentElement;
    if (block) block.classList.remove("tts-playing");
  });
  ttsState = null;
  ttsPlayBtn.classList.remove("loading");
  ttsPlayBtn.textContent = "▶";
  ttsLoadingText.hidden = true;
  ttsProgressFill.style.width = "0%";
  ttsProgressThumb.style.left = "0%";
  ttsCurrentTime.textContent = "0:00";
  ttsTotalTime.textContent = "--:--";
  ttsSpeedSelect.value = "1";
}

function startTTS() {
  if (ttsState) return;

  const selected = getSelectedBlocks();
  let elements;
  if (selected.length > 0) {
    elements = selected
      .map(b => b.querySelector(".block-content"))
      .filter(el => el && el.textContent.trim().length > 0);
  } else {
    elements = Array.from(
      readerBody.querySelectorAll(".block-content")
    ).filter(el => el.textContent.trim().length > 0);
  }

  if (elements.length === 0) return;

  const texts = elements.map(el => getTextWithoutRuby(el));
  const audioCtx = new AudioContext();
  const port = chrome.runtime.connect({ name: "kana-tts" });

  ttsState = {
    port,
    elements,
    texts,
    totalSegments: texts.length,
    audioCtx,
    decodedBuffers: new Map(),
    received: new Set(),
    errors: new Set(),
    concatBuffer: null,
    segmentOffsets: [],
    segmentIndexMap: [],
    sourceNode: null,
    playStartWallTime: 0,
    playStartOffset: 0,
    pausedOffset: 0,
    playing: false,
    speed: parseFloat(ttsSpeedSelect.value) || 1,
    loadingDone: false,
    currentParaIdx: -1,
    rafId: null,
  };

  ttsPlayBtn.classList.add("loading");
  ttsLoadingText.hidden = false;
  ttsLoadingText.textContent = `0 / ${texts.length}`;

  port.onMessage.addListener(handleTTSMessage);

  for (let i = 0; i < texts.length; i++) {
    port.postMessage({ type: "ttsRequest", index: i, text: texts[i] });
  }

  ttsRafUpdate();
}

ttsCloseBtn.addEventListener("click", stopTTS);

ttsPlayBtn.addEventListener("click", () => {
  if (ttsPlayBtn.classList.contains("loading")) return;
  if (!ttsState) {
    startTTS();
    return;
  }
  if (ttsState.playing) {
    pauseTTS();
  } else if (ttsState.concatBuffer) {
    playTTS(ttsState.pausedOffset);
  }
});

ttsPrevBtn.addEventListener("click", () => skipParagraph(-1));
ttsNextBtn.addEventListener("click", () => skipParagraph(1));
ttsSpeedSelect.addEventListener("change", () => setTTSSpeed(parseFloat(ttsSpeedSelect.value)));

ttsProgressTrack.addEventListener("mousedown", e => {
  if (!ttsState || !ttsState.concatBuffer) return;
  ttsDragging = true;
  ttsDragWasPlaying = ttsState.playing;
  ttsProgressTrack.classList.add("dragging");
  if (ttsDragWasPlaying) pauseTTS();
  ttsDragUpdatePos(e);
});

document.addEventListener("mousemove", e => {
  if (!ttsDragging) return;
  ttsDragUpdatePos(e);
});

document.addEventListener("mouseup", e => {
  if (!ttsDragging) return;
  ttsDragging = false;
  ttsProgressTrack.classList.remove("dragging");
  if (!ttsState || !ttsState.concatBuffer) return;
  const frac = ttsGetTrackFrac(e);
  const offset = frac * ttsState.concatBuffer.duration;
  if (ttsDragWasPlaying) {
    playTTS(offset);
  } else {
    seekTTS(offset);
  }
});

function ttsGetTrackFrac(e) {
  const rect = ttsProgressTrack.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
}

function ttsDragUpdatePos(e) {
  if (!ttsState || !ttsState.concatBuffer) return;
  const frac = ttsGetTrackFrac(e);
  const secs = frac * ttsState.concatBuffer.duration;
  ttsProgressFill.style.width = (frac * 100) + "%";
  ttsProgressThumb.style.left = (frac * 100) + "%";
  ttsCurrentTime.textContent = ttsFormatTime(secs);
}

// --- Vocabulary popup (select text or click ruby in annotated blocks) ---

// extractFromSelection / getWordFromRuby / extractSentence provided by KanaShared (see top of file).

function getTextWithoutRuby(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll("rt, rp").forEach((n) => n.remove());
  return clone.textContent;
}

function findReaderContext(node) {
  const el = node.nodeType === 3 ? node.parentElement : node;
  // Translations and the error row are not study material.
  if (el.closest(".reader-translation, .block-status, .block-actions, .kana-debug")) return null;
  return el.closest(".kana-annotated") || el.closest(".reader-block");
}

document.addEventListener("mouseup", (e) => {
  if (e.target.closest(".reader-vocab-popup")) return;

  setTimeout(() => {
    const existingPopup = document.querySelector(".reader-vocab-popup");
    if (existingPopup) existingPopup.remove();

    const sel = window.getSelection();

    if (sel && !sel.isCollapsed && sel.toString().trim()) {
      // Text selection mode
      const range = sel.getRangeAt(0);
      const ancestor = range.commonAncestorContainer;
      const contextEl = findReaderContext(ancestor);
      if (!contextEl) return;

      const { word, reading } = extractFromSelection(range);
      if (!word) return;

      const annotatedEl = contextEl.closest(".reader-block")?.querySelector(".kana-annotated") || contextEl;
      const context = extractSentence(getTextWithoutRuby(annotatedEl), word);

      const rect = range.getBoundingClientRect();
      showReaderVocabPopupAt(word, reading, context, rect);
    } else {
      // Click on ruby
      const ruby = e.target.closest("ruby");
      if (!ruby || !ruby.closest(".kana-annotated")) return;

      const word = getWordFromRuby(ruby);
      const reading = ruby.querySelector("rt")?.textContent || "";
      const annotatedEl = ruby.closest(".kana-annotated");
      const context = extractSentence(getTextWithoutRuby(annotatedEl), word);

      const rect = ruby.getBoundingClientRect();
      showReaderVocabPopupAt(word, reading, context, rect);
    }
  }, 10);
});

document.addEventListener("mousedown", (e) => {
  if (e.target.closest(".reader-vocab-popup")) return;
  const popup = document.querySelector(".reader-vocab-popup");
  if (popup) popup.remove();
});

function showReaderVocabPopupAt(word, reading, context, rect) {
  showVocabPopup({
    rootClass: "reader-vocab-popup",
    word,
    reading,
    context,
    sourceUrl: originalUrl || location.href,
    rect,
    labels: { save: t("addToVocab"), added: t("added"), failed: t("failed") },
  });
}

// --- Quiz panel ---

const quizBtn = document.getElementById("quizBtn");
const quizPanel = document.getElementById("quiz-panel");
const quizBody = document.getElementById("quiz-body");
const quizCloseBtn = document.getElementById("quizCloseBtn");
const readerLayout = document.getElementById("readerLayout");
let quizStartTime = null;
let quizData = null;
let answeredCount = 0;
let correctCount = 0;

function getPlainText() {
  const elements = Array.from(
    readerBody.querySelectorAll(".block-content")
  ).filter((el) => el.textContent.trim().length > 0);
  return elements.map((el) => getTextWithoutRuby(el)).join("\n\n");
}

async function startQuiz() {
  const text = getPlainText();
  if (!text.trim()) return;

  quizPanel.hidden = false;
  readerLayout.classList.add("quiz-open");
  quizBody.innerHTML = `<div class="quiz-loading">${t("quizGenerating")}</div>`;
  quizBtn.disabled = true;

  const { jlptLevel = DEFAULTS.jlptLevel, targetLang = DEFAULTS.targetLang } = await chrome.storage.sync.get(["jlptLevel", "targetLang"]);

  try {
    const response = await chrome.runtime.sendMessage({
      type: "generateQuiz",
      text,
      jlptLevel,
    });

    if (response?.error) throw new Error(response.error);

    quizData = response.quiz;
    answeredCount = 0;
    correctCount = 0;
    quizStartTime = Date.now();
    renderQuiz(quizData, targetLang);
  } catch (err) {
    quizBody.innerHTML = `<div class="quiz-error">${escapeHtml(err.message)}</div>`;
    quizBtn.disabled = false;
  }
}

// Shuffle array in place (Fisher-Yates) and return index mapping
function shuffleOptions(options) {
  const indices = options.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return {
    shuffled: indices.map((i) => options[i]),
    correctIndex: indices.indexOf(0), // original index 0 is always the correct answer
  };
}

// Store the correct index per question after shuffling
let quizCorrectIndices = [];

function renderQuiz(data, targetLang) {
  quizCorrectIndices = [];
  const langAttr = targetLang ? ` lang="${targetLang}"` : "";
  const dirAttr = targetLang === "ar" ? ' dir="rtl" style="text-align:right"' : "";

  let html = `<div class="quiz-difficulty">${t("quizDifficulty", { n: data.difficulty })}</div>`;

  data.questions.forEach((q, i) => {
    const { shuffled, correctIndex } = shuffleOptions(q.options);
    quizCorrectIndices.push(correctIndex);

    html += `<div class="quiz-question" data-index="${i}">`;
    html += `<div class="quiz-question-text"><span class="quiz-question-num">${t("questionNum", { n: i + 1 })}</span>${escapeHtml(q.question)}</div>`;
    html += `<div class="quiz-options">`;
    shuffled.forEach((opt, j) => {
      html += `<button class="quiz-option" data-question="${i}" data-option="${j}">${escapeHtml(opt)}</button>`;
    });
    html += `</div>`;
    html += `<div class="quiz-explanation" hidden${langAttr}${dirAttr}><span class="quiz-explanation-label">${t("quizExplanation")}:</span> ${escapeHtml(q.explanation)}</div>`;
    html += `</div>`;
  });

  quizBody.innerHTML = html;

  quizBody.querySelectorAll(".quiz-option").forEach((btn) => {
    btn.addEventListener("click", handleOptionClick);
  });
}

function handleOptionClick(e) {
  const btn = e.currentTarget;
  const qi = parseInt(btn.dataset.question);
  const oi = parseInt(btn.dataset.option);
  const questionEl = quizBody.querySelector(`.quiz-question[data-index="${qi}"]`);

  if (questionEl.classList.contains("answered")) return;
  questionEl.classList.add("answered");

  const correct = quizCorrectIndices[qi];
  const isCorrect = oi === correct;

  btn.classList.add(isCorrect ? "correct" : "incorrect");
  questionEl.querySelectorAll(".quiz-option")[correct].classList.add("correct");
  questionEl.querySelectorAll(".quiz-option").forEach((b) => b.classList.add("disabled"));

  questionEl.querySelector(".quiz-explanation").hidden = false;

  answeredCount++;
  if (isCorrect) correctCount++;

  if (answeredCount === quizData.questions.length) {
    showQuizResults();
  }
}

async function showQuizResults() {
  const timeTaken = Math.round((Date.now() - quizStartTime) / 1000);
  const total = quizData.questions.length;
  const difficulty = quizData.difficulty;
  const progressScore = Math.round((correctCount / total) * difficulty * 10);

  const resultsHtml = `<div class="quiz-results">
    <h3>${t("quizResults")}</h3>
    <div class="quiz-results-grid">
      <div class="quiz-result-item">
        <div class="quiz-result-value">${correctCount}/${total}</div>
        <div class="quiz-result-label">${t("quizScore", { correct: correctCount, total })}</div>
      </div>
      <div class="quiz-result-item">
        <div class="quiz-result-value">${timeTaken}s</div>
        <div class="quiz-result-label">${t("quizTimeTaken", { time: timeTaken })}</div>
      </div>
      <div class="quiz-result-item">
        <div class="quiz-result-value">${progressScore}</div>
        <div class="quiz-result-label">${t("progressScore")}</div>
      </div>
    </div>
    <button class="toolbar-btn primary quiz-retry">${t("quizRetry")}</button>
  </div>`;
  quizBody.insertAdjacentHTML("beforeend", resultsHtml);
  quizBody.querySelector(".quiz-retry").addEventListener("click", startQuiz);

  // Scroll results into view
  quizBody.querySelector(".quiz-results").scrollIntoView({ behavior: "smooth" });

  // Save to history
  const { quizHistory = [] } = await chrome.storage.local.get("quizHistory");
  quizHistory.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    url: originalUrl,
    title: readerTitle.textContent,
    difficulty,
    correct: correctCount,
    total,
    progressScore,
    timeTaken,
    timestamp: Date.now(),
  });
  // Cap at 200 entries
  if (quizHistory.length > 200) quizHistory.splice(0, quizHistory.length - 200);
  await chrome.storage.local.set({ quizHistory });
}

function closeQuiz() {
  quizPanel.hidden = true;
  readerLayout.classList.remove("quiz-open");
  quizBtn.disabled = false;
}

quizBtn.addEventListener("click", startQuiz);
quizCloseBtn.addEventListener("click", closeQuiz);

// --- Boot ---

chrome.storage.sync.get("debugMode", (result) => {
  debugMode = !!result.debugMode;
  refreshDebug();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.debugMode) return;
  debugMode = !!changes.debugMode.newValue;
  refreshDebug();
});

loadContent();
