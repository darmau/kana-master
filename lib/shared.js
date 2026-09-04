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

  function makeId(prefix = "") {
    const rand = Math.random().toString(36).slice(2).padEnd(5, "0").slice(0, 5);
    return `${prefix}${Date.now().toString(36)}${rand}`;
  }

  const KANA_RE = /[぀-ゟ゠-ヿ]/;
  const CJK_RE = /[一-龯]/;

  function hasKana(text) {
    return KANA_RE.test(text);
  }

  function hasCJK(text) {
    return CJK_RE.test(text);
  }

  // Kana is the only unambiguous marker of Japanese; kanji alone is shared with
  // Chinese. So a fragment counts as Japanese if it contains kana, or if it is
  // kanji inside a document already established as Japanese — which is what
  // lets a heading like 「経済対策」 be annotated without treating a whole
  // Chinese page as Japanese.
  function makeJapaneseDetector(docIsJapanese) {
    return (text) => hasKana(text) || (docIsJapanese && hasCJK(text));
  }

  // Default detector for callers that have no document context.
  function hasJapanese(text) {
    return hasKana(text) || hasCJK(text);
  }

  // Tag a result element with its language so the per-language font stacks apply,
  // and flip direction for RTL targets.
  function applyLangDir(el, targetLang) {
    if (!targetLang) return;
    el.lang = targetLang;
    if (targetLang === "ar") {
      el.dir = "rtl";
      el.style.textAlign = "right";
    } else {
      el.removeAttribute("dir");
      el.style.textAlign = "";
    }
  }

  // --- Minimal Markdown renderer (grammar analysis output) ---

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

      const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        closeLists();
        const level = headingMatch[1].length;
        html += `<h${level + 3}>${inlineFormat(headingMatch[2])}</h${level + 3}>`;
        continue;
      }

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

      if (!line.trim()) {
        closeLists();
        continue;
      }

      closeLists();
      html += `<p>${inlineFormat(line)}</p>`;
    }

    closeLists();
    return html;
  }

  // --- Action buttons (selection toolbar, paragraph handle, reader block menu) ---

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

  // `label` turns the icon button into an icon+text menu item (reader block menu).
  function makeActionButton(icon, title, extraClass, onClick, label) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = icon;
    btn.title = title;
    if (extraClass) btn.className = extraClass;
    if (label) {
      const span = document.createElement("span");
      span.className = "kana-action-label";
      span.textContent = label;
      btn.appendChild(span);
    }
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick(btn);
    });
    return btn;
  }

  // --- Vocabulary ---

  // Ask the service worker to analyse `word`, then merge the result into the
  // vocabulary list: an entry that already exists under the same dictionary form
  // gains another context sentence instead of a duplicate row.
  async function saveVocabEntry({ word, reading = "", context = "", sourceUrl = "" }) {
    const response = await chrome.runtime.sendMessage({
      type: "generateVocabEntry",
      word,
      sentence: context,
    });

    const { vocabulary = [] } = await chrome.storage.local.get("vocabulary");
    // When the model had to invent an example sentence it belongs to no page,
    // so it carries no source URL and is flagged as manually added.
    const isGenerated = !!response?.generatedSentence;
    const entryContext = {
      text: response?.generatedSentence || context,
      translation: response?.sentenceTranslation || "",
      sourceUrl: isGenerated ? "" : sourceUrl,
      manualAdd: isGenerated || undefined,
      addedAt: Date.now(),
    };

    const fallback = !!(response?.error || !response?.entry);
    let status = "created";

    if (fallback) {
      vocabulary.unshift({
        id: makeId(),
        word,
        dictionaryForm: word,
        reading,
        partOfSpeech: "",
        definition: "",
        contexts: [entryContext],
        createdAt: Date.now(),
      });
    } else {
      const data = response.entry;
      const dictForm = data.dictionaryForm || word;
      const existing = vocabulary.find((e) => e.dictionaryForm === dictForm);
      if (existing) {
        existing.contexts = existing.contexts || [];
        existing.contexts.push(entryContext);
        status = "merged";
      } else {
        const entry = {
          id: makeId(),
          word: data.originalText || word,
          dictionaryForm: dictForm,
          reading: data.reading || reading,
          partOfSpeech: data.partOfSpeech || "",
          definition: data.definition || "",
          contexts: [entryContext],
          createdAt: Date.now(),
        };
        for (const field of [
          "verbType",
          "verbTransitivity",
          "conjugations",
          "adjectiveType",
          "adjectiveConjugations",
        ]) {
          if (data[field]) entry[field] = data[field];
        }
        vocabulary.unshift(entry);
      }
    }

    await chrome.storage.local.set({ vocabulary });
    return { status, fallback };
  }

  function positionPopupBelow(popup, rect) {
    const width = popup.offsetWidth || 180;
    const left = Math.min(rect.left + window.scrollX, window.innerWidth - width);
    popup.style.top = `${window.scrollY + rect.bottom + 8}px`;
    popup.style.left = `${Math.max(0, left)}px`;
  }

  // `labels` supplies the caller's own translations (the content script and the
  // extension pages reach chrome.i18n through different helpers). `extraButtons`
  // are rendered before Save — the content script uses one to write furigana
  // back into the host page, which only makes sense there.
  function showVocabPopup({
    rootClass,
    word,
    reading,
    context,
    sourceUrl,
    rect,
    labels,
    extraButtons = [],
  }) {
    const popup = document.createElement("div");
    popup.className = rootClass;

    const wordEl = document.createElement("div");
    wordEl.className = "kana-vocab-word";
    wordEl.textContent = word;
    popup.appendChild(wordEl);

    if (reading && reading !== word) {
      const readingEl = document.createElement("div");
      readingEl.className = "kana-vocab-reading";
      readingEl.textContent = reading;
      popup.appendChild(readingEl);
    }

    for (const extra of extraButtons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = extra.className;
      btn.textContent = extra.label;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        extra.onClick(btn, popup);
      });
      popup.appendChild(btn);
    }

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "kana-vocab-save";
    saveBtn.textContent = labels.save;
    saveBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      saveBtn.disabled = true;
      saveBtn.textContent = "...";
      try {
        await saveVocabEntry({ word, reading, context, sourceUrl });
        saveBtn.textContent = labels.added;
        saveBtn.classList.add("saved");
        setTimeout(() => popup.remove(), 800);
      } catch {
        saveBtn.textContent = labels.failed;
        saveBtn.disabled = false;
      }
    });
    popup.appendChild(saveBtn);

    document.body.appendChild(popup);
    positionPopupBelow(popup, rect);
    return popup;
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

  // True when hostname is covered by any blacklist pattern. A pattern matches
  // its own domain and every subdomain ("example.com" also covers
  // "sub.example.com"). Patterns are stored normalized (bare lowercase
  // hostnames — see options.js), but lowercase defensively anyway.
  function isHostBlacklisted(hostname, patterns) {
    const host = hostname.toLowerCase();
    return patterns.some((p) => {
      const pat = String(p).toLowerCase();
      return pat && (host === pat || host.endsWith("." + pat));
    });
  }

  globalThis.KanaShared = {
    escapeHtml,
    tokensToHtml,
    formatDate,
    formatShortDate,
    makeId,
    hasKana,
    hasCJK,
    hasJapanese,
    makeJapaneseDetector,
    applyLangDir,
    renderMarkdown,
    ICONS,
    makeActionButton,
    saveVocabEntry,
    positionPopupBelow,
    showVocabPopup,
    extractFromSelection,
    getWordFromRuby,
    extractSentence,
    isHostBlacklisted,
  };
})();
