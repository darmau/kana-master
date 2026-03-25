(() => {
  const JP_REGEX = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/;
  const TARGETS =
    "p, li, td, th, blockquote, h1, h2, h3, h4, h5, h6, figcaption, span, div";
  let annotateMode = false;
  let highlightedEl = null;

  // --- i18n for content script (uses Chrome's native _locales) ---
  function csT(key) {
    return chrome.i18n.getMessage(key) || key;
  }

  function hasJapanese(text) {
    return JP_REGEX.test(text);
  }

  const BLOCK_TARGETS =
    "p, li, td, th, blockquote, h1, h2, h3, h4, h5, h6, figcaption";

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

  document.addEventListener(
    "mouseover",
    (e) => {
      if (!annotateMode) return;

      // Don't clear highlight when hovering over the action bar
      if (e.target.closest?.(".kana-master-actions")) return;

      const el = e.target.closest?.(TARGETS);
      if (!el || !hasJapanese(el.textContent)) {
        clearHighlight();
        return;
      }
      // Skip if all actions already done
      if (
        el.dataset.kanaAnnotated &&
        el.dataset.kanaTranslated &&
        el.dataset.kanaGrammar
      ) {
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
    },
    true,
  );

  document.addEventListener(
    "click",
    (e) => {
      if (!annotateMode || !highlightedEl) return;

      // Let action bar buttons handle themselves
      if (e.target.closest?.(".kana-master-actions")) return;

      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );

  function showActionBar(el) {
    removeActionBar();
    if (!el.style.position || el.style.position === "static") {
      el.style.position = "relative";
      el.dataset.kanaPositionSet = "true";
    }

    const bar = document.createElement("div");
    bar.className = "kana-master-actions";

    const btnAnnotate = document.createElement("button");
    btnAnnotate.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M13 7V9H19V11L17.0322 11.0006C16.2423 13.3666 14.9984 15.5065 13.4107 17.302C14.9544 18.6737 16.7616 19.7204 18.7379 20.3443L18.2017 22.2736C15.8917 21.5557 13.787 20.3326 12.0005 18.7257C10.214 20.332 8.10914 21.5553 5.79891 22.2734L5.26257 20.3442C7.2385 19.7203 9.04543 18.6737 10.5904 17.3021C9.46307 16.0285 8.50916 14.5805 7.76789 13.0013L10.0074 13.0014C10.5706 14.0395 11.2401 15.0037 11.9998 15.8772C13.2283 14.4651 14.2205 12.8162 14.9095 11.001L5 11V9H11V7H13Z" fill="currentColor"/><path d="M12 2C12.8284 2 13.5 2.6716 13.5 3.5C13.5 4.3284 12.8284 5 12 5C11.1716 5 10.5 4.3284 10.5 3.5C10.5 2.6716 11.1716 2 12 2ZM6.5 2C7.32843 2 8 2.6716 8 3.5C8 4.3284 7.32843 5 6.5 5C5.67157 5 5 4.3284 5 3.5C5 2.6716 5.67157 2 6.5 2ZM17.5 2C18.3284 2 19 2.6716 19 3.5C19 4.3284 18.3284 5 17.5 5C16.6716 5 16 4.3284 16 3.5C16 2.6716 16.6716 2 17.5 2Z" fill="currentColor"/></svg>';
    btnAnnotate.title = csT("annotateTooltip");
    if (el.dataset.kanaAnnotated) btnAnnotate.disabled = true;
    btnAnnotate.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = highlightedEl;
      clearHighlight();
      annotateElement(target, "annotate");
    });

    const btnTranslate = document.createElement("button");
    btnTranslate.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M5 15V17C5 18.0544 5.81588 18.9182 6.85074 18.9945L7 19H10V21H7C4.79086 21 3 19.2091 3 17V15H5ZM18 10L22.4 21H20.245L19.044 18H14.954L13.755 21H11.601L16 10H18ZM17 12.8852L15.753 16H18.245L17 12.8852ZM8 2V4H12V11H8V14H6V11H2V4H6V2H8ZM17 3C19.2091 3 21 4.79086 21 7V9H19V7C19 5.89543 18.1046 5 17 5H14V3H17ZM6 6H4V9H6V6ZM10 6H8V9H10V6Z" fill="currentColor"/></svg>';
    btnTranslate.title = csT("translateTooltip");
    if (el.dataset.kanaTranslated) btnTranslate.disabled = true;
    btnTranslate.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = highlightedEl;
      clearHighlight();
      annotateElement(target, "translate");
    });

    const btnGrammar = document.createElement("button");
    btnGrammar.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M10 2C10.5523 2 11 2.44772 11 3V7C11 7.55228 10.5523 8 10 8H8V10H13V9C13 8.44772 13.4477 8 14 8H20C20.5523 8 21 8.44772 21 9V13C21 13.5523 20.5523 14 20 14H14C13.4477 14 13 13.5523 13 13V12H8V18H13V17C13 16.4477 13.4477 16 14 16H20C20.5523 16 21 16.4477 21 17V21C21 21.5523 20.5523 22 20 22H14C13.4477 22 13 21.5523 13 21V20H7C6.44772 20 6 19.5523 6 19V8H4C3.44772 8 3 7.55228 3 7V3C3 2.44772 3.44772 2 4 2H10ZM19 18H15V20H19V18ZM19 10H15V12H19V10ZM9 4H5V6H9V4Z" fill="currentColor"/></svg>';
    btnGrammar.title = csT("grammarTooltip");
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
    btnTts.innerHTML =
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M16.9337 8.96494C16.426 5.03562 13.0675 2 9 2C4.58172 2 1 5.58172 1 10C1 11.8924 1.65707 13.6313 2.7555 15.0011C3.56351 16.0087 4.00033 17.1252 4.00025 18.3061L4 22H13L13.001 19H15C16.1046 19 17 18.1046 17 17V14.071L18.9593 13.2317C19.3025 13.0847 19.3324 12.7367 19.1842 12.5037L16.9337 8.96494ZM3 10C3 6.68629 5.68629 4 9 4C12.0243 4 14.5665 6.25141 14.9501 9.22118L15.0072 9.66262L16.5497 12.0881L15 12.7519V17H11.0017L11.0007 20H6.00013L6.00025 18.3063C6.00036 16.6672 5.40965 15.114 4.31578 13.7499C3.46818 12.6929 3 11.3849 3 10ZM21.1535 18.1024L19.4893 16.9929C20.4436 15.5642 21 13.8471 21 12.0001C21 10.153 20.4436 8.4359 19.4893 7.00722L21.1535 5.89771C22.32 7.64386 23 9.74254 23 12.0001C23 14.2576 22.32 16.3562 21.1535 18.1024Z" fill="currentColor"/></svg>';
    btnTts.title = csT("readAloudTooltip");
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
      if (inUl) {
        html += "</ul>";
        inUl = false;
      }
      if (inOl) {
        html += "</ol>";
        inOl = false;
      }
    }

    function escapeMarkdown(text) {
      return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
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
        if (inOl) {
          html += "</ol>";
          inOl = false;
        }
        if (!inUl) {
          html += "<ul>";
          inUl = true;
        }
        html += `<li>${inlineFormat(ulMatch[1])}</li>`;
        continue;
      }

      // Ordered list
      const olMatch = line.match(/^[\s]*\d+[.．]\s+(.+)$/);
      if (olMatch) {
        if (inUl) {
          html += "</ul>";
          inUl = false;
        }
        if (!inOl) {
          html += "<ol>";
          inOl = true;
        }
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
    clone.querySelectorAll("rt, rp, code").forEach((n) => n.remove());
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
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.parentElement?.closest("code"))
          return NodeFilter.FILTER_REJECT;
        return node.textContent.length > 0
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    let node;
    while ((node = walker.nextNode())) {
      nodes.push(node);
    }
    return nodes;
  }

  function applyFuriganaPreservingStyle(el, tokens) {
    const textNodes = collectTextNodes(el);
    if (textNodes.length === 0) return;

    const fullText = textNodes.map((n) => n.textContent).join("");

    // Phase 1: Match tokens to original text by sequential character matching.
    // Skips whitespace the API may have inserted between tokens.
    const annotations = []; // {start, end, reading} in fullText coordinates
    let pos = 0;

    for (const tok of tokens) {
      // Strip whitespace from API token for matching
      const target = tok.t.replace(/\s/g, "");
      if (target.length === 0) continue;

      // Search forward in fullText from current pos (skips over unmatched content)
      let matchStart = -1;
      let matchEnd = -1;

      for (let i = pos; i < fullText.length; i++) {
        if (/\s/.test(fullText[i])) continue;
        if (fullText[i] !== target[0]) continue;

        // Try full match from position i
        let ti = 0,
          fi = i;
        while (ti < target.length && fi < fullText.length) {
          if (/\s/.test(fullText[fi])) {
            fi++;
            continue;
          }
          if (fullText[fi] === target[ti]) {
            ti++;
            fi++;
          } else {
            break;
          }
        }

        if (ti >= target.length) {
          matchStart = i;
          matchEnd = fi;
          break;
        }
      }

      if (matchStart >= 0) {
        if (tok.r) {
          annotations.push({
            start: matchStart,
            end: matchEnd,
            reading: tok.r,
          });
        }
        pos = matchEnd;
      }
      // If not found, skip this token (pos unchanged, next token can still match)
    }

    if (annotations.length === 0) return;

    // Phase 2: Apply ruby to text nodes. Process in reverse so earlier
    // node indices stay valid after DOM replacement.
    let offset = 0;
    const nodeRanges = textNodes.map((node) => {
      const start = offset;
      offset += node.textContent.length;
      return { node, start, end: offset };
    });

    for (let i = nodeRanges.length - 1; i >= 0; i--) {
      const { node, start, end } = nodeRanges[i];
      const relevant = annotations.filter(
        (a) => a.start < end && a.end > start,
      );
      if (relevant.length === 0) continue;

      let html = "";
      let localPos = 0;

      for (const ann of relevant) {
        const localStart = Math.max(ann.start - start, 0);
        const localEnd = Math.min(ann.end - start, end - start);
        const wholeToken = ann.start >= start && ann.end <= end;

        if (localStart > localPos) {
          html += escapeHtml(node.textContent.substring(localPos, localStart));
        }

        const text = node.textContent.substring(localStart, localEnd);
        if (wholeToken) {
          html += `<ruby>${escapeHtml(text)}<rp>(</rp><rt>${escapeHtml(ann.reading)}</rt><rp>)</rp></ruby>`;
        } else {
          html += escapeHtml(text);
        }
        localPos = localEnd;
      }

      if (localPos < node.textContent.length) {
        html += escapeHtml(node.textContent.substring(localPos));
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
    if (
      mode === "both" &&
      el.dataset.kanaAnnotated &&
      el.dataset.kanaTranslated
    )
      return;

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
          showDebugTokens(block, msg.rawTokens || msg.tokens, text);
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
        if (
          !block.querySelector(".kana-master-translation") &&
          !block.querySelector(".kana-master-grammar") &&
          !el.dataset.kanaAnnotated
        ) {
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
        console.error("Yomeru: audio play failed:", err);
        showError(el, csT("audioBlocked"));
      });
    } catch (err) {
      el.classList.remove("kana-master-loading");
      console.error("Yomeru TTS error:", err);
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
    return (
      el.closest(".kana-master-annotated") || el.closest(".kana-master-block")
    );
  }

  // Prevent link navigation when clicking ruby or selecting text inside annotated blocks
  document.addEventListener(
    "click",
    (e) => {
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
        if (
          el?.closest(".kana-master-annotated") ||
          el?.closest(".kana-master-block")
        ) {
          e.preventDefault();
        }
      }
    },
    true,
  );

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

        const annotatedEl =
          contextEl
            .closest(".kana-master-block")
            ?.querySelector(".kana-master-annotated") || contextEl;
        const context = extractSentence(getTextWithoutRuby(annotatedEl), word);
        const block = annotatedEl.closest(".kana-master-block");
        const transDiv = block?.querySelector(".kana-master-translation");
        const contextTranslation = transDiv?.textContent || "";

        const rect = range.getBoundingClientRect();
        const savedRange = range.cloneRange();
        showVocabPopupAt(word, reading, context, contextTranslation, rect, savedRange);
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

  function showVocabPopupAt(word, reading, context, contextTranslation, rect, selectionRange) {
    const popup = document.createElement("div");
    popup.className = "kana-master-vocab-popup";

    const showReading = reading && reading !== word;
    popup.innerHTML =
      `<div class="kana-vocab-word">${escapeHtml(word)}</div>` +
      (showReading
        ? `<div class="kana-vocab-reading">${escapeHtml(reading)}</div>`
        : "") +
      (selectionRange
        ? `<button class="kana-vocab-annotate">${csT("annotateWord")}</button>`
        : "") +
      `<button class="kana-vocab-save">${csT("addToVocab")}</button>`;

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

        const { vocabulary = [] } =
          await chrome.storage.local.get("vocabulary");
        const sourceUrl = location.href;

        if (response?.error || !response?.entry) {
          // Fallback: save with minimal info
          const entry = {
            id:
              Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
            word,
            dictionaryForm: word,
            reading: reading || "",
            partOfSpeech: "",
            definition: "",
            contexts: [
              {
                text: context,
                translation: contextTranslation,
                sourceUrl,
                addedAt: Date.now(),
              },
            ],
            createdAt: Date.now(),
          };
          vocabulary.unshift(entry);
        } else {
          const data = response.entry;
          const dictForm = data.dictionaryForm || word;

          // Check for duplicate by dictionary form
          const existing = vocabulary.find(
            (e) => e.dictionaryForm === dictForm,
          );
          if (existing) {
            // Append new context only
            existing.contexts = existing.contexts || [];
            existing.contexts.push({
              text: context,
              translation: contextTranslation,
              sourceUrl,
              addedAt: Date.now(),
            });
          } else {
            const entry = {
              id:
                Date.now().toString(36) +
                Math.random().toString(36).slice(2, 7),
              word: data.originalText || word,
              dictionaryForm: dictForm,
              reading: data.reading || reading || "",
              partOfSpeech: data.partOfSpeech || "",
              definition: data.definition || "",
              contexts: [
                {
                  text: context,
                  translation: contextTranslation,
                  sourceUrl,
                  addedAt: Date.now(),
                },
              ],
              createdAt: Date.now(),
            };
            if (data.verbType) entry.verbType = data.verbType;
            if (data.conjugations) entry.conjugations = data.conjugations;
            if (data.adjectiveType) entry.adjectiveType = data.adjectiveType;
            if (data.adjectiveConjugations)
              entry.adjectiveConjugations = data.adjectiveConjugations;
            vocabulary.unshift(entry);
          }
        }

        await chrome.storage.local.set({ vocabulary });

        saveBtn.textContent = csT("added");
        saveBtn.classList.add("saved");
        setTimeout(() => popup.remove(), 800);
      } catch {
        saveBtn.textContent = csT("failed");
        saveBtn.disabled = false;
      }
    });

    const annotateBtn = popup.querySelector(".kana-vocab-annotate");
    if (annotateBtn && selectionRange) {
      annotateBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        annotateBtn.disabled = true;
        annotateBtn.textContent = "...";

        try {
          const response = await chrome.runtime.sendMessage({
            type: "annotate",
            text: word,
          });

          if (response.error) throw new Error(response.error);

          const tokens = response.furigana;
          if (tokens && tokens.length > 0) {
            const html = tokens
              .map((tok) => {
                if (tok.r && tok.r !== tok.t) {
                  return `<ruby>${escapeHtml(tok.t)}<rp>(</rp><rt>${escapeHtml(tok.r)}</rt><rp>)</rp></ruby>`;
                }
                return escapeHtml(tok.t);
              })
              .join("");

            selectionRange.deleteContents();
            const temp = document.createElement("span");
            temp.innerHTML = html;
            const frag = document.createDocumentFragment();
            while (temp.firstChild) frag.appendChild(temp.firstChild);
            selectionRange.insertNode(frag);
            window.getSelection()?.removeAllRanges();

            annotateBtn.textContent = csT("added");
            annotateBtn.classList.add("done");
            setTimeout(() => popup.remove(), 800);
          } else {
            annotateBtn.textContent = csT("failed");
            annotateBtn.disabled = false;
          }
        } catch {
          annotateBtn.textContent = csT("failed");
          annotateBtn.disabled = false;
        }
      });
    }

    document.body.appendChild(popup);
    const popupLeft = Math.min(
      rect.left + window.scrollX,
      window.innerWidth - 180,
    );
    popup.style.top = window.scrollY + rect.bottom + 8 + "px";
    popup.style.left = Math.max(0, popupLeft) + "px";
  }

  async function showDebugTokens(block, tokens, inputText) {
    const { debugMode } = await chrome.storage.sync.get("debugMode");
    if (!debugMode) return;
    const existing = block.querySelector(".kana-master-debug");
    if (existing) existing.remove();
    const debugData = { input: inputText, tokens };
    const json = JSON.stringify(debugData, null, 2);
    const debugDiv = document.createElement("div");
    debugDiv.className = "kana-master-debug";
    debugDiv.textContent = json;
    const copyBtn = document.createElement("button");
    copyBtn.className = "kana-master-debug-copy";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(json).then(() => {
        copyBtn.textContent = "Copied";
        setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
      });
    });
    debugDiv.appendChild(copyBtn);
    block.appendChild(debugDiv);
  }

  function showError(el, message) {
    const errDiv = document.createElement("div");
    errDiv.className = "kana-master-error";
    errDiv.textContent = `Yomeru: ${message}`;
    el.after(errDiv);
    setTimeout(() => errDiv.remove(), 5000);
  }

  // --- Bulk annotation ---

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "bulkTranslate") {
      bulkProcess("both")
        .then(sendResponse)
        .catch((err) => sendResponse({ error: err.message }));
      return true;
    }
    if (message.type === "bulkAnnotateOnly") {
      bulkProcess("annotate")
        .then(sendResponse)
        .catch((err) => sendResponse({ error: err.message }));
      return true;
    }
    if (message.type === "bulkTranslateOnly") {
      bulkProcess("translate")
        .then(sendResponse)
        .catch((err) => sendResponse({ error: err.message }));
      return true;
    }
    if (message.type === "extractContent") {
      sendResponse(extractContent());
      return false;
    }
  });

  async function bulkProcess(mode = "both") {
    const container = findMainContent();
    if (!container) return { error: "Could not find main content area" };

    const skipAnnotated = mode === "both" || mode === "annotate";
    const skipTranslated = mode === "translate";

    const elements = Array.from(container.querySelectorAll(TARGETS)).filter(
      (el) =>
        hasJapanese(el.textContent) &&
        isLeafTextElement(el) &&
        el.textContent.trim().length > 0 &&
        !(skipAnnotated && el.dataset.kanaAnnotated) &&
        !(skipTranslated && el.dataset.kanaTranslated),
    );

    if (elements.length === 0) return { done: true, count: 0 };

    const texts = elements.map((el) => getTextWithoutRuby(el));

    try {
      const response = await chrome.runtime.sendMessage({
        type: "bulkAnnotate",
        paragraphs: texts,
        mode,
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
          let transDiv = block.querySelector(".kana-master-translation");
          if (!transDiv) {
            transDiv = document.createElement("div");
            transDiv.className = "kana-master-translation";
            block.appendChild(transDiv);
          }
          applyLangDir(transDiv, targetLang);
          transDiv.textContent = result.translation;
          el.dataset.kanaTranslated = "true";
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
      "P",
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
      "H6",
      "LI",
      "BLOCKQUOTE",
      "FIGCAPTION",
      "PRE",
    ]);

    const walker = document.createTreeWalker(
      container,
      NodeFilter.SHOW_ELEMENT,
      {
        acceptNode(node) {
          // Skip scripts, styles, nav, etc.
          const skip = new Set([
            "SCRIPT",
            "STYLE",
            "NAV",
            "FOOTER",
            "ASIDE",
            "NOSCRIPT",
          ]);
          if (skip.has(node.tagName)) return NodeFilter.FILTER_REJECT;
          if (EXTRACT_TAGS.has(node.tagName)) return NodeFilter.FILTER_ACCEPT;
          return NodeFilter.FILTER_SKIP;
        },
      },
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
