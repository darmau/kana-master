(() => {
  const JP_REGEX = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/;
  const TARGETS = "p, li, td, th, blockquote, h1, h2, h3, h4, h5, h6, figcaption, span, div";
  let annotateMode = false;
  let highlightedEl = null;

  function hasJapanese(text) {
    return JP_REGEX.test(text);
  }

  const BLOCK_TARGETS = "p, li, td, th, blockquote, h1, h2, h3, h4, h5, h6, figcaption";

  function isLeafTextElement(el) {
    const dominated = el.querySelectorAll(BLOCK_TARGETS);
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

    // Don't clear highlight when hovering over the action bar
    if (e.target.closest?.(".kana-master-actions")) return;

    const el = e.target.closest?.(TARGETS);
    if (!el || !hasJapanese(el.textContent)) {
      clearHighlight();
      return;
    }
    // Skip if all actions already done
    if (el.dataset.kanaAnnotated && el.dataset.kanaTranslated && el.dataset.kanaGrammar) {
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
      showActionBar(el);
    }
  }, true);

  document.addEventListener("click", (e) => {
    if (!annotateMode || !highlightedEl) return;

    // Let action bar buttons handle themselves
    if (e.target.closest?.(".kana-master-actions")) return;

    e.preventDefault();
    e.stopPropagation();
  }, true);

  function showActionBar(el) {
    removeActionBar();
    if (!el.style.position || el.style.position === "static") {
      el.style.position = "relative";
      el.dataset.kanaPositionSet = "true";
    }

    const bar = document.createElement("div");
    bar.className = "kana-master-actions";

    const btnAnnotate = document.createElement("button");
    btnAnnotate.textContent = "振";
    btnAnnotate.title = "注音";
    if (el.dataset.kanaAnnotated) btnAnnotate.disabled = true;
    btnAnnotate.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = highlightedEl;
      clearHighlight();
      annotateElement(target, "annotate");
    });

    const btnTranslate = document.createElement("button");
    btnTranslate.textContent = "訳";
    btnTranslate.title = "翻訳";
    if (el.dataset.kanaTranslated) btnTranslate.disabled = true;
    btnTranslate.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = highlightedEl;
      clearHighlight();
      annotateElement(target, "translate");
    });

    const btnGrammar = document.createElement("button");
    btnGrammar.textContent = "文";
    btnGrammar.title = "文法分析";
    btnGrammar.className = "kana-master-actions-grammar";
    if (el.dataset.kanaGrammar) btnGrammar.disabled = true;
    btnGrammar.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = highlightedEl;
      clearHighlight();
      annotateElement(target, "grammar");
    });

    const btnTts = document.createElement("button");
    btnTts.textContent = "▶";
    btnTts.title = "朗読";
    btnTts.className = "kana-master-actions-tts";
    btnTts.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = highlightedEl;
      const text = getTextWithoutRuby(target);
      clearHighlight();
      playTts(target, text);
    });

    bar.appendChild(btnAnnotate);
    bar.appendChild(btnTranslate);
    bar.appendChild(btnGrammar);
    bar.appendChild(btnTts);
    el.appendChild(bar);
  }

  function removeActionBar() {
    const existing = document.querySelector(".kana-master-actions");
    if (existing) existing.remove();
    // Restore position style if we set it
    if (highlightedEl && highlightedEl.dataset.kanaPositionSet) {
      highlightedEl.style.position = "";
      delete highlightedEl.dataset.kanaPositionSet;
    }
  }

  function clearHighlight() {
    removeActionBar();
    if (highlightedEl) {
      highlightedEl.classList.remove("kana-master-highlight");
      highlightedEl = null;
    }
  }

  // --- Minimal Markdown renderer ---

  function renderMarkdown(src) {
    const lines = src.split("\n");
    let html = "";
    let inUl = false;
    let inOl = false;

    function closeLists() {
      if (inUl) { html += "</ul>"; inUl = false; }
      if (inOl) { html += "</ol>"; inOl = false; }
    }

    function escapeMarkdown(text) {
      return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    function inlineFormat(text) {
      return escapeMarkdown(text)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");
    }

    for (const raw of lines) {
      const line = raw.trimEnd();

      // Headings
      const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        closeLists();
        const level = headingMatch[1].length;
        html += `<h${level + 3}>${inlineFormat(headingMatch[2])}</h${level + 3}>`;
        continue;
      }

      // Unordered list
      const ulMatch = line.match(/^[\s]*[-*]\s+(.+)$/);
      if (ulMatch) {
        if (inOl) { html += "</ol>"; inOl = false; }
        if (!inUl) { html += "<ul>"; inUl = true; }
        html += `<li>${inlineFormat(ulMatch[1])}</li>`;
        continue;
      }

      // Ordered list
      const olMatch = line.match(/^[\s]*\d+[.．]\s+(.+)$/);
      if (olMatch) {
        if (inUl) { html += "</ul>"; inUl = false; }
        if (!inOl) { html += "<ol>"; inOl = true; }
        html += `<li>${inlineFormat(olMatch[1])}</li>`;
        continue;
      }

      // Blank line
      if (!line.trim()) {
        closeLists();
        continue;
      }

      // Normal paragraph
      closeLists();
      html += `<p>${inlineFormat(line)}</p>`;
    }

    closeLists();
    return html;
  }

  // --- Core annotation logic ---

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

  function getTextWithoutRuby(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll("rt, rp").forEach((n) => n.remove());
    return clone.textContent;
  }

  function extractSentence(fullText, word) {
    const sentences = fullText.split(/(?<=。)/);
    const match = sentences.find((s) => s.includes(word));
    return match ? match.trim() : fullText;
  }

  // Duplicated from lib/api.js — content scripts are IIFE and cannot use ES module imports
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function ensureBlockWrapper(el) {
    let block = el.closest(".kana-master-block");
    if (!block) {
      block = document.createElement("div");
      block.className = "kana-master-block";
      el.parentNode.insertBefore(block, el);
      block.appendChild(el);
    }
    return block;
  }

  function applyLangDir(el, targetLang) {
    el.lang = targetLang;
    if (targetLang === "ar") {
      el.dir = "rtl";
      el.style.textAlign = "right";
    }
  }

  function collectTextNodes(el) {
    const nodes = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.length > 0) nodes.push(node);
    }
    return nodes;
  }

  function applyFuriganaPreservingStyle(el, tokens) {
    const textNodes = collectTextNodes(el);
    if (textNodes.length === 0) return;

    // Build character ranges for text nodes
    let offset = 0;
    const nodeRanges = textNodes.map((node) => {
      const start = offset;
      offset += node.textContent.length;
      return { node, start, end: offset };
    });

    // Build character ranges for tokens
    offset = 0;
    const tokenRanges = tokens.map((tok) => {
      const start = offset;
      offset += tok.t.length;
      return { t: tok.t, r: tok.r, start, end: offset };
    });

    // Process each text node: find overlapping tokens and build ruby HTML
    for (const { node, start, end } of nodeRanges) {
      const overlapping = tokenRanges.filter(
        (t) => t.start < end && t.end > start
      );
      if (overlapping.length === 0) continue;

      let html = "";
      for (const tok of overlapping) {
        const sliceStart = Math.max(tok.start, start) - tok.start;
        const sliceEnd = Math.min(tok.end, end) - tok.start;
        const text = tok.t.substring(sliceStart, sliceEnd);
        const isWhole = sliceStart === 0 && sliceEnd === tok.t.length;

        if (tok.r && isWhole) {
          html += `<ruby>${escapeHtml(text)}<rp>(</rp><rt>${escapeHtml(tok.r)}</rt><rp>)</rp></ruby>`;
        } else {
          html += escapeHtml(text);
        }
      }

      const frag = document.createRange().createContextualFragment(html);
      node.parentNode.replaceChild(frag, node);
    }
  }

  async function annotateElement(el, mode = "both") {
    // Skip if this mode was already done
    if (mode === "annotate" && el.dataset.kanaAnnotated) return;
    if (mode === "translate" && el.dataset.kanaTranslated) return;
    if (mode === "grammar" && el.dataset.kanaGrammar) return;
    if (mode === "both" && el.dataset.kanaAnnotated && el.dataset.kanaTranslated) return;

    const text = getTextWithoutRuby(el);
    el.classList.add("kana-master-loading");

    const block = ensureBlockWrapper(el);

    // Create translation div if needed (translate or both)
    const needsTranslation = mode === "translate" || mode === "both";
    let transDiv = null;
    if (needsTranslation) {
      transDiv = block.querySelector(".kana-master-translation");
      if (!transDiv) {
        transDiv = document.createElement("div");
        transDiv.className = "kana-master-translation";
        block.appendChild(transDiv);
      }
    }

    // Create grammar div if needed
    let grammarDiv = null;
    let grammarRaw = "";
    if (mode === "grammar") {
      grammarDiv = block.querySelector(".kana-master-grammar");
      if (!grammarDiv) {
        grammarDiv = document.createElement("div");
        grammarDiv.className = "kana-master-grammar";
        block.appendChild(grammarDiv);
      }
    }

    const port = chrome.runtime.connect({ name: "kana-stream" });

    port.onMessage.addListener((msg) => {
      if (msg.type === "langInfo") {
        if (transDiv) applyLangDir(transDiv, msg.targetLang);
        if (grammarDiv) applyLangDir(grammarDiv, msg.targetLang);
      }

      if (msg.type === "furigana") {
        el.classList.remove("kana-master-loading");
        if (msg.tokens && msg.tokens.length > 0) {
          applyFuriganaPreservingStyle(el, msg.tokens);
          el.classList.add("kana-master-annotated");
          el.dataset.kanaAnnotated = "true";
        }
      }

      if (msg.type === "translationChunk" && transDiv) {
        transDiv.textContent += msg.text;
      }

      if (msg.type === "translation" && transDiv) {
        transDiv.textContent = msg.text;
      }

      if (msg.type === "grammarChunk" && grammarDiv) {
        grammarRaw += msg.text;
        grammarDiv.innerHTML = renderMarkdown(grammarRaw);
      }

      if (msg.type === "allDone") {
        el.classList.remove("kana-master-loading");
        if (transDiv && !transDiv.textContent) {
          transDiv.remove();
        }
        if (transDiv && transDiv.textContent) {
          el.dataset.kanaTranslated = "true";
        }
        if (grammarDiv && !grammarRaw) {
          grammarDiv.remove();
        }
        if (grammarDiv && grammarRaw) {
          el.dataset.kanaGrammar = "true";
        }
        port.disconnect();
      }

      if (msg.type === "error") {
        el.classList.remove("kana-master-loading");
        if (transDiv) transDiv.remove();
        if (grammarDiv) grammarDiv.remove();
        if (!block.querySelector(".kana-master-translation") && !block.querySelector(".kana-master-grammar") && !el.dataset.kanaAnnotated) {
          block.replaceWith(el);
        }
        showError(el, msg.message);
        port.disconnect();
      }
    });

    port.postMessage({ type: "streamTranslate", paragraphs: [text], mode });
  }

  async function playTts(el, text) {
    el.classList.add("kana-master-loading");
    try {
      const response = await chrome.runtime.sendMessage({ type: "tts", text });
      if (response.error) throw new Error(response.error);
      el.classList.remove("kana-master-loading");
      const audio = new Audio(response.audioDataUrl);
      audio.play().catch((err) => {
        console.error("Kana Master: audio play failed:", err);
        showError(el, "Audio playback blocked by browser");
      });
    } catch (err) {
      el.classList.remove("kana-master-loading");
      console.error("Kana Master TTS error:", err);
      showError(el, err.message);
    }
  }

  // --- Vocabulary popup (select text or click ruby in annotated blocks) ---

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

  function findAnnotatedContext(node) {
    const el = node.nodeType === 3 ? node.parentElement : node;
    return el.closest(".kana-master-annotated") || el.closest(".kana-master-block");
  }

  // Prevent link navigation when clicking ruby or selecting text inside annotated blocks
  document.addEventListener("click", (e) => {
    if (annotateMode) return;
    if (e.target.closest(".kana-master-vocab-popup")) return;
    const ruby = e.target.closest("ruby");
    if (ruby && ruby.closest(".kana-master-annotated")) {
      e.preventDefault();
      return;
    }
    // Also prevent link navigation when there's a text selection inside annotated blocks
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) {
      const anchor = sel.anchorNode;
      const el = anchor?.nodeType === 3 ? anchor.parentElement : anchor;
      if (el?.closest(".kana-master-annotated") || el?.closest(".kana-master-block")) {
        e.preventDefault();
      }
    }
  }, true);

  document.addEventListener("mouseup", (e) => {
    if (annotateMode) return;
    if (e.target.closest(".kana-master-vocab-popup")) return;

    setTimeout(() => {
      const existingPopup = document.querySelector(".kana-master-vocab-popup");
      if (existingPopup) existingPopup.remove();

      const sel = window.getSelection();

      if (sel && !sel.isCollapsed && sel.toString().trim()) {
        // Text selection mode
        const range = sel.getRangeAt(0);
        const ancestor = range.commonAncestorContainer;
        const contextEl = findAnnotatedContext(ancestor);
        if (!contextEl) return;

        const { word, reading } = extractFromSelection(range);
        if (!word) return;

        const annotatedEl = contextEl.closest(".kana-master-block")?.querySelector(".kana-master-annotated") || contextEl;
        const context = extractSentence(getTextWithoutRuby(annotatedEl), word);
        const block = annotatedEl.closest(".kana-master-block");
        const transDiv = block?.querySelector(".kana-master-translation");
        const contextTranslation = transDiv?.textContent || "";

        const rect = range.getBoundingClientRect();
        showVocabPopupAt(word, reading, context, contextTranslation, rect);
      } else {
        // Click on ruby
        const ruby = e.target.closest("ruby");
        if (!ruby || !ruby.closest(".kana-master-annotated")) return;

        const word = getWordFromRuby(ruby);
        const reading = ruby.querySelector("rt")?.textContent || "";
        const annotatedEl = ruby.closest(".kana-master-annotated");
        const context = extractSentence(getTextWithoutRuby(annotatedEl), word);
        const block = annotatedEl.closest(".kana-master-block");
        const transDiv = block?.querySelector(".kana-master-translation");
        const contextTranslation = transDiv?.textContent || "";

        const rect = ruby.getBoundingClientRect();
        showVocabPopupAt(word, reading, context, contextTranslation, rect);
      }
    }, 10);
  });

  // Dismiss popup on click outside
  document.addEventListener("mousedown", (e) => {
    if (e.target.closest(".kana-master-vocab-popup")) return;
    const popup = document.querySelector(".kana-master-vocab-popup");
    if (popup) popup.remove();
  });

  function showVocabPopupAt(word, reading, context, contextTranslation, rect) {
    const popup = document.createElement("div");
    popup.className = "kana-master-vocab-popup";

    const showReading = reading && reading !== word;
    popup.innerHTML =
      `<div class="kana-vocab-word">${escapeHtml(word)}</div>` +
      (showReading ? `<div class="kana-vocab-reading">${escapeHtml(reading)}</div>` : "") +
      `<button class="kana-vocab-save">+ 生词本</button>`;

    const saveBtn = popup.querySelector(".kana-vocab-save");
    saveBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      saveBtn.disabled = true;
      saveBtn.textContent = "...";

      try {
        const response = await chrome.runtime.sendMessage({
          type: "generateVocabEntry",
          word,
          sentence: context,
        });

        const { vocabulary = [] } = await chrome.storage.local.get("vocabulary");
        const sourceUrl = location.href;

        if (response?.error || !response?.entry) {
          // Fallback: save with minimal info
          const entry = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
            word,
            dictionaryForm: word,
            reading: reading || "",
            partOfSpeech: "",
            definition: "",
            contexts: [{ text: context, translation: contextTranslation, sourceUrl, addedAt: Date.now() }],
            createdAt: Date.now(),
          };
          vocabulary.unshift(entry);
        } else {
          const data = response.entry;
          const dictForm = data.dictionaryForm || word;

          // Check for duplicate by dictionary form
          const existing = vocabulary.find((e) => e.dictionaryForm === dictForm);
          if (existing) {
            // Append new context only
            existing.contexts = existing.contexts || [];
            existing.contexts.push({ text: context, translation: contextTranslation, sourceUrl, addedAt: Date.now() });
          } else {
            const entry = {
              id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
              word: data.originalText || word,
              dictionaryForm: dictForm,
              reading: data.reading || reading || "",
              partOfSpeech: data.partOfSpeech || "",
              definition: data.definition || "",
              contexts: [{ text: context, translation: contextTranslation, sourceUrl, addedAt: Date.now() }],
              createdAt: Date.now(),
            };
            if (data.verbType) entry.verbType = data.verbType;
            if (data.conjugations) entry.conjugations = data.conjugations;
            if (data.adjectiveType) entry.adjectiveType = data.adjectiveType;
            if (data.adjectiveConjugations) entry.adjectiveConjugations = data.adjectiveConjugations;
            vocabulary.unshift(entry);
          }
        }

        await chrome.storage.local.set({ vocabulary });

        saveBtn.textContent = "✓ 已添加";
        saveBtn.classList.add("saved");
        setTimeout(() => popup.remove(), 800);
      } catch {
        saveBtn.textContent = "失败";
        saveBtn.disabled = false;
      }
    });

    document.body.appendChild(popup);
    const popupLeft = Math.min(rect.left + window.scrollX, window.innerWidth - 180);
    popup.style.top = (window.scrollY + rect.bottom + 8) + "px";
    popup.style.left = Math.max(0, popupLeft) + "px";
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

      const targetLang = response.targetLang || "zh-CN";
      const results = response.results || [];
      results.forEach((result, i) => {
        if (i >= elements.length) return;
        const el = elements[i];
        const block = ensureBlockWrapper(el);

        if (result.furigana && result.furigana.length > 0) {
          applyFuriganaPreservingStyle(el, result.furigana);
          el.classList.add("kana-master-annotated");
          el.dataset.kanaAnnotated = "true";
        }

        if (result.translation) {
          const transDiv = document.createElement("div");
          transDiv.className = "kana-master-translation";
          applyLangDir(transDiv, targetLang);
          transDiv.textContent = result.translation;
          block.appendChild(transDiv);
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
