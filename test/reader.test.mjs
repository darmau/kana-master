// Loads the real reader page in jsdom with a faked chrome API and drives the
// block state machine + streaming controller through the paths that matter.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const storageLocal = new Map();
const storageSync = new Map([["debugMode", false]]);

let streamPort = null; // the page's end of the last kana-stream connection

function makeChrome(dom) {
  const onChangedListeners = [];
  const area = (map, name) => ({
    get(keys, cb) {
      const names =
        typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of names) if (map.has(k)) out[k] = structuredClone(map.get(k));
      if (cb) return void cb(out);
      return Promise.resolve(out);
    },
    set(obj, cb) {
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: map.get(k), newValue: structuredClone(v) };
        map.set(k, structuredClone(v));
      }
      cb?.();
      for (const fn of onChangedListeners) fn(changes, name);
      return Promise.resolve();
    },
    remove(keys, cb) {
      for (const k of Array.isArray(keys) ? keys : [keys]) map.delete(k);
      cb?.();
      return Promise.resolve();
    },
  });

  return {
    runtime: {
      lastError: null,
      getURL: (p) => `chrome-extension://test/${p}`,
      sendMessage: () => Promise.resolve({}),
      connect() {
        // Two-sided fake port: `page` is what the page holds, `sw` is our lever.
        const pageListeners = [];
        const disconnectListeners = [];
        const port = {
          postMessage(msg) {
            port.sent.push(msg);
          },
          disconnect() {
            port.disconnected = true;
          },
          onMessage: { addListener: (fn) => pageListeners.push(fn) },
          onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
          sent: [],
          disconnected: false,
          emit: (msg) => pageListeners.forEach((fn) => fn(msg)),
          kill: () => disconnectListeners.forEach((fn) => fn()),
        };
        streamPort = port;
        return port;
      },
    },
    i18n: {
      getUILanguage: () => "en",
      getMessage: (key, subs = []) => {
        const table = JSON.parse(readFileSync(`${ROOT}/_locales/en/messages.json`, "utf8"));
        let msg = table[key]?.message;
        if (!msg) return "";
        const ph = table[key]?.placeholders || {};
        for (const [name, def] of Object.entries(ph)) {
          const idx = Number(def.content.slice(1)) - 1;
          msg = msg.replaceAll(`$${name}$`, subs[idx] ?? "");
        }
        return msg;
      },
    },
    storage: {
      local: area(storageLocal, "local"),
      sync: area(storageSync, "sync"),
      onChanged: { addListener: (fn) => onChangedListeners.push(fn) },
    },
    tabs: { create() {}, query: () => Promise.resolve([]) },
  };
}

async function boot(search = "") {
  streamPort = null; // no port from a previous case may leak into this one
  const html = readFileSync(`${ROOT}/reader/reader.html`, "utf8");
  const dom = new JSDOM(html, {
    url: `chrome-extension://test/reader/reader.html${search}`,
    runScripts: "outside-only",
  });
  const { window } = dom;
  window.chrome = makeChrome(dom);
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.chrome = window.chrome;
  globalThis.NodeFilter = window.NodeFilter;
  globalThis.location = window.location;
  globalThis.history = window.history;
  Object.defineProperty(globalThis, "navigator", {
    value: window.navigator,
    configurable: true,
  });
  window.eval(readFileSync(`${ROOT}/lib/shared.js`, "utf8"));
  globalThis.KanaShared = window.KanaShared;

  // Fresh module instances per boot (module state must not leak between cases).
  const bust = `?v=${Math.random()}`;
  await import(`file://${ROOT}/reader/reader.js${bust}`);
  await tick(3);
  return window;
}

const tick = (n = 1) =>
  new Promise((r) => {
    let i = 0;
    const step = () => (++i >= n ? r() : setTimeout(step, 0));
    setTimeout(step, 0);
  });

// Waits past the 400ms save debounce.
const settle = () => new Promise((r) => setTimeout(r, 550));

const $ = (w, sel) => w.document.querySelector(sel);
const $$ = (w, sel) => [...w.document.querySelectorAll(sel)];
const blocks = (w) => $$(w, ".reader-block");
const textOf = (w, i) => blocks(w)[i].querySelector(".block-content").textContent;
const stateOf = (w, i) => blocks(w)[i].dataset.state;

// ---------------------------------------------------------------- case 1: home
{
  storageLocal.clear();
  const w = await boot();
  assert.equal($(w, "#sessionHome").hidden, false, "blank reader shows the recent list");
  assert.equal(blocks(w).length, 1, "blank reader has one paste target");
  assert.equal($(w, "#sessionEmpty").hidden, false, "empty-state hint is visible");
  assert.equal(storageLocal.size, 0, "an untouched blank reader writes nothing");
  console.log("✓ blank reader: paste target + empty session list, nothing persisted");
}

// ------------------------------------------- case 2: session load and rendering
let sessionId;
{
  storageLocal.clear();
  const S = await import(`file://${ROOT}/lib/reader-store.js?v=${Math.random()}`);
  const s = await S.createSession({
    title: "テスト記事",
    url: "https://example.com/a",
    blocks: [S.makeBlock("h2", "見出し"), S.makeBlock("p", "日本語の文章です。"), S.makeBlock("p", "Plain English.")],
  });
  sessionId = s.id;
  const w = await boot(`?id=${s.id}`);
  assert.equal(blocks(w).length, 3);
  assert.equal($(w, "#reader-title").textContent, "テスト記事");
  assert.equal($(w, "#sessionHome").hidden, true, "a loaded session hides the recent list");
  assert.equal($(w, "#originalLink").hidden, false, "source link is offered");
  assert.equal(blocks(w)[0].dataset.tag, "h2", "original tag is preserved");
  assert.equal(stateOf(w, 0), "idle");
  console.log("✓ session load: blocks, title, tags, original link");
}

// ------------------------------------------------- case 3: annotate + persist
{
  const w = await boot(`?id=${sessionId}`);
  $(w, "#annotateBtn").click();
  await tick();

  const sent = streamPort.sent[0];
  assert.equal(sent.type, "streamTranslate");
  assert.equal(sent.mode, "annotate");
  assert.deepEqual(sent.paragraphs, ["見出し", "日本語の文章です。"], "only Japanese blocks are sent");
  assert.equal(stateOf(w, 0), "loading");
  assert.equal(blocks(w)[0].querySelector(".block-content").contentEditable, "false",
    "a streaming block must not be editable");
  assert.equal($(w, "#cancelBtn").hidden, false, "cancel is offered while running");
  assert.equal($(w, "#annotateBtn").disabled, true);

  streamPort.emit({ type: "furigana", index: 0, tokens: [{ t: "見出", r: "みだ" }, { t: "し" }] });
  streamPort.emit({ type: "progress", done: 1, total: 2 });
  streamPort.emit({ type: "furigana", index: 1, tokens: [{ t: "日本語", r: "にほんご" }, { t: "の文章です。" }] });
  streamPort.emit({ type: "progress", done: 2, total: 2 });
  streamPort.emit({ type: "allDone" });
  await tick(2);

  assert.equal(stateOf(w, 0), "done");
  assert.ok(blocks(w)[0].querySelector("ruby"), "furigana is rendered");
  assert.equal(blocks(w)[0].querySelector("rt").textContent, "みだ");
  assert.equal($(w, "#cancelBtn").hidden, true);
  assert.equal($(w, "#annotateBtn").disabled, false, "buttons are re-enabled — runs are repeatable");
  assert.equal(streamPort.disconnected, true, "port is closed when the run ends");

  await settle(); // let the debounced save land
  const stored = storageLocal.get(`readerSession:${sessionId}`);
  assert.deepEqual(stored.blocks[0].tokens, [{ t: "見出", r: "みだ" }, { t: "し" }],
    "tokens are persisted, so a refresh costs no API call");
  console.log("✓ annotate: streaming, progress, persistence, repeatable buttons");
}

// ------------------------------------- case 4: results survive a page reload
{
  const w = await boot(`?id=${sessionId}`);
  assert.ok(blocks(w)[0].querySelector("ruby"), "furigana comes back from storage");
  assert.equal(stateOf(w, 0), "done");
  assert.equal(streamPort?.sent.length ?? 0, 0, "restoring made no network request");
  console.log("✓ reload: furigana restored from storage with no API call");
}

// ------------------------- case 5: nothing left to do / selection forces a redo
{
  const w = await boot(`?id=${sessionId}`);
  $(w, "#annotateBtn").click();
  await tick();
  assert.match($(w, "#progress").textContent, /already processed/i,
    "a second run reports there is nothing to do");

  blocks(w)[0].classList.add("block-selected");
  $(w, "#annotateBtn").click();
  await tick();
  assert.deepEqual(streamPort.sent[0].paragraphs, ["見出し"], "selection forces exactly those blocks");
  console.log("✓ skip logic: fresh blocks skipped, selection forces a redo");
}

// ------------------------------------------------------- case 6: cancel a run
{
  const w = await boot(`?id=${sessionId}`);
  $(w, "#translateBtn").click();
  await tick();
  streamPort.emit({ type: "langInfo", targetLang: "zh-CN" });
  streamPort.emit({ type: "translationChunk", index: 0, text: "标题" });
  streamPort.emit({ type: "translationDone", index: 0 });
  streamPort.emit({ type: "translationChunk", index: 1, text: "半" });
  await tick();

  $(w, "#cancelBtn").click();
  await tick();

  assert.equal($(w, "#progress").textContent, "Cancelled");
  assert.equal(stateOf(w, 0), "done", "the finished block keeps its translation");
  assert.equal(blocks(w)[0].querySelector(".reader-translation").textContent, "标题");
  assert.equal(blocks(w)[1].querySelector(".reader-translation"), null,
    "the half-streamed block drops its partial text");
  assert.equal($(w, "#annotateBtn").disabled, false);
  console.log("✓ cancel: finished work kept, partial work discarded, UI restored");
}

// --------------------------------------------- case 7: per-block error + retry
{
  const w = await boot(`?id=${sessionId}`);
  $(w, "#translateBtn").click();
  await tick();
  streamPort.emit({ type: "error", index: 0, message: "API key invalid" });
  streamPort.emit({ type: "allDone" });
  await tick();

  assert.equal(stateOf(w, 0), "error");
  const row = blocks(w)[0].querySelector(".block-status");
  assert.match(row.textContent, /API key invalid/);
  assert.ok(row.querySelector(".block-status-retry"), "an errored block offers a retry");
  assert.match($(w, "#progress").textContent, /failed/i);

  row.querySelector(".block-status-retry").click();
  await tick();
  assert.equal(streamPort.sent[0].mode, "translate", "retry repeats the mode that failed");
  assert.deepEqual(streamPort.sent[0].paragraphs, ["見出し"], "retry re-runs only that block");
  console.log("✓ error: per-block message + retry that repeats the failed mode");
}

// ------------------------------------------ case 8: service worker disconnect
{
  const w = await boot(`?id=${sessionId}`);
  $(w, "#translateBtn").click();
  await tick();
  streamPort.kill(); // Chrome recycled the service worker mid-run
  await tick();

  assert.equal(stateOf(w, 0), "error", "in-flight blocks surface the dropped connection");
  assert.match(blocks(w)[0].querySelector(".block-status").textContent, /Connection to the extension/);
  assert.equal($(w, "#annotateBtn").disabled, false, "the toolbar recovers instead of hanging");
  assert.equal($(w, "#cancelBtn").hidden, true);
  console.log("✓ disconnect: blocks error out and the toolbar recovers");
}

// -------------------------------- case 9: editing invalidates stale furigana
{
  const w = await boot(`?id=${sessionId}`);
  assert.equal(stateOf(w, 0), "done");
  const el = blocks(w)[0].querySelector(".block-content");
  el.dispatchEvent(new w.Event("beforeinput", { bubbles: true }));
  await tick();

  assert.equal(stateOf(w, 0), "stale", "edited text marks the block stale");
  assert.equal(el.querySelector("ruby"), null, "ruby is dropped — it no longer lines up");
  assert.equal(el.textContent, "見出し", "the plain text is preserved intact");

  await settle();
  const stored = storageLocal.get(`readerSession:${sessionId}`);
  assert.equal(stored.blocks[0].stale, true, "staleness persists across a reload");
  assert.ok(stored.blocks[0].tokens, "tokens are kept so the redo knows what to regenerate");
  console.log("✓ edit: ruby dropped, block marked stale, state persisted");
}

// ------------------------------------------ case 10: redo uses the right mode
// Self-contained: earlier cases leave results in a state this must not depend on.
{
  storageLocal.clear();
  const S = await import(`file://${ROOT}/lib/reader-store.js?v=${Math.random()}`);
  const both = S.makeBlock("p", "日本語です。");
  both.tokens = [{ t: "日本語", r: "にほんご" }, { t: "です。" }];
  both.translation = "是日语。";
  const furiOnly = S.makeBlock("p", "文章です。");
  furiOnly.tokens = [{ t: "文章", r: "ぶんしょう" }, { t: "です。" }];
  const transOnly = S.makeBlock("p", "翻訳のみ。");
  transOnly.translation = "仅翻译。";
  const fixture = await S.createSession({ title: "redo", blocks: [both, furiOnly, transOnly] });

  const w = await boot(`?id=${fixture.id}`);

  blocks(w)[0].querySelector(".block-reannotate").click();
  await tick();
  assert.equal(streamPort.sent[0].mode, "both", "a block with both results regenerates both");
  assert.equal(streamPort.sent[0].upgrade, true, "redo asks for the stronger model");
  assert.deepEqual(streamPort.sent[0].paragraphs, ["日本語です。"], "redo touches only its own block");

  blocks(w)[1].querySelector(".block-reannotate").click();
  await tick();
  assert.equal(streamPort.sent[0].mode, "annotate", "furigana-only block regenerates furigana only");

  blocks(w)[2].querySelector(".block-reannotate").click();
  await tick();
  assert.equal(streamPort.sent[0].mode, "translate", "translation-only block regenerates translation only");
  assert.equal(streamPort.sent[0].upgrade, false, "no furigana to upgrade");
  console.log("\u2713 redo: regenerates exactly the results the block already had");
}

// ------------------------------------------------ case 11: delete + missing id
{
  storageLocal.clear();
  const S = await import(`file://${ROOT}/lib/reader-store.js?v=${Math.random()}`);
  const fixture = await S.createSession({
    title: "del",
    blocks: [S.makeBlock("p", "一つ目。"), S.makeBlock("p", "二つ目。"), S.makeBlock("p", "三つ目。")],
  });

  const w = await boot(`?id=${fixture.id}`);
  blocks(w)[1].querySelector(".block-delete").click();
  await settle();
  assert.equal(blocks(w).length, 2);
  const stored = storageLocal.get(`readerSession:${fixture.id}`);
  assert.deepEqual(stored.blocks.map((b) => b.text), ["一つ目。", "三つ目。"],
    "deletion is persisted and order is preserved");

  const w2 = await boot("?id=doesnotexist");
  assert.equal($(w2, "#sessionHome").hidden, false, "an unknown id falls back to the home view");
  assert.match($(w2, "#progress").textContent, /no longer exists/i);
  assert.ok((await S.listSessions()).some((x) => x.id === fixture.id),
    "a bogus id must not disturb real sessions");
  console.log("\u2713 delete persists; unknown session id degrades to the home view");
}

console.log("\nreader: all assertions passed");
