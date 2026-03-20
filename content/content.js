(() => {
  const JP_REGEX = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/;
  const TARGETS = "p, li, td, th, blockquote, h1, h2, h3, h4, h5, h6, figcaption, span, div";
  let annotateMode = false;
  let highlightedEl = null;

  function hasJapanese(text) {
    return JP_REGEX.test(text);
  }

  function isLeafTextElement(el) {
    const dominated = el.querySelectorAll(TARGETS);
    return dominated.length === 0 || el.textContent.length < 200;
  }

  // --- Annotate mode: hold Alt to activate, hover to highlight, click to annotate ---

  document.addEventListener("keydown", (e) => {
    if (e.key === "Alt" && !annotateMode) {
      annotateMode = true;
      document.body.classList.add("kana-master-mode");
    }
  });

  document.addEventListener("keyup", (e) => {
    if (e.key === "Alt") {
      annotateMode = false;
      document.body.classList.remove("kana-master-mode");
      clearHighlight();
    }
  });

  // Also exit on blur (e.g. user switches window while holding Alt)
  window.addEventListener("blur", () => {
    if (annotateMode) {
      annotateMode = false;
      document.body.classList.remove("kana-master-mode");
      clearHighlight();
    }
  });

  document.addEventListener("mouseover", (e) => {
    if (!annotateMode) return;

    const el = e.target.closest?.(TARGETS);
    if (!el || el.dataset.kanaAnnotated || !hasJapanese(el.textContent)) {
      clearHighlight();
      return;
    }
    if (!isLeafTextElement(el)) {
      clearHighlight();
      return;
    }

    if (el !== highlightedEl) {
      clearHighlight();
      highlightedEl = el;
      el.classList.add("kana-master-highlight");
    }
  }, true);

  document.addEventListener("click", (e) => {
    if (!annotateMode || !highlightedEl) return;

    e.preventDefault();
    e.stopPropagation();

    const target = highlightedEl;
    clearHighlight();
    annotateElement(target);
  }, true);

  function clearHighlight() {
    if (highlightedEl) {
      highlightedEl.classList.remove("kana-master-highlight");
      highlightedEl = null;
    }
  }

  // --- Core annotation logic ---

  function tokensToHtml(tokens) {
    return tokens
      .map((tok) => {
        if (tok.r) {
          return `<ruby>${escapeHtml(tok.t)}<rp>(</rp><rt>${escapeHtml(tok.r)}</rt><rp>)</rp></ruby>`;
        }
        return escapeHtml(tok.t);
      })
      .join("");
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  async function annotateElement(el) {
    if (el.dataset.kanaAnnotated) return;

    const text = el.textContent;
    el.classList.add("kana-master-loading");

    // Create translation div upfront for streaming
    const transDiv = document.createElement("div");
    transDiv.className = "kana-master-translation";
    transDiv.lang = "zh-CN";
    el.after(transDiv);

    const port = chrome.runtime.connect({ name: "kana-stream" });

    port.onMessage.addListener((msg) => {
      if (msg.type === "furigana") {
        el.classList.remove("kana-master-loading");
        if (msg.tokens && msg.tokens.length > 0) {
          el.innerHTML = tokensToHtml(msg.tokens);
          el.classList.add("kana-master-annotated");
          el.dataset.kanaAnnotated = "true";
        }
      }

      if (msg.type === "translationChunk") {
        transDiv.textContent += msg.text;
      }

      if (msg.type === "translation") {
        transDiv.textContent = msg.text;
      }

      if (msg.type === "allDone") {
        el.classList.remove("kana-master-loading");
        if (!transDiv.textContent) transDiv.remove();
        addPlayButton(el, text);
        port.disconnect();
      }

      if (msg.type === "error") {
        el.classList.remove("kana-master-loading");
        transDiv.remove();
        showError(el, msg.message);
        port.disconnect();
      }
    });

    port.postMessage({ type: "streamTranslate", paragraphs: [text] });
  }

  function addPlayButton(sourceEl, originalText) {
    const btn = document.createElement("button");
    btn.className = "kana-master-play";
    btn.textContent = "\u25B6";
    btn.title = "\u670D\u8AAD";
    sourceEl.after(btn);

    let audio = null;
    let playing = false;

    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      e.preventDefault();

      if (playing && audio) {
        audio.pause();
        audio.currentTime = 0;
        btn.textContent = "\u25B6";
        playing = false;
        return;
      }

      btn.textContent = "\u23F3";
      btn.disabled = true;

      try {
        const response = await chrome.runtime.sendMessage({ type: "tts", text: originalText });
        if (response.error) throw new Error(response.error);

        audio = new Audio(response.audioDataUrl);
        audio.play();
        btn.textContent = "\u25A0";
        btn.disabled = false;
        playing = true;

        audio.addEventListener("ended", () => {
          btn.textContent = "\u25B6";
          playing = false;
        });
      } catch (err) {
        btn.textContent = "\u25B6";
        btn.disabled = false;
        console.error("Kana Master TTS error:", err);
      }
    });
  }

  function showError(el, message) {
    const errDiv = document.createElement("div");
    errDiv.className = "kana-master-error";
    errDiv.textContent = `Kana Master: ${message}`;
    el.after(errDiv);
    setTimeout(() => errDiv.remove(), 5000);
  }

  // --- Bulk annotation ---

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "bulkTranslate") {
      bulkTranslate().then(sendResponse).catch((err) =>
        sendResponse({ error: err.message })
      );
      return true;
    }
    if (message.type === "extractContent") {
      sendResponse(extractContent());
      return false;
    }
  });

  async function bulkTranslate() {
    const container = findMainContent();
    if (!container) return { error: "Could not find main content area" };

    const elements = Array.from(
      container.querySelectorAll(TARGETS)
    ).filter(
      (el) =>
        !el.dataset.kanaAnnotated &&
        hasJapanese(el.textContent) &&
        isLeafTextElement(el) &&
        el.textContent.trim().length > 0
    );

    if (elements.length === 0) return { done: true, count: 0 };

    const texts = elements.map((el) => el.textContent);

    try {
      const response = await chrome.runtime.sendMessage({
        type: "bulkAnnotate",
        paragraphs: texts,
      });

      if (response.error) return { error: response.error };

      const results = response.results || [];
      results.forEach((result, i) => {
        if (i >= elements.length) return;
        const el = elements[i];

        if (result.furigana && result.furigana.length > 0) {
          el.innerHTML = tokensToHtml(result.furigana);
          el.classList.add("kana-master-annotated");
          el.dataset.kanaAnnotated = "true";
        }

        if (result.translation) {
          const transDiv = document.createElement("div");
          transDiv.className = "kana-master-translation";
          transDiv.lang = "zh-CN";
          transDiv.textContent = result.translation;
          el.after(transDiv);
        }
      });

      return { done: true, count: results.length };
    } catch (err) {
      return { error: err.message };
    }
  }

  function extractContent() {
    const container = findMainContent();
    if (!container) return { error: "Could not find main content area" };

    const title = document.title || "";
    const url = location.href;
    const content = [];

    // Allowed tags for extraction
    const EXTRACT_TAGS = new Set([
      "P", "H1", "H2", "H3", "H4", "H5", "H6",
      "LI", "BLOCKQUOTE", "FIGCAPTION", "PRE"
    ]);

    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          // Skip scripts, styles, nav, etc.
          const skip = new Set(["SCRIPT", "STYLE", "NAV", "FOOTER", "ASIDE", "NOSCRIPT"]);
          if (skip.has(node.tagName)) return NodeFilter.FILTER_REJECT;
          if (EXTRACT_TAGS.has(node.tagName)) return NodeFilter.FILTER_ACCEPT;
          return NodeFilter.FILTER_SKIP;
        }
      }
    );

    const seen = new Set();
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (!text || text.length < 2) continue;
      // Deduplicate (nested elements can repeat text)
      if (seen.has(text)) continue;
      seen.add(text);
      const tag = node.tagName.toLowerCase();
      content.push({ tag, text });
    }

    return { title, url, content };
  }

  function findMainContent() {
    const selectors = [
      "article",
      "main",
      '[role="main"]',
      "#content",
      ".article-body",
      ".post-content",
      ".entry-content",
      ".article-content",
      ".post-body",
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }

    let best = document.body;
    let bestScore = 0;

    document.querySelectorAll("div, section").forEach((el) => {
      const text = el.textContent || "";
      const childCount = el.children.length;
      if (childCount === 0) return;
      const density = text.length / childCount;
      if (density > bestScore && text.length > 200) {
        bestScore = density;
        best = el;
      }
    });

    return best;
  }
})();
