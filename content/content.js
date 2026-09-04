(() => {
  // Shared DOM helpers (loaded via lib/shared.js before this script \u2014 see manifest).
  // getTextWithoutRuby stays local: the content script also strips <code>.
  const {
    escapeHtml,
    hasKana,
    makeJapaneseDetector,
    applyLangDir,
    renderMarkdown,
    ICONS,
    makeActionButton,
    showVocabPopup,
    extractFromSelection,
    getWordFromRuby,
    extractSentence,
    isHostBlacklisted,
  } = globalThis.KanaShared;

  const TARGETS =
    "p, li, td, th, blockquote, h1, h2, h3, h4, h5, h6, figcaption, span, div";
  let selectionToolbar = null;
  let toolbarRange = null;

  // Kanji-only text is ambiguous between Japanese and Chinese, so decide from
  // the document: an explicit lang wins, otherwise look for kana anywhere.
  const docIsJapanese = (() => {
    const lang = (document.documentElement.lang || "").toLowerCase();
    if (lang.startsWith("ja")) return true;
    if (lang.startsWith("zh")) return false;
    return hasKana(document.body?.textContent || "");
  })();
  const hasJapanese = makeJapaneseDetector(docIsJapanese);

  // --- i18n for content script (uses Chrome's native _locales) ---
  function csT(key) {
    return chrome.i18n.getMessage(key) || key;
  }

  // --- Site blacklist: on user-listed domains the extension stays inert ---
  // (no toolbar / handle / vocab popup, and popup-triggered actions are
  // refused). Toggling the list takes effect immediately, no reload needed.

  let siteDisabled = false;

  function updateSiteDisabled(blacklist) {
    siteDisabled =
      Array.isArray(blacklist) && isHostBlacklisted(location.hostname, blacklist);
    if (siteDisabled) {
      // Drop any of our UI that is already on screen. Annotations and
      // translations the user asked for earlier stay in the page.
      removeSelectionToolbar();
      removeResultCard();
      hideHandle();
      document.querySelector(".kana-master-vocab-popup")?.remove();
    }
  }

  chrome.storage.sync.get("blacklist", ({ blacklist }) => updateSiteDisabled(blacklist));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.blacklist) updateSiteDisabled(changes.blacklist.newValue);
  });

  const BLOCK_TARGETS =
    "p, li, td, th, blockquote, h1, h2, h3, h4, h5, h6, figcaption";

  function isLeafTextElement(el) {
    const dominated = el.querySelectorAll(BLOCK_TARGETS);
    return dominated.length === 0 || el.textContent.length < 200;
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

    bar.appendChild(
      makeActionButton(ICONS.reader, csT("openInReaderTooltip"), "", (btn) => {
        const r = toolbarRange;
        removeSelectionToolbar();
        openSelectionInReader(r, btn);
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

  // Send a selection to the reader. The service worker creates the session,
  // because lib/reader-store.js is an ES module this IIFE cannot import.
  async function openSelectionInReader(range, btn) {
    if (!range) return;
    let content = extractBlocksFrom(range.cloneContents());
    if (content.length === 0) {
      content = range
        .toString()
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((text) => ({ tag: "p", text }));
    }
    if (content.length === 0) return;

    try {
      const response = await chrome.runtime.sendMessage({
        type: "openInReader",
        title: pickTitle(findMainContent()),
        url: location.href,
        content,
      });
      if (response?.error) throw new Error(response.error);
    } catch (err) {
      showError(btn, err.message);
    }
  }

  function removeSelectionToolbar() {
    if (selectionToolbar) {
      selectionToolbar.remove();
      selectionToolbar = null;
    }
    toolbarRange = null;
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
      if (siteDisabled) return;
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
    if (siteDisabled) return;
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

  // Rewrites the user's selection in the host page with ruby markup. Page
  // surgery like this only makes sense in the content script, so it stays here
  // and is handed to the shared popup as an extra button.
  async function annotateWordInSelection(btn, popup, word, selectionRange) {
    btn.disabled = true;
    btn.textContent = "...";

    try {
      const response = await chrome.runtime.sendMessage({ type: "annotate", text: word });
      if (response.error) throw new Error(response.error);

      const tokens = response.furigana;
      if (!tokens || tokens.length === 0) {
        btn.textContent = csT("failed");
        btn.disabled = false;
        return;
      }

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

      btn.textContent = csT("added");
      btn.classList.add("done");
      setTimeout(() => popup.remove(), 800);
    } catch {
      btn.textContent = csT("failed");
      btn.disabled = false;
    }
  }

  function showVocabPopupAt(word, reading, context, rect, selectionRange) {
    showVocabPopup({
      rootClass: "kana-master-vocab-popup",
      word,
      reading,
      context,
      sourceUrl: location.href,
      rect,
      labels: { save: csT("addToVocab"), added: csT("added"), failed: csT("failed") },
      extraButtons: selectionRange
        ? [
            {
              className: "kana-vocab-annotate",
              label: csT("annotateWord"),
              onClick: (btn, popup) => annotateWordInSelection(btn, popup, word, selectionRange),
            },
          ]
        : [],
    });
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
    copyBtn.textContent = csT("copy");
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(json).then(() => {
        copyBtn.textContent = csT("copied");
        setTimeout(() => (copyBtn.textContent = csT("copy")), 1500);
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
    if (siteDisabled) return;
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
    if (siteDisabled) {
      sendResponse({ disabled: true });
      return false;
    }
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

  const EXTRACT_TAGS = new Set([
    "P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "BLOCKQUOTE", "FIGCAPTION", "PRE",
  ]);
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NAV", "FOOTER", "ASIDE", "NOSCRIPT"]);
  const NESTED_BLOCKS = "p, li, blockquote, pre, h1, h2, h3, h4, h5, h6";

  // innerText honours <br> as a line break and skips hidden text, which matters
  // for lyrics and poetry. It needs layout, so fall back to textContent when it
  // comes back empty (a detached fragment, or a hidden container).
  function blockText(node) {
    return (node.innerText || node.textContent || "").replace(/\n{2,}/g, "\n").trim();
  }

  // A container's own text with nested blocks removed, so <li>Intro<ul>…</ul></li>
  // keeps "Intro" without swallowing the nested items.
  function ownText(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll(NESTED_BLOCKS).forEach((n) => n.remove());
    return (clone.textContent || "").replace(/\n{2,}/g, "\n").trim();
  }

  function extractBlocksFrom(root) {
    const content = [];
    const seen = new Set();
    let sealed = null;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
        // FILTER_ACCEPT still descends, which is why the old walker emitted
        // <li><p>text</p></li> twice. Only FILTER_REJECT prunes, and a
        // TreeWalker visits all of X's descendants right after X, so tracking
        // the last leaf we accepted is enough.
        if (sealed && sealed.contains(node)) return NodeFilter.FILTER_REJECT;
        return EXTRACT_TAGS.has(node.tagName)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    });

    let node;
    while ((node = walker.nextNode())) {
      const nested = node.querySelector(NESTED_BLOCKS);
      const text = nested ? ownText(node) : blockText(node);
      if (!nested) sealed = node;
      if (!text || text.length < 2 || seen.has(text)) continue;
      seen.add(text);
      content.push({ tag: node.tagName.toLowerCase(), text });
    }

    return content;
  }

  // "記事タイトル | サイト名" -> "記事タイトル"
  function stripSiteSuffix(title) {
    const siteName = document
      .querySelector('meta[property="og:site_name"]')
      ?.content?.trim()
      .toLowerCase();
    const parts = title.split(/\s+[|\u2013\u2014-]\s+|｜|\s+::\s+/).filter(Boolean);
    if (parts.length < 2) return title.trim();
    const kept = siteName
      ? parts.filter((part) => part.trim().toLowerCase() !== siteName)
      : parts;
    return (kept.length ? kept : parts).sort((a, b) => b.length - a.length)[0].trim();
  }

  function pickTitle(container) {
    const heading =
      [...(container?.querySelectorAll("h1") || [])].find((h) => h.textContent.trim()) ||
      [...document.querySelectorAll("h1")].find((h) => h.textContent.trim());
    if (heading) return heading.textContent.trim();

    const ogTitle = document.querySelector('meta[property="og:title"]')?.content?.trim();
    return stripSiteSuffix(ogTitle || document.title || "");
  }

  function extractContent() {
    const container = findMainContent();
    if (!container) return { error: "Could not find main content area" };

    const title = pickTitle(container);
    const content = extractBlocksFrom(container).filter(
      // The reader shows the title above the body already.
      (item) => !(item.tag === "h1" && item.text === title)
    );
    return { title, url: location.href, content };
  }

  // Score by the text actually inside block elements, ignoring page chrome, so
  // a page with several <article>s (a post plus its comments) picks the real one
  // instead of whichever came first in the DOM.
  function scoreCandidate(el) {
    let total = 0;
    for (const block of el.querySelectorAll(NESTED_BLOCKS)) {
      if (block.closest("nav, footer, aside, header, form")) continue;
      total += block.textContent.trim().length;
    }
    return total;
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

    let best = null;
    let bestScore = 0;
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.closest("nav, footer, aside, header")) continue;
        const score = scoreCandidate(el);
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
    }
    if (best && bestScore >= 200) return best;

    // No usable landmark: fall back to the densest block of text on the page.
    let densest = document.body;
    let densestScore = 0;
    document.querySelectorAll("div, section").forEach((el) => {
      const text = el.textContent || "";
      const childCount = el.children.length;
      if (childCount === 0) return;
      const density = text.length / childCount;
      if (density > densestScore && text.length > 200) {
        densestScore = density;
        densest = el;
      }
    });
    return best || densest;
  }

})();
