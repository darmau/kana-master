// Exercises the content script's article extraction by loading it in jsdom and
// driving it through the same "extractContent" message the popup sends.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

// Load the content script against a page and return whatever extractContent
// reports for it.
function extractFrom(bodyHtml, { head = "", lang = "ja" } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html lang="${lang}"><head>${head}</head><body>${bodyHtml}</body></html>`,
    { url: "https://example.com/article", runScripts: "outside-only", pretendToBeVisual: true }
  );
  const { window } = dom;

  const listeners = [];
  window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      onConnect: { addListener: () => {} },
      connect: () => ({
        postMessage() {},
        disconnect() {},
        onMessage: { addListener: () => {} },
        onDisconnect: { addListener: () => {} },
      }),
      sendMessage: async () => ({}),
    },
    i18n: { getMessage: (k) => k, getUILanguage: () => "en" },
    storage: {
      sync: { get: (_k, cb) => cb({}) },
      local: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener: () => {} },
    },
  };

  // jsdom has no layout, so innerText is undefined; approximate it the way a
  // browser would for the cases this suite cares about (<br> becomes a newline).
  Object.defineProperty(window.HTMLElement.prototype, "innerText", {
    get() {
      return this.innerHTML
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&");
    },
    configurable: true,
  });

  window.eval(readFileSync(`${ROOT}/lib/shared.js`, "utf8"));
  window.eval(readFileSync(`${ROOT}/content/content.js`, "utf8"));

  let result;
  for (const fn of listeners) fn({ type: "extractContent" }, {}, (r) => (result = r));
  return result;
}

// --- Picks the article, not merely the first one ---------------------------
{
  const body = `
    <article id="teaser"><p>短い予告。</p></article>
    <article id="main">
      <h1>本当の記事</h1>
      ${"<p>これは十分に長い本文の段落です。</p>".repeat(6)}
    </article>
    <article id="comments">${"<p>コメント。</p>".repeat(3)}</article>`;
  const { title, content } = extractFrom(body);
  assert.equal(title, "本当の記事");
  assert.ok(
    content.some((b) => b.text.includes("十分に長い本文")),
    "the longest article wins, not the first in the DOM"
  );
  assert.ok(!content.some((b) => b.text === "短い予告。"), "the teaser article is left out");
  console.log("✓ picks the article with the most body text");
}

// --- Nested blocks are emitted once ---------------------------------------
{
  const body = `
    <article>
      <h1>リスト記事</h1>
      <ul>
        <li><p>一つ目の項目です。</p></li>
        <li>二つ目の項目です。</li>
        <li>前置き<ul><li>入れ子の項目です。</li></ul></li>
      </ul>
      ${"<p>本文をもう少し足しておきます。</p>".repeat(5)}
    </article>`;
  const { content } = extractFrom(body);
  const texts = content.map((b) => b.text);
  const once = (needle) => texts.filter((t) => t === needle).length;

  assert.equal(once("一つ目の項目です。"), 1, "li > p must not yield the text twice");
  assert.equal(once("二つ目の項目です。"), 1);
  assert.ok(texts.includes("前置き"), "a container keeps its own text");
  assert.ok(texts.includes("入れ子の項目です。"), "and its nested item still appears");
  console.log("✓ li > p is emitted once; nested lists keep both levels");
}

// --- <br> survives as a line break ----------------------------------------
{
  const body = `
    <article>
      <h1>歌詞</h1>
      <p>一行目<br>二行目<br>三行目</p>
      ${"<p>ほかの段落も入れておきます。</p>".repeat(5)}
    </article>`;
  const { content } = extractFrom(body);
  const lyrics = content.find((b) => b.text.startsWith("一行目"));
  assert.ok(lyrics, "the lyric paragraph is extracted");
  assert.equal(lyrics.text, "一行目\n二行目\n三行目", "<br> becomes a newline, not a join");
  console.log("✓ <br> is preserved as a line break");
}

// --- Title loses the site suffix and is not repeated in the body ----------
{
  const body = `<article>${"<p>本文の段落です。</p>".repeat(6)}</article>`;
  const head = `
    <title>記事タイトル | サイト名</title>
    <meta property="og:site_name" content="サイト名">`;
  const { title, content } = extractFrom(body, { head });
  assert.equal(title, "記事タイトル", "the site name is stripped from document.title");
  assert.ok(!content.some((b) => b.text === title), "and the title is not repeated as a block");
  console.log("✓ title: site suffix stripped, no duplicate heading block");
}

// --- Page chrome is excluded ----------------------------------------------
{
  const body = `
    <nav><p>ナビゲーションのリンクです。</p></nav>
    <article><h1>記事</h1>${"<p>本文の段落です。</p>".repeat(6)}</article>
    <footer><p>フッターの文章です。</p></footer>`;
  const { content } = extractFrom(body);
  const texts = content.map((b) => b.text);
  assert.ok(!texts.some((t) => t.includes("ナビゲーション")));
  assert.ok(!texts.some((t) => t.includes("フッター")));
  console.log("✓ nav and footer are excluded");
}

console.log("\ncontent extraction: all assertions passed");
