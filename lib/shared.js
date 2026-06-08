// lib/shared.js — DOM-side helpers shared across the content script and the
// extension's HTML pages (reader / vocabulary / history).
//
// Loaded as a CLASSIC (non-module) script so it can be used by content/content.js,
// which is an IIFE and cannot use ES module imports. It exposes a single global
// `globalThis.KanaShared`. Module-context pages include it via a plain <script>
// tag before their <script type="module"> and read the same global.
//
// NOTE: lib/api.js keeps its own string-based escapeHtml/tokensToHtml — the
// service worker has no DOM, so those cannot use document.createElement. This
// file serves only DOM-bearing environments.

(function () {
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function tokensToHtml(tokens) {
    return tokens
      .map((tok) => {
        if (tok.r) {
          return `<ruby>${escapeHtml(tok.t)}<rt>${escapeHtml(tok.r)}</rt></ruby>`;
        }
        return escapeHtml(tok.t);
      })
      .join("");
  }

  function formatDate(ts) {
    const d = new Date(ts);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hour = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${year}/${month}/${day} ${hour}:${min}`;
  }

  function formatShortDate(ts) {
    const d = new Date(ts);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  // Extract the selected word (ruby stripped) and its reading (ruby readings kept).
  function extractFromSelection(range) {
    const fragment = range.cloneContents();

    const wordClone = fragment.cloneNode(true);
    wordClone.querySelectorAll("rt, rp").forEach((n) => n.remove());
    const word = wordClone.textContent.trim();

    const readingClone = fragment.cloneNode(true);
    readingClone.querySelectorAll("ruby").forEach((ruby) => {
      const rt = ruby.querySelector("rt");
      if (rt) ruby.replaceWith(rt.textContent);
    });
    // Also strip leftover rp/rt from partial ruby selections
    readingClone.querySelectorAll("rt, rp").forEach((n) => n.remove());
    const reading = readingClone.textContent.trim();

    return { word, reading };
  }

  function getWordFromRuby(ruby) {
    const clone = ruby.cloneNode(true);
    clone.querySelectorAll("rt, rp").forEach((n) => n.remove());
    return clone.textContent.trim();
  }

  function extractSentence(fullText, word) {
    const sentences = fullText.split(/(?<=。)/);
    const match = sentences.find((s) => s.includes(word));
    return match ? match.trim() : fullText;
  }

  globalThis.KanaShared = {
    escapeHtml,
    tokensToHtml,
    formatDate,
    formatShortDate,
    extractFromSelection,
    getWordFromRuby,
    extractSentence,
  };
})();
