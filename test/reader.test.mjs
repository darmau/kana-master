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
    url: `https://reader.test/reader/reader.html${search}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.chrome = makeChrome(dom);
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.chrome = window.chrome;
  globalThis.NodeFilter = window.NodeFilter;
  globalThis.localStorage = window.localStorage;
  globalThis.location = window.location;
  globalThis.history = window.history;
  Object.defineProperty(globalThis, "navigator", {
    value: window.navigator,
    configurable: true,
  });
  window.eval(readFileSync(`${ROOT}/reader/prefs-boot.js`, "utf8"));
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
const getSelected = (w) => $$(w, ".reader-block.block-selected");
const textOf = (w, i) => blocks(w)[i].querySelector(".block-content").textContent;
const stateOf = (w, i) => blocks(w)[i].dataset.state;

// Open a block's 読 menu and return the item for `action`.
function menuAction(w, i, action) {
  const block = blocks(w)[i];
  block.querySelector(".block-handle-btn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  const item = block.querySelector(`.block-menu-item[data-action="${action}"]`);
  assert.ok(item, `block ${i} should offer the "${action}" action`);
  return item;
}

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

  // A click toggles the checkbox as part of activation, exactly as in a browser.
  blocks(w)[0]
    .querySelector(".block-select-input")
    .dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  assert.equal(getSelected(w).length, 1, "ticking the gutter checkbox selects the block");
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

  // Furigana on an already-annotated block re-runs it against the stronger model.
  menuAction(w, 0, "annotate").click();
  await tick();
  assert.equal(streamPort.sent[0].mode, "annotate");
  assert.equal(streamPort.sent[0].upgrade, true, "re-annotating asks for the stronger model");
  assert.deepEqual(streamPort.sent[0].paragraphs, ["日本語です。"], "acts on its own block only");

  menuAction(w, 2, "translate").click();
  await tick();
  assert.equal(streamPort.sent[0].mode, "translate");
  assert.equal(streamPort.sent[0].upgrade, false, "no furigana to upgrade");
  console.log("\u2713 block menu: each action runs on its own block with the right mode");
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

// ------------------------------------------- case 12: grammar is its own result
{
  storageLocal.clear();
  const S = await import(`file://${ROOT}/lib/reader-store.js?v=${Math.random()}`);
  const fixture = await S.createSession({
    title: "grammar",
    blocks: [S.makeBlock("p", "日本語を勉強しています。")],
  });
  const w = await boot(`?id=${fixture.id}`);

  menuAction(w, 0, "grammar").click();
  await tick();
  assert.equal(streamPort.sent[0].mode, "grammar");

  streamPort.emit({ type: "langInfo", targetLang: "zh-CN" });
  streamPort.emit({ type: "grammarChunk", index: 0, text: "## 结构\n- **て形**" });
  await tick();
  const grammar = blocks(w)[0].querySelector(".reader-grammar");
  assert.ok(grammar, "grammar renders into its own block-scoped div");
  assert.ok(grammar.querySelector("h5"), "markdown headings are rendered while streaming");
  assert.ok(grammar.querySelector("strong"));
  assert.equal(grammar.lang, "zh-CN", "grammar is tagged with the target language");

  streamPort.emit({ type: "grammarDone", index: 0 });
  streamPort.emit({ type: "allDone" });
  await settle();
  assert.equal(stateOf(w, 0), "done");
  assert.match(storageLocal.get(`readerSession:${fixture.id}`).blocks[0].grammar, /て形/,
    "grammar is persisted as its raw markdown");

  const w2 = await boot(`?id=${fixture.id}`);
  assert.ok(blocks(w2)[0].querySelector(".reader-grammar strong"), "grammar is restored on reload");
  console.log("\u2713 grammar: streams into the block, persists, restores");
}

// ------------------------------- case 13: non-Japanese blocks and menu contents
{
  storageLocal.clear();
  const S = await import(`file://${ROOT}/lib/reader-store.js?v=${Math.random()}`);
  const fixture = await S.createSession({
    title: "mixed",
    blocks: [S.makeBlock("p", "日本語の段落。"), S.makeBlock("p", "An English paragraph.")],
  });
  const w = await boot(`?id=${fixture.id}`);

  const jpMenu = () => {
    blocks(w)[0].querySelector(".block-handle-btn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    return [...blocks(w)[0].querySelectorAll(".block-menu-item")].map((b) => b.dataset.action);
  };
  const enMenu = () => {
    blocks(w)[1].querySelector(".block-handle-btn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
    return [...blocks(w)[1].querySelectorAll(".block-menu-item")].map((b) => b.dataset.action);
  };
  assert.deepEqual(jpMenu(), ["annotate", "translate", "grammar", "tts"]);
  assert.deepEqual(enMenu(), ["translate", "tts"], "furigana and grammar are Japanese-only");

  // Translating everything must ask the worker for translateAny on the Latin block.
  $(w, "#translateBtn").click();
  await tick();
  assert.deepEqual(streamPort.sent[0].modes, ["translate", "translateAny"],
    "non-Japanese paragraphs get the any-language translation prompt");

  // Furigana skips the non-Japanese block entirely.
  streamPort.emit({ type: "translationDone", index: 0 });
  streamPort.emit({ type: "translationDone", index: 1 });
  streamPort.emit({ type: "allDone" });
  await tick();
  $(w, "#annotateBtn").click();
  await tick();
  assert.deepEqual(streamPort.sent[0].paragraphs, ["日本語の段落。"]);
  console.log("\u2713 language routing: menu contents, translateAny, furigana skips Latin text");
}

// --------------------------------------------------- case 14: Escape unwinding
{
  storageLocal.clear();
  const S = await import(`file://${ROOT}/lib/reader-store.js?v=${Math.random()}`);
  const fixture = await S.createSession({ title: "esc", blocks: [S.makeBlock("p", "日本語。")] });
  const w = await boot(`?id=${fixture.id}`);

  blocks(w)[0].querySelector(".block-select-input").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  blocks(w)[0].querySelector(".block-handle-btn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  assert.ok(blocks(w)[0].querySelector(".block-menu"), "menu is open");

  const esc = () => w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  esc();
  assert.equal(blocks(w)[0].querySelector(".block-menu"), null, "first Escape closes the menu");
  assert.equal(getSelected(w).length, 1, "...and leaves the selection alone");
  esc();
  assert.equal(getSelected(w).length, 0, "second Escape clears the selection");
  console.log("\u2713 Escape unwinds one layer at a time");
}

// --------------------------- case 15: a run that ends without reporting a block
{
  storageLocal.clear();
  const S = await import(`file://${ROOT}/lib/reader-store.js?v=${Math.random()}`);
  const fixture = await S.createSession({
    title: "straggler",
    blocks: [S.makeBlock("p", "一つ目の文。"), S.makeBlock("p", "二つ目の文。")],
  });
  const w = await boot(`?id=${fixture.id}`);

  $(w, "#annotateBtn").click();
  await tick();
  streamPort.emit({ type: "furigana", index: 0, tokens: [{ t: "一つ目の文。" }] });
  streamPort.emit({ type: "allDone" }); // index 1 never reported
  await tick();

  assert.equal(stateOf(w, 1), "error", "an unreported block must not stay stuck loading");
  assert.equal(blocks(w)[1].querySelector(".block-content").contentEditable, "plaintext-only",
    "...and must become editable again");
  assert.ok(blocks(w)[1].querySelector(".block-status-retry"), "...with a way to retry");
  assert.equal($(w, "#annotateBtn").disabled, false);
  console.log("\u2713 straggler: a block the run never reported is released, not stuck");
}

// ------------------------------------------------- case 16: editing the blocks
{
  storageLocal.clear();
  const S = await import(`file://${ROOT}/lib/reader-store.js?v=${Math.random()}`);
  const annotated = S.makeBlock("p", "日本語の文章です。");
  annotated.tokens = [{ t: "日本語", r: "にほんご" }, { t: "の文章です。" }];
  const fixture = await S.createSession({
    title: "edit",
    blocks: [annotated, S.makeBlock("p", "二つ目の段落。")],
  });
  const w = await boot(`?id=${fixture.id}`);

  // Put the caret at a plain-text offset inside the block and press a key.
  const caretAt = (i, offset) => {
    const el = blocks(w)[i].querySelector(".block-content");
    el.focus();
    const walker = w.document.createTreeWalker(el, w.NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement.closest("rt, rp") ? w.NodeFilter.FILTER_REJECT : w.NodeFilter.FILTER_ACCEPT,
    });
    let node, remaining = offset, last = null;
    while ((node = walker.nextNode())) {
      last = node;
      if (remaining <= node.length) break;
      remaining -= node.length;
    }
    const range = w.document.createRange();
    range.setStart(node || last, node ? remaining : last.length);
    range.collapse(true);
    const sel = w.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return el;
  };
  const press = (el, key, init = {}) =>
    el.dispatchEvent(new w.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));

  // Enter mid-paragraph splits it in two.
  press(caretAt(0, 3), "Enter");
  await tick();
  assert.equal(blocks(w).length, 3, "Enter splits the block");
  assert.equal(textOf(w, 0), "日本語");
  assert.equal(textOf(w, 1), "の文章です。");
  assert.equal(stateOf(w, 0), "stale", "the edited half keeps its results but is marked stale");
  assert.equal(stateOf(w, 1), "idle", "the new half starts clean");
  assert.equal(blocks(w)[0].querySelector("ruby"), null, "ruby no longer matches, so it is dropped");

  // Backspace at the start of a block merges it back into the previous one.
  press(caretAt(1, 0), "Backspace");
  await tick();
  assert.equal(blocks(w).length, 2, "Backspace at offset 0 merges");
  assert.equal(textOf(w, 0), "日本語の文章です。", "the text is rejoined exactly");

  // Delete at the end pulls the next block up.
  press(caretAt(0, textOf(w, 0).length), "Delete");
  await tick();
  assert.equal(blocks(w).length, 1);
  assert.equal(textOf(w, 0), "日本語の文章です。二つ目の段落。");

  // Shift+Enter is deliberately inert (a <br> could not round-trip).
  const before = blocks(w).length;
  press(caretAt(0, 2), "Enter", { shiftKey: true });
  await tick();
  assert.equal(blocks(w).length, before, "Shift+Enter does not split");

  await settle();
  assert.deepEqual(
    storageLocal.get(`readerSession:${fixture.id}`).blocks.map((b) => b.text),
    ["日本語の文章です。二つ目の段落。"],
    "splits and merges are persisted"
  );
  console.log("\u2713 editing: Enter splits, Backspace/Delete merge, Shift+Enter inert");
}

// -------------------------------------------- case 17: paste and add-paragraph
{
  storageLocal.clear();
  const w = await boot();
  const el = blocks(w)[0].querySelector(".block-content");
  el.focus();

  const paste = (target, text) => {
    const ev = new w.Event("paste", { bubbles: true, cancelable: true });
    ev.clipboardData = { getData: () => text };
    target.dispatchEvent(ev);
  };

  paste(el, "  一行目。 \n\n 二行目。\r\n三行目。 ");
  await tick();
  assert.deepEqual(
    blocks(w).map((b) => b.querySelector(".block-content").textContent),
    ["一行目。", "二行目。", "三行目。"],
    "a multi-line paste becomes one block per line, trimmed"
  );

  // Rich HTML never reaches the document: only text/plain is read.
  paste(blocks(w)[0].querySelector(".block-content"), "<b>bold</b>");
  await tick();
  assert.equal(blocks(w)[0].querySelector("b"), null, "pasted markup stays inert text");

  const count = blocks(w).length;
  $(w, "#addBlockBtn").click();
  await tick();
  assert.equal(blocks(w).length, count + 1, "add-paragraph appends an empty block");

  await settle();
  const newId = new w.URL(w.location.href).searchParams.get("id");
  assert.ok(newId, "the blank reader adopts a session id once it has content");
  assert.equal($(w, "#sessionHome").hidden, true, "the recent list steps aside");
  assert.deepEqual(
    storageLocal.get(`readerSession:${newId}`).blocks.map((b) => b.text).slice(0, 3),
    ["<b>bold</b>一行目。", "二行目。", "三行目。"],
    "pasting into the blank reader lazily creates a persisted session"
  );
  console.log("\u2713 paste: plain text, split by line; add-paragraph works");
}

// ----------------------------------------------------- case 18: study toggles
{
  storageLocal.clear();
  storageSync.set("readerHideFurigana", true);
  const S = await import(`file://${ROOT}/lib/reader-store.js?v=${Math.random()}`);
  const block = S.makeBlock("p", "日本語です。");
  block.tokens = [{ t: "日本語", r: "にほんご" }, { t: "です。" }];
  block.translation = "是日语。";
  const fixture = await S.createSession({ title: "study", blocks: [block] });

  const w = await boot(`?id=${fixture.id}`);
  const body = $(w, "#reader-body");
  assert.equal(body.classList.contains("hide-furigana"), true,
    "a saved preference applies on load");
  assert.equal($(w, "#hideFuriganaToggle").checked, true, "...and the switch reflects it");

  const toggle = $(w, "#hideTranslationToggle");
  toggle.checked = true;
  toggle.dispatchEvent(new w.Event("change", { bubbles: true }));
  await tick();
  assert.equal(body.classList.contains("hide-translation"), true);
  assert.equal(storageSync.get("readerHideTranslation"), true, "the choice is persisted");

  // A blurred result reveals individually on click.
  const translation = blocks(w)[0].querySelector(".reader-translation");
  translation.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  assert.equal(translation.classList.contains("revealed"), true);

  // Flipping a switch re-hides everything that had been revealed.
  toggle.checked = false;
  toggle.dispatchEvent(new w.Event("change", { bubbles: true }));
  await tick();
  assert.equal(translation.classList.contains("revealed"), false,
    "toggling clears previously revealed results");

  storageSync.set("readerHideFurigana", false);
  console.log("\u2713 study toggles: load, persist, reveal one, reset on toggle");
}

// ---------------------------------------- case 19: Japanese vs Chinese kanji
{
  storageLocal.clear();
  const S = await import(`file://${ROOT}/lib/reader-store.js?v=${Math.random()}`);
  const chinese = await S.createSession({
    title: "chinese",
    blocks: [S.makeBlock("p", "这是一段中文，完全没有假名。"), S.makeBlock("p", "另一段中文内容。")],
  });
  const w = await boot(`?id=${chinese.id}`);

  $(w, "#annotateBtn").click();
  await tick();
  assert.equal(streamPort, null, "pure Chinese is never sent for furigana");
  assert.match($(w, "#progress").textContent, /no japanese/i);

  blocks(w)[0].querySelector(".block-handle-btn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  assert.deepEqual(
    [...blocks(w)[0].querySelectorAll(".block-menu-item")].map((b) => b.dataset.action),
    ["translate", "tts"],
    "and offers no furigana or grammar action"
  );

  // In a document that does have kana, a kanji-only heading counts as Japanese.
  const japanese = await S.createSession({
    title: "japanese",
    blocks: [S.makeBlock("h2", "経済対策"), S.makeBlock("p", "日本語の文章です。")],
  });
  const w2 = await boot(`?id=${japanese.id}`);
  $(w2, "#annotateBtn").click();
  await tick();
  assert.deepEqual(streamPort.sent[0].paragraphs, ["経済対策", "日本語の文章です。"],
    "a kanji-only heading is annotated inside a Japanese document");
  console.log("\u2713 detector: kanji alone follows the document's language");
}

// ----------------------------------------------------- case 20: quiz scoping
{
  storageLocal.clear();
  const S = await import(`file://${ROOT}/lib/reader-store.js?v=${Math.random()}`);
  // Long enough that the 4000-char budget cannot cover every paragraph.
  const long = Array.from({ length: 8 }, (_, i) =>
    S.makeBlock("p", `第${i}段。` + "本文".repeat(400))
  );
  const fixture = await S.createSession({ title: "quiz", blocks: long });
  const w = await boot(`?id=${fixture.id}`);

  $(w, "#quizBtn").click();
  await tick();
  const note = $(w, "#quizScopeNote");
  assert.equal(note.hidden, false, "a truncated quiz says so");
  assert.match(note.textContent, /first \d+ of 8/i);
  const marked = $$(w, ".reader-block.quiz-scope").length;
  assert.ok(marked > 0 && marked < 8, "and marks exactly the paragraphs it used");
  assert.match(note.textContent, new RegExp(`first ${marked} of 8`, "i"),
    "the note and the marked blocks agree");

  $(w, "#quizCloseBtn").click();
  await tick();
  assert.equal($$(w, ".reader-block.quiz-scope").length, 0, "closing clears the marks");

  // With a selection, the quiz covers exactly that selection.
  for (const i of [1, 2]) {
    blocks(w)[i].querySelector(".block-select-input")
      .dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  }
  $(w, "#quizBtn").click();
  await tick();
  assert.match($(w, "#quizScopeNote").textContent, /2 selected paragraphs/i);
  console.log("\u2713 quiz: reports its coverage and marks the paragraphs used");
}

// ------------------------------------------------ case 21: reading preferences
{
  storageLocal.clear();
  storageSync.set("readerTheme", "dark");
  storageSync.set("readerFontSize", "xl");
  const S = await import(`file://${ROOT}/lib/reader-store.js?v=${Math.random()}`);
  const fixture = await S.createSession({ title: "prefs", blocks: [S.makeBlock("p", "日本語。")] });

  const w = await boot(`?id=${fixture.id}`);
  const root = w.document.documentElement;
  assert.equal(root.dataset.theme, "dark", "a saved theme is applied");
  assert.equal(root.dataset.font, "xl", "as is a saved type size");

  const popover = $(w, "#prefsPopover");
  assert.equal(popover.hidden, true, "the popover starts closed");
  $(w, "#prefsBtn").dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  assert.equal(popover.hidden, false);
  assert.equal(
    popover.querySelector('[data-pref="readerTheme"] [data-v="dark"]').getAttribute("aria-pressed"),
    "true",
    "the current value is marked pressed"
  );

  popover
    .querySelector('[data-pref="readerTheme"] [data-v="sepia"]')
    .dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
  await tick();
  assert.equal(root.dataset.theme, "sepia", "choosing a theme applies it immediately");
  assert.equal(storageSync.get("readerTheme"), "sepia", "and persists it");

  // The mirror is what lets prefs-boot.js avoid a flash of the default theme.
  assert.equal(JSON.parse(w.localStorage.getItem("readerPrefs")).readerTheme, "sepia",
    "preferences are mirrored for the pre-paint boot script");

  w.document.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(popover.hidden, true, "Escape closes the popover");

  storageSync.delete("readerTheme");
  storageSync.delete("readerFontSize");
  console.log("\u2713 preferences: applied on load, persisted, mirrored, Escape closes");
}

console.log("\nreader: all assertions passed");
