(() => {
  // Shared DOM helpers (loaded via lib/shared.js before this script \u2014 see manifest).
  // getTextWithoutRuby stays local: the content script also strips <code>.
  const { escapeHtml, tokensToHtml, extractFromSelection, getWordFromRuby, extractSentence } = globalThis.KanaShared;

  const JP_REGEX = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/;
  const TARGETS =
    "p, li, td, th, blockquote, h1, h2, h3, h4, h5, h6, figcaption, span, div";
  let selectionToolbar = null;
  let toolbarRange = null;

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

  // --- Action buttons (shared between selection toolbar and paragraph handle) ---

  const ICONS = {
    annotate:
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M13 7V9H19V11L17.0322 11.0006C16.2423 13.3666 14.9984 15.5065 13.4107 17.302C14.9544 18.6737 16.7616 19.7204 18.7379 20.3443L18.2017 22.2736C15.8917 21.5557 13.787 20.3326 12.0005 18.7257C10.214 20.332 8.10914 21.5553 5.79891 22.2734L5.26257 20.3442C7.2385 19.7203 9.04543 18.6737 10.5904 17.3021C9.46307 16.0285 8.50916 14.5805 7.76789 13.0013L10.0074 13.0014C10.5706 14.0395 11.2401 15.0037 11.9998 15.8772C13.2283 14.4651 14.2205 12.8162 14.9095 11.001L5 11V9H11V7H13Z" fill="currentColor"/><path d="M12 2C12.8284 2 13.5 2.6716 13.5 3.5C13.5 4.3284 12.8284 5 12 5C11.1716 5 10.5 4.3284 10.5 3.5C10.5 2.6716 11.1716 2 12 2ZM6.5 2C7.32843 2 8 2.6716 8 3.5C8 4.3284 7.32843 5 6.5 5C5.67157 5 5 4.3284 5 3.5C5 2.6716 5.67157 2 6.5 2ZM17.5 2C18.3284 2 19 2.6716 19 3.5C19 4.3284 18.3284 5 17.5 5C16.6716 5 16 4.3284 16 3.5C16 2.6716 16.6716 2 17.5 2Z" fill="currentColor"/></svg>',
    translate:
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M5 15V17C5 18.0544 5.81588 18.9182 6.85074 18.9945L7 19H10V21H7C4.79086 21 3 19.2091 3 17V15H5ZM18 10L22.4 21H20.245L19.044 18H14.954L13.755 21H11.601L16 10H18ZM17 12.8852L15.753 16H18.245L17 12.8852ZM8 2V4H12V11H8V14H6V11H2V4H6V2H8ZM17 3C19.2091 3 21 4.79086 21 7V9H19V7C19 5.89543 18.1046 5 17 5H14V3H17ZM6 6H4V9H6V6ZM10 6H8V9H10V6Z" fill="currentColor"/></svg>',
    grammar:
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M10 2C10.5523 2 11 2.44772 11 3V7C11 7.55228 10.5523 8 10 8H8V10H13V9C13 8.44772 13.4477 8 14 8H20C20.5523 8 21 8.44772 21 9V13C21 13.5523 20.5523 14 20 14H14C13.4477 14 13 13.5523 13 13V12H8V18H13V17C13 16.4477 13.4477 16 14 16H20C20.5523 16 21 16.4477 21 17V21C21 21.5523 20.5523 22 20 22H14C13.4477 22 13 21.5523 13 21V20H7C6.44772 20 6 19.5523 6 19V8H4C3.44772 8 3 7.55228 3 7V3C3 2.44772 3.44772 2 4 2H10ZM19 18H15V20H19V18ZM19 10H15V12H19V10ZM9 4H5V6H9V4Z" fill="currentColor"/></svg>',
    tts:
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M16.9337 8.96494C16.426 5.03562 13.0675 2 9 2C4.58172 2 1 5.58172 1 10C1 11.8924 1.65707 13.6313 2.7555 15.0011C3.56351 16.0087 4.00033 17.1252 4.00025 18.3061L4 22H13L13.001 19H15C16.1046 19 17 18.1046 17 17V14.071L18.9593 13.2317C19.3025 13.0847 19.3324 12.7367 19.1842 12.5037L16.9337 8.96494ZM3 10C3 6.68629 5.68629 4 9 4C12.0243 4 14.5665 6.25141 14.9501 9.22118L15.0072 9.66262L16.5497 12.0881L15 12.7519V17H11.0017L11.0007 20H6.00013L6.00025 18.3063C6.00036 16.6672 5.40965 15.114 4.31578 13.7499C3.46818 12.6929 3 11.3849 3 10ZM21.1535 18.1024L19.4893 16.9929C20.4436 15.5642 21 13.8471 21 12.0001C21 10.153 20.4436 8.4359 19.4893 7.00722L21.1535 5.89771C22.32 7.64386 23 9.74254 23 12.0001C23 14.2576 22.32 16.3562 21.1535 18.1024Z" fill="currentColor"/></svg>',
  };

  function makeActionButton(icon, title, extraClass, onClick) {
    const btn = document.createElement("button");
    btn.innerHTML = icon;
    btn.title = title;
    if (extraClass) btn.className = extraClass;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick(btn);
    });
    return btn;
  }

  // --- Selection toolbar: select text to reveal the action bar ---

  function showSelectionToolbar(range, rect) {
    removeSelectionToolbar();
    toolbarRange = range;

    const bar = document.createElement("div");
    bar.className = "kana-master-actions kana-master-actions-floating";

    // Furigana and grammar analysis only make sense for Japanese text;
    // translation and TTS work for any language.
    const jp = hasJapanese(range.toString());

    if (jp) {
      bar.appendChild(
        makeActionButton(ICONS.annotate, csT("annotateTooltip"), "", () => {
          const r = toolbarRange;
          removeSelectionToolbar();
          annotateSelection(r);
        }),
      );
    }

    bar.appendChild(
      makeActionButton(ICONS.translate, csT("translateTooltip"), "", () => {
        const r = toolbarRange;
        removeSelectionToolbar();
        streamSelectionToCard(r, "translate");
      }),
    );

    if (jp) {
      bar.appendChild(
        makeActionButton(ICONS.grammar, csT("grammarTooltip"), "kana-master-actions-grammar", () => {
          const r = toolbarRange;
          removeSelectionToolbar();
          streamSelectionToCard(r, "grammar");
        }),
      );
    }

    bar.appendChild(
      makeActionButton(ICONS.tts, csT("readAloudTooltip"), "kana-master-actions-tts", (btn) => {
        const text = (toolbarRange?.toString() || "").trim();
        if (text) playTts(btn, text);
      }),
    );

    document.body.appendChild(bar);
    // Position centered above the selection (or below if near the top edge)
    const left = window.scrollX + rect.left + rect.width / 2;
    const aboveTop = window.scrollY + rect.top - bar.offsetHeight - 8;
    const belowTop = window.scrollY + rect.bottom + 8;
    bar.style.left = left + "px";
    bar.style.top = (rect.top < bar.offsetHeight + 16 ? belowTop : aboveTop) + "px";
    selectionToolbar = bar;
  }

  function removeSelectionToolbar() {
    if (selectionToolbar) {
      selectionToolbar.remove();
      selectionToolbar = null;
    }
    toolbarRange = null;
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

  // Like KanaShared's, but the content script also strips <code> blocks.
  function getTextWithoutRuby(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll("rt, rp, code").forEach((n) => n.remove());
    return clone.textContent;
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

  // Furigana on the current selection. The result is applied in place (ruby
  // attaches to the selected words), so unlike translation/grammar it does not
  // need a card or a below-paragraph block.
  async function annotateSelection(range) {
    if (!range) return;
    if (!range.toString().trim()) return;

    // Wrap the selection in an inline span that hosts the furigana ruby. We
    // keep the original nodes so existing markup (links, emphasis) survives.
    const wrapper = document.createElement("span");
    wrapper.className = "kana-master-selection";
    try {
      wrapper.appendChild(range.extractContents());
      range.insertNode(wrapper);
    } catch (err) {
      console.error("Yomeru: failed to wrap selection", err);
      return;
    }
    window.getSelection()?.removeAllRanges();

    const text = getTextWithoutRuby(wrapper);
    wrapper.classList.add("kana-master-loading");

    const { debugMode } = await chrome.storage.sync.get("debugMode");

    const port = chrome.runtime.connect({ name: "kana-stream" });

    port.onMessage.addListener((msg) => {
      if (msg.type === "furigana") {
        wrapper.classList.remove("kana-master-loading");
        if (msg.tokens && msg.tokens.length > 0) {
          applyFuriganaPreservingStyle(wrapper, msg.tokens);
          wrapper.classList.add("kana-master-annotated");
          wrapper.dataset.kanaAnnotated = "true";
          if (debugMode) {
            const container = document.createElement("div");
            container.className = "kana-master-block";
            (wrapper.closest(BLOCK_TARGETS) || wrapper).after(container);
            showDebugTokens(container, msg.rawTokens || msg.tokens, text);
          }
        }
      }

      if (msg.type === "allDone") {
        wrapper.classList.remove("kana-master-loading");
        port.disconnect();
      }

      if (msg.type === "error") {
        wrapper.classList.remove("kana-master-loading");
        showError(wrapper, msg.message);
        port.disconnect();
      }
    });

    port.postMessage({ type: "streamTranslate", paragraphs: [text], mode: "annotate", upgrade: false });
  }

  // --- Result card: selection translation / grammar shown in a floating card ---
  // Only one card exists at a time, so repeated lookups never pile up in the
  // page. The pin button moves the result below the paragraph when the user
  // explicitly wants to keep it.

  let resultCard = null; // { card, port, pinned, done }

  const CARD_MARGIN = 8;

  function removeResultCard() {
    if (!resultCard) return;
    if (!resultCard.pinned && !resultCard.done) {
      try {
        resultCard.port.disconnect();
      } catch {}
    }
    resultCard.card.remove();
    resultCard = null;
  }

  // The card is positioned in page coordinates, so the current scroll offset
  // marks where the viewport edges are. Cards larger than the viewport stick to
  // the top-left margin instead of being pushed off-screen.
  function clampCardPosition(card, left, top) {
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const minLeft = window.scrollX + CARD_MARGIN;
    const minTop = window.scrollY + CARD_MARGIN;
    const maxLeft = window.scrollX + Math.max(CARD_MARGIN, vw - card.offsetWidth - CARD_MARGIN);
    const maxTop = window.scrollY + Math.max(CARD_MARGIN, vh - card.offsetHeight - CARD_MARGIN);
    return {
      left: Math.min(Math.max(left, minLeft), maxLeft),
      top: Math.min(Math.max(top, minTop), maxTop),
    };
  }

  function setCardPosition(card, left, top) {
    const pos = clampCardPosition(card, left, top);
    card.style.left = pos.left + "px";
    card.style.top = pos.top + "px";
  }

  // Re-clamp after the card's size changes (streamed content) or the window resizes
  function keepCardInViewport() {
    if (!resultCard) return;
    const card = resultCard.card;
    setCardPosition(card, parseFloat(card.style.left) || 0, parseFloat(card.style.top) || 0);
  }

  window.addEventListener("resize", keepCardInViewport);

  // Drag the card by its head bar; buttons inside the head stay clickable.
  function makeCardDraggable(card, handle) {
    let pointerId = null;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || pointerId !== null) return;
      if (e.target.closest("button")) return;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      startLeft = parseFloat(card.style.left) || 0;
      startTop = parseFloat(card.style.top) || 0;
      card.classList.add("kana-master-card-dragging");
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {}
      e.preventDefault(); // don't start a text selection while dragging
    });

    handle.addEventListener("pointermove", (e) => {
      if (e.pointerId !== pointerId) return;
      setCardPosition(card, startLeft + e.clientX - startX, startTop + e.clientY - startY);
    });

    const endDrag = (e) => {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      card.classList.remove("kana-master-card-dragging");
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {}
    };
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
  }

  // Selection text without ruby readings (the selection may span annotated text)
  function getRangeText(range) {
    const div = document.createElement("div");
    div.appendChild(range.cloneContents());
    div.querySelectorAll("rt, rp, code").forEach((n) => n.remove());
    return div.textContent;
  }

  function streamSelectionToCard(range, mode) {
    if (!range) return;
    const text = getRangeText(range).trim();
    if (!text) return;

    const rect = range.getBoundingClientRect();
    const node = range.commonAncestorContainer;
    const el = node.nodeType === 3 ? node.parentElement : node;
    const anchorBlock = el?.closest(BLOCK_TARGETS) || el;
    window.getSelection()?.removeAllRanges();

    removeResultCard();

    const card = document.createElement("div");
    card.className = "kana-master-result-card";

    const head = document.createElement("div");
    head.className = "kana-master-card-head";

    const spinner = document.createElement("span");
    spinner.className = "kana-master-card-spinner";

    const srcSpan = document.createElement("span");
    srcSpan.className = "kana-master-card-source";
    srcSpan.textContent = text;

    const pinBtn = document.createElement("button");
    pinBtn.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M14 4v5c0 1.12.37 2.16 1 3H9c.65-.86 1-1.9 1-3V4h4m3-2H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3V4h1c.55 0 1-.45 1-1s-.45-1-1-1z" fill="currentColor"/></svg>';
    pinBtn.title = csT("pinToPage");

    const closeBtn = document.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.title = csT("closeCard");
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeResultCard();
    });

    head.append(spinner, srcSpan, pinBtn, closeBtn);

    const body = document.createElement("div");
    body.className =
      "kana-master-card-body " + (mode === "grammar" ? "kana-master-grammar" : "kana-master-translation");

    card.append(head, body);
    makeCardDraggable(card, head);

    const port = chrome.runtime.connect({ name: "kana-stream" });
    const state = { card, port, pinned: false, done: false };
    resultCard = state;

    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!anchorBlock || !anchorBlock.isConnected) return;
      const container = document.createElement("div");
      container.className = "kana-master-block";
      anchorBlock.after(container);
      body.classList.remove("kana-master-card-body");
      container.appendChild(body);
      state.pinned = true;
      removeResultCard(); // body already moved out; streaming continues into the page
    });

    let grammarRaw = "";

    port.onMessage.addListener((msg) => {
      if (msg.type === "langInfo") {
        applyLangDir(body, msg.targetLang);
      } else if (msg.type === "translationChunk") {
        body.textContent += msg.text;
      } else if (msg.type === "grammarChunk") {
        grammarRaw += msg.text;
        body.innerHTML = renderMarkdown(grammarRaw);
      } else if (msg.type === "error") {
        spinner.remove();
        body.textContent = `Yomeru: ${msg.message}`;
        body.classList.add("kana-master-card-error");
        state.done = true;
        port.disconnect();
        keepCardInViewport();
      } else if (msg.type === "allDone") {
        spinner.remove();
        state.done = true;
        port.disconnect();
        keepCardInViewport(); // the grown card may now hang below the viewport
      }
    });

    const reqMode = mode === "grammar" ? "grammar" : hasJapanese(text) ? "translate" : "translateAny";
    port.postMessage({ type: "streamTranslate", paragraphs: [text], mode: reqMode });

    document.body.appendChild(card);
    setCardPosition(card, rect.left + window.scrollX, rect.bottom + window.scrollY + 8);
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
  // extractFromSelection / getWordFromRuby provided by KanaShared (see top of file).

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
    if (e.target.closest(".kana-master-vocab-popup")) return;
    if (e.target.closest(".kana-master-actions")) return;
    if (e.target.closest(".kana-master-result-card")) return;

    setTimeout(() => {
      const existingPopup = document.querySelector(".kana-master-vocab-popup");
      if (existingPopup) existingPopup.remove();
      removeSelectionToolbar();

      const sel = window.getSelection();

      if (sel && !sel.isCollapsed && sel.toString().trim()) {
        // Text selection mode
        const range = sel.getRangeAt(0);
        const ancestor = range.commonAncestorContainer;
        const contextEl = findAnnotatedContext(ancestor);

        if (contextEl && hasJapanese(sel.toString())) {
          // Japanese selection inside an annotated block → vocabulary popup
          const { word, reading } = extractFromSelection(range);
          if (!word) return;

          const annotatedEl =
            contextEl
              .closest(".kana-master-block")
              ?.querySelector(".kana-master-annotated") || contextEl;
          const context = extractSentence(getTextWithoutRuby(annotatedEl), word);

          const rect = range.getBoundingClientRect();
          const savedRange = range.cloneRange();
          showVocabPopupAt(word, reading, context, rect, savedRange);
        } else if (/\p{L}/u.test(sel.toString())) {
          // Raw text selection (any language) → floating action toolbar
          const rect = range.getBoundingClientRect();
          showSelectionToolbar(range.cloneRange(), rect);
        }
      } else {
        // Click on ruby
        const ruby = e.target.closest("ruby");
        if (!ruby || !ruby.closest(".kana-master-annotated")) return;

        const word = getWordFromRuby(ruby);
        const reading = ruby.querySelector("rt")?.textContent || "";
        const annotatedEl = ruby.closest(".kana-master-annotated");
        const context = extractSentence(getTextWithoutRuby(annotatedEl), word);

        const rect = ruby.getBoundingClientRect();
        showVocabPopupAt(word, reading, context, rect);
      }
    }, 10);
  });

  // Dismiss popup / toolbar / result card on click outside
  document.addEventListener("mousedown", (e) => {
    if (e.target.closest(".kana-master-actions")) return;
    if (e.target.closest(".kana-master-vocab-popup")) return;
    if (e.target.closest(".kana-master-result-card")) return;
    const popup = document.querySelector(".kana-master-vocab-popup");
    if (popup) popup.remove();
    removeSelectionToolbar();
    removeResultCard();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    removeResultCard();
    removeSelectionToolbar();
    hideHandle();
    const popup = document.querySelector(".kana-master-vocab-popup");
    if (popup) popup.remove();
  });

  function showVocabPopupAt(word, reading, context, rect, selectionRange) {
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
        const isGenerated = !!response?.generatedSentence;
        const ctxText = response?.generatedSentence || context;
        const ctxTranslation = response?.sentenceTranslation || "";

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
                text: ctxText,
                translation: ctxTranslation,
                sourceUrl: isGenerated ? "" : sourceUrl,
                manualAdd: isGenerated || undefined,
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
              text: ctxText,
              translation: ctxTranslation,
              sourceUrl: isGenerated ? "" : sourceUrl,
              manualAdd: isGenerated || undefined,
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
                  text: ctxText,
                  translation: ctxTranslation,
                  sourceUrl: isGenerated ? "" : sourceUrl,
                  manualAdd: isGenerated || undefined,
                  addedAt: Date.now(),
                },
              ],
              createdAt: Date.now(),
            };
            if (data.verbType) entry.verbType = data.verbType;
            if (data.verbTransitivity) entry.verbTransitivity = data.verbTransitivity;
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

  // --- Paragraph handle: hover a paragraph to reveal a gutter button that ---
  // expands into block-level actions (furigana+translation / translate /
  // grammar / TTS for the whole paragraph).

  const HANDLE_HIDE_DELAY = 300;
  let handle = null; // { root, btn, bar }
  let handleTarget = null;
  let handleHideTimer = null;

  function ensureHandle() {
    if (handle) return handle;
    const root = document.createElement("div");
    root.className = "kana-master-handle";

    const btn = document.createElement("button");
    btn.className = "kana-master-handle-btn";
    btn.textContent = "読";
    btn.title = csT("paragraphActions");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      expandHandle();
    });

    root.appendChild(btn);
    // The handle itself counts as hover territory, so moving the mouse onto
    // it never triggers the hide timer (the old Alt+hover toolbar's flaw).
    root.addEventListener("mouseenter", cancelHandleHide);
    root.addEventListener("mouseleave", scheduleHandleHide);
    document.body.appendChild(root);
    handle = { root, btn, bar: null };
    return handle;
  }

  function expandHandle() {
    if (!handle || !handleTarget || handle.bar) return;
    const el = handleTarget;
    const jp = hasJapanese(el.textContent);

    const bar = document.createElement("div");
    bar.className = "kana-master-actions kana-master-handle-bar";

    if (jp) {
      bar.appendChild(
        makeActionButton(ICONS.annotate, csT("annotateTooltip"), "", () => {
          hideHandle();
          runBlockAction(el, "annotate");
        }),
      );
    }
    bar.appendChild(
      makeActionButton(ICONS.translate, csT("translateTooltip"), "", () => {
        hideHandle();
        runBlockAction(el, "translate");
      }),
    );
    if (jp) {
      bar.appendChild(
        makeActionButton(ICONS.grammar, csT("grammarTooltip"), "kana-master-actions-grammar", () => {
          hideHandle();
          runBlockAction(el, "grammar");
        }),
      );
    }
    bar.appendChild(
      makeActionButton(ICONS.tts, csT("readAloudTooltip"), "kana-master-actions-tts", (btn) => {
        const text = getTextWithoutRuby(el).trim();
        if (text) playTts(btn, text);
      }),
    );

    handle.btn.style.display = "none";
    handle.bar = bar;
    handle.root.appendChild(bar);
  }

  function collapseHandle() {
    if (!handle) return;
    if (handle.bar) {
      handle.bar.remove();
      handle.bar = null;
    }
    handle.btn.style.display = "";
  }

  function hideHandle() {
    cancelHandleHide();
    if (handle) handle.root.style.display = "none";
    handleTarget = null;
    collapseHandle();
  }

  function scheduleHandleHide() {
    cancelHandleHide();
    handleHideTimer = setTimeout(hideHandle, HANDLE_HIDE_DELAY);
  }

  function cancelHandleHide() {
    if (handleHideTimer) {
      clearTimeout(handleHideTimer);
      handleHideTimer = null;
    }
  }

  function showHandleFor(el) {
    cancelHandleHide();
    if (handleTarget === el) return;
    handleTarget = el;

    const h = ensureHandle();
    collapseHandle();
    const rect = el.getBoundingClientRect();
    const left = Math.max(window.scrollX + 2, window.scrollX + rect.left - 30);
    h.root.style.left = left + "px";
    h.root.style.top = window.scrollY + rect.top + "px";
    h.root.style.display = "flex";
  }

  document.addEventListener("mouseover", (e) => {
    if (e.target.closest(".kana-master-handle")) {
      cancelHandleHide();
      return;
    }

    const block = e.target.closest?.(BLOCK_TARGETS);
    if (
      block &&
      !block.closest(
        ".kana-master-translation, .kana-master-grammar, .kana-master-debug, .kana-master-result-card, .kana-master-vocab-popup",
      ) &&
      block.textContent.trim().length >= 2 &&
      /\p{L}/u.test(block.textContent)
    ) {
      showHandleFor(block);
    } else if (handleTarget) {
      scheduleHandleHide();
    }
  });

  // Block-level streaming action: furigana applies in place, translation /
  // grammar go below the paragraph (paragraph-scope results live in the page,
  // unlike selection-scope results which live in the card).
  async function runBlockAction(el, mode) {
    const text = getTextWithoutRuby(el).trim();
    if (!text) return;
    if (mode === "annotate" && el.dataset.kanaAnnotated) return;

    const { debugMode } = await chrome.storage.sync.get("debugMode");
    const block = ensureBlockWrapper(el);

    let transDiv = null;
    if (mode === "both" || mode === "translate") {
      // Reuse the existing translation div so repeated clicks don't stack copies
      transDiv = block.querySelector(":scope > .kana-master-translation");
      if (!transDiv) {
        transDiv = document.createElement("div");
        transDiv.className = "kana-master-translation";
        block.appendChild(transDiv);
      }
      transDiv.textContent = "";
    }

    let grammarDiv = null;
    let grammarRaw = "";
    if (mode === "grammar") {
      grammarDiv = block.querySelector(":scope > .kana-master-grammar");
      if (!grammarDiv) {
        grammarDiv = document.createElement("div");
        grammarDiv.className = "kana-master-grammar";
        block.appendChild(grammarDiv);
      }
      grammarDiv.textContent = "";
    }

    const needsFurigana =
      (mode === "both" || mode === "annotate") && !el.dataset.kanaAnnotated;
    if (needsFurigana) el.classList.add("kana-master-loading");

    let streamMode = mode;
    if (mode === "both" && !needsFurigana) streamMode = "translate";
    if (streamMode === "translate" && !hasJapanese(text)) streamMode = "translateAny";

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
          if (debugMode) showDebugTokens(block, msg.rawTokens || msg.tokens, text);
        }
      }

      if (msg.type === "translationChunk" && transDiv) {
        transDiv.textContent += msg.text;
      }

      if (msg.type === "grammarChunk" && grammarDiv) {
        grammarRaw += msg.text;
        grammarDiv.innerHTML = renderMarkdown(grammarRaw);
      }

      if (msg.type === "allDone") {
        el.classList.remove("kana-master-loading");
        if (transDiv && !transDiv.textContent) transDiv.remove();
        else if (transDiv) el.dataset.kanaTranslated = "true";
        if (grammarDiv && !grammarRaw) grammarDiv.remove();
        port.disconnect();
      }

      if (msg.type === "error") {
        el.classList.remove("kana-master-loading");
        if (transDiv && !transDiv.textContent) transDiv.remove();
        if (grammarDiv && !grammarRaw) grammarDiv.remove();
        showError(el, msg.message);
        port.disconnect();
      }
    });

    port.postMessage({ type: "streamTranslate", paragraphs: [text], mode: streamMode, upgrade: false });
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
    if (message.type === "translatePage") {
      sendResponse(startPageTranslation());
      return false;
    }
  });

  // --- One-click full-page translation (any source language) ---

  let pageTranslatePort = null;

  function collectPageElements() {
    const container = findMainContent();
    if (!container) return [];

    const candidates = Array.from(container.querySelectorAll(TARGETS)).filter(
      (el) =>
        isLeafTextElement(el) &&
        el.textContent.trim().length >= 2 &&
        /\p{L}/u.test(el.textContent) &&
        !el.dataset.kanaTranslated &&
        !el.closest(
          ".kana-master-translation, .kana-master-grammar, .kana-master-debug, .kana-master-vocab-popup, .kana-master-actions, .kana-master-page-progress, .kana-master-result-card, .kana-master-handle",
        ) &&
        el.getClientRects().length > 0,
    );

    // Keep only outermost matches so nested elements aren't translated twice
    return candidates.filter(
      (el) => !candidates.some((other) => other !== el && other.contains(el)),
    );
  }

  function createProgressPill(onCancel) {
    const pill = document.createElement("div");
    pill.className = "kana-master-page-progress";

    const spinner = document.createElement("span");
    spinner.className = "kana-master-page-progress-spinner";

    const label = document.createElement("span");
    label.className = "kana-master-page-progress-label";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "✕";
    cancelBtn.title = csT("cancelTranslate");
    cancelBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    });

    pill.append(spinner, label, cancelBtn);
    document.body.appendChild(pill);
    return { pill, label, spinner };
  }

  function startPageTranslation() {
    if (pageTranslatePort) return { started: false, count: -1 };

    const elements = collectPageElements();
    if (elements.length === 0) return { started: false, count: 0 };

    const texts = elements.map((el) => getTextWithoutRuby(el).trim());
    // Japanese paragraphs get furigana + translation; everything else
    // gets translation only (no readings for non-Japanese text).
    const modes = elements.map((el, i) => {
      if (!hasJapanese(texts[i])) return "translateAny";
      return el.dataset.kanaAnnotated ? "translate" : "both";
    });

    const total = elements.length;
    const transDivs = new Array(total).fill(null);
    let targetLang = "zh-CN";
    let errorShown = false;

    const port = chrome.runtime.connect({ name: "kana-stream" });
    pageTranslatePort = port;

    const ui = createProgressPill(() => {
      port.disconnect();
      finish();
    });
    ui.label.textContent = `${csT("translating")} 0/${total}`;

    let finished = false;
    function finish() {
      finished = true;
      pageTranslatePort = null;
      ui.pill.remove();
    }

    function ensureTransDiv(i) {
      if (!transDivs[i]) {
        const block = ensureBlockWrapper(elements[i]);
        const div = document.createElement("div");
        div.className = "kana-master-translation";
        applyLangDir(div, targetLang);
        block.appendChild(div);
        transDivs[i] = div;
      }
      return transDivs[i];
    }

    port.onMessage.addListener((msg) => {
      if (msg.type === "langInfo") {
        targetLang = msg.targetLang;
      } else if (msg.type === "furigana") {
        const el = elements[msg.index];
        if (msg.tokens && msg.tokens.length > 0) {
          applyFuriganaPreservingStyle(el, msg.tokens);
          el.classList.add("kana-master-annotated");
          el.dataset.kanaAnnotated = "true";
        }
      } else if (msg.type === "translationChunk") {
        ensureTransDiv(msg.index).textContent += msg.text;
      } else if (msg.type === "translationDone") {
        // The model echoes back text that is already in the target language —
        // drop the redundant copy.
        const div = transDivs[msg.index];
        const norm = (s) => s.replace(/\s+/g, "");
        if (div && norm(div.textContent) === norm(texts[msg.index])) {
          div.remove();
          transDivs[msg.index] = null;
        }
        elements[msg.index].dataset.kanaTranslated = "true";
      } else if (msg.type === "error") {
        if (!errorShown) {
          errorShown = true;
          ui.pill.classList.add("kana-master-page-progress-error");
          ui.label.textContent = `Yomeru: ${msg.message}`;
        }
        const div = transDivs[msg.index];
        if (div && !div.textContent) div.remove();
      } else if (msg.type === "progress") {
        if (!errorShown) {
          ui.label.textContent = `${csT("translating")} ${msg.done}/${msg.total}`;
        }
      } else if (msg.type === "allDone") {
        port.disconnect();
        if (errorShown) {
          // Keep the error visible for a while, but allow a new run to start
          finished = true;
          ui.spinner.remove();
          pageTranslatePort = null;
          setTimeout(() => ui.pill.remove(), 6000);
        } else {
          finish();
        }
      }
    });

    // If the service worker dies mid-run, the port closes without allDone.
    // Without this, pageTranslatePort stays set forever and every later
    // attempt is silently rejected by the guard above until a page reload.
    port.onDisconnect.addListener(() => {
      if (finished) return;
      finished = true;
      pageTranslatePort = null;
      ui.spinner.remove();
      ui.pill.classList.add("kana-master-page-progress-error");
      ui.label.textContent = `Yomeru: ${csT("failed")}`;
      setTimeout(() => ui.pill.remove(), 6000);
    });

    port.postMessage({ type: "streamTranslate", paragraphs: texts, mode: "translate", modes });
    return { started: true, count: total };
  }

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
