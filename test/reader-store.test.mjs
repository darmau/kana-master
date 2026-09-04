// Exercises lib/reader-store.js against a fake chrome.storage.local.
import assert from "node:assert/strict";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const store = new Map();
const listeners = [];
globalThis.chrome = {
  runtime: { lastError: null },
  storage: {
    onChanged: { addListener: (fn) => listeners.push(fn) },
    local: {
      get(keys, cb) {
        const names = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const out = {};
        for (const k of names) if (store.has(k)) out[k] = structuredClone(store.get(k));
        cb(out);
      },
      set(obj, cb) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: store.get(k), newValue: structuredClone(v) };
          store.set(k, structuredClone(v));
        }
        cb();
        for (const fn of listeners) fn(changes, "local");
      },
      remove(keys, cb) {
        for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
        cb();
      },
    },
  },
};

const S = await import(`file://${ROOT}/lib/reader-store.js`);

// --- create / read back ---
const created = await S.createSession({
  title: "テスト記事",
  url: "https://example.com/a",
  blocks: [S.makeBlock("h2", "見出し"), S.makeBlock("p", "本文です。")],
});
assert.match(created.id, /^[a-z0-9]+$/, "session id must be url-safe");
const loaded = await S.getSession(created.id);
assert.equal(loaded.blocks.length, 2);
assert.equal(loaded.blocks[0].tag, "h2");
assert.equal(loaded.blocks[1].text, "本文です。");
assert.equal(loaded.blocks[0].tokens, null, "unset results must be null, not undefined");

// --- results survive a save/load round-trip ---
loaded.blocks[1].tokens = [{ t: "本文", r: "ほんぶん" }, { t: "です。" }];
loaded.blocks[1].translation = "这是正文。";
loaded.blocks[1].translationLang = "zh-CN";
await S.saveSession(loaded);
const again = await S.getSession(created.id);
assert.equal(again.blocks[1].translation, "这是正文。");
assert.deepEqual(again.blocks[1].tokens, [{ t: "本文", r: "ほんぶん" }, { t: "です。" }]);

// --- index summary reflects progress ---
const [summary] = await S.listSessions();
assert.equal(summary.id, created.id);
assert.equal(summary.blockCount, 2);
assert.equal(summary.annotatedCount, 1);
assert.equal(summary.translatedCount, 1);
assert.equal(summary.preview, "見出し");

// --- bad ids are rejected, missing ids return null ---
assert.equal(await S.getSession("../evil"), null);
assert.equal(await S.getSession("nosuchid"), null);

// --- LRU eviction at MAX_SESSIONS ---
for (let i = 0; i < S.MAX_SESSIONS + 5; i++) {
  await S.createSession({ title: `t${i}`, blocks: [S.makeBlock("p", `本文${i}`)] });
}
const list = await S.listSessions();
assert.equal(list.length, S.MAX_SESSIONS, "index is capped");
const sessionKeys = [...store.keys()].filter((k) => k.startsWith(S.SESSION_KEY_PREFIX));
assert.equal(sessionKeys.length, S.MAX_SESSIONS, "evicted session bodies are deleted, not orphaned");
assert.equal(await S.getSession(created.id), null, "the oldest session was evicted");
assert.deepEqual(
  list.map((s) => s.updatedAt).slice().sort((a, b) => b - a),
  list.map((s) => s.updatedAt),
  "index stays sorted newest-first"
);

// --- touch reorders without rewriting blocks ---
const oldest = list[list.length - 1];
await S.touchSession(oldest.id);
assert.equal((await S.listSessions())[0].id, oldest.id, "touched session moves to the top");
assert.ok(await S.getSession(oldest.id), "touch must not drop the body");

// --- delete removes both halves ---
await S.deleteSession(oldest.id);
assert.equal(await S.getSession(oldest.id), null);
assert.ok(!(await S.listSessions()).some((s) => s.id === oldest.id));

// --- saveSession reaches storage.set synchronously (what makes pagehide work) ---
let sawSet = false;
const realSet = chrome.storage.local.set;
chrome.storage.local.set = (obj, cb) => { sawSet = true; realSet(obj, cb); };
S.saveSession(await S.getSession((await S.listSessions())[0].id));
assert.equal(sawSet, true, "set must be called before the first await");

console.log("reader-store: all assertions passed");
