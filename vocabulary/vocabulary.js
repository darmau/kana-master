import { t, applyI18n } from "../lib/i18n.js";

const vocabList = document.getElementById("vocabList");
const emptyState = document.getElementById("emptyState");
const searchInput = document.getElementById("searchInput");
const countText = document.getElementById("countText");
const clearAllBtn = document.getElementById("clearAllBtn");
const exportBtn = document.getElementById("exportBtn");
const addWordInput = document.getElementById("addWordInput");
const addWordBtn = document.getElementById("addWordBtn");

let allWords = [];
let targetLang = "zh-CN";

applyI18n();
document.title = `${t("vocabTitle")} - 読める`;

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
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

function renderConjugations(label, obj) {
  if (!obj || Object.keys(obj).length === 0) return "";
  const items = Object.entries(obj)
    .map(([k, v]) => `<span class="conj-item"><span class="conj-label">${escapeHtml(k)}</span> ${escapeHtml(v)}</span>`)
    .join("");
  return `<div class="vocab-conjugations"><span class="conj-title">${escapeHtml(label)}</span><div class="conj-list">${items}</div></div>`;
}

function highlightWord(text, word) {
  if (!word || !text) return escapeHtml(text || "");
  const idx = text.indexOf(word);
  if (idx === -1) return escapeHtml(text);
  return escapeHtml(text.slice(0, idx)) +
    `<mark class="vocab-highlight">${escapeHtml(word)}</mark>` +
    escapeHtml(text.slice(idx + word.length));
}

function renderContexts(contexts, word) {
  if (!contexts || contexts.length === 0) return "";
  return contexts.map((ctx) => {
    const sourceLink = ctx.sourceUrl
      ? `<a class="context-source" href="${escapeHtml(ctx.sourceUrl)}" target="_blank" title="${escapeHtml(ctx.sourceUrl)}">${t("source")}</a>`
      : "";
    return `<div class="vocab-context">
      <div class="vocab-context-text">${highlightWord(ctx.text, word)}</div>
      ${ctx.translation ? `<div class="vocab-context-translation" lang="${targetLang}">${escapeHtml(ctx.translation)}</div>` : ""}
      <div class="vocab-context-meta">
        ${ctx.addedAt ? `<span class="context-date">${formatDate(ctx.addedAt)}</span>` : ""}
        ${sourceLink}
      </div>
    </div>`;
  }).join("");
}

// Backward compatibility: convert old format entries to new format
function normalizeEntry(entry) {
  if (entry.contexts) return entry;
  // Old format: single context/contextTranslation fields
  const ctx = {};
  if (entry.context) ctx.text = entry.context;
  if (entry.contextTranslation) ctx.translation = entry.contextTranslation;
  ctx.addedAt = entry.createdAt;
  return {
    ...entry,
    dictionaryForm: entry.dictionaryForm || entry.word,
    reading: entry.reading || "",
    partOfSpeech: entry.partOfSpeech || "",
    definition: entry.definition || entry.wordTranslation || "",
    contexts: ctx.text ? [ctx] : [],
  };
}

function renderCard(rawEntry) {
  const entry = normalizeEntry(rawEntry);
  const card = document.createElement("div");
  card.className = "vocab-card";
  card.dataset.id = entry.id;

  const showDictForm = entry.dictionaryForm && entry.dictionaryForm !== entry.word;

  let metaHtml = "";
  if (entry.partOfSpeech) {
    metaHtml += `<span class="vocab-pos">${escapeHtml(entry.partOfSpeech)}</span>`;
  }
  if (entry.verbType) {
    metaHtml += `<span class="vocab-pos vocab-pos-sub">${escapeHtml(entry.verbType)}</span>`;
  }
  if (entry.adjectiveType) {
    metaHtml += `<span class="vocab-pos vocab-pos-sub">${escapeHtml(entry.adjectiveType)}</span>`;
  }

  let conjHtml = "";
  if (entry.conjugations) {
    conjHtml += renderConjugations(t("conjugation"), entry.conjugations);
  }
  if (entry.adjectiveConjugations) {
    conjHtml += renderConjugations(t("conjugation"), entry.adjectiveConjugations);
  }

  card.innerHTML = `
    <div class="vocab-card-header">
      <span class="vocab-word">${escapeHtml(entry.dictionaryForm || entry.word)}</span>
      <span class="vocab-reading">${escapeHtml(entry.reading || "")}</span>
      ${metaHtml}
    </div>
    ${showDictForm ? `<div class="vocab-original-form">${escapeHtml(entry.word)}</div>` : ""}
    ${entry.definition ? `<div class="vocab-word-translation" lang="${targetLang}">${escapeHtml(entry.definition)}</div>` : ""}
    ${conjHtml}
    <div class="vocab-contexts-section">
      ${renderContexts(entry.contexts, entry.word)}
    </div>
    <div class="vocab-card-footer">
      <span class="vocab-date">${formatDate(entry.createdAt)}</span>
      <div class="vocab-card-actions">
        <span class="vocab-context-count">${t("nExamples", { n: (entry.contexts || []).length })}</span>
        <button class="vocab-delete">${t("delete")}</button>
      </div>
    </div>
  `;

  card.querySelector(".vocab-delete").addEventListener("click", () => deleteWord(entry.id));
  return card;
}

function render(words) {
  vocabList.innerHTML = "";
  if (words.length === 0 && allWords.length === 0) {
    emptyState.hidden = false;
    clearAllBtn.hidden = true;
    countText.textContent = "";
    return;
  }
  emptyState.hidden = true;
  clearAllBtn.hidden = allWords.length === 0;
  exportBtn.hidden = allWords.length === 0;
  countText.textContent = t("nWords", { n: words.length });

  for (const entry of words) {
    vocabList.appendChild(renderCard(entry));
  }
}

function filterWords(query) {
  if (!query) return allWords;
  const q = query.toLowerCase();
  return allWords.filter((rawEntry) => {
    const e = normalizeEntry(rawEntry);
    return (
      e.word.toLowerCase().includes(q) ||
      (e.dictionaryForm || "").toLowerCase().includes(q) ||
      (e.reading || "").toLowerCase().includes(q) ||
      (e.definition || "").toLowerCase().includes(q) ||
      (e.partOfSpeech || "").toLowerCase().includes(q) ||
      (e.contexts || []).some(
        (ctx) =>
          (ctx.text || "").toLowerCase().includes(q) ||
          (ctx.translation || "").toLowerCase().includes(q)
      )
    );
  });
}

async function loadWords() {
  const { vocabulary = [] } = await chrome.storage.local.get("vocabulary");
  const settings = await chrome.storage.sync.get("targetLang");
  targetLang = settings.targetLang || "zh-CN";
  allWords = vocabulary;
  render(filterWords(searchInput.value));
}

async function deleteWord(id) {
  allWords = allWords.filter((e) => e.id !== id);
  await chrome.storage.local.set({ vocabulary: allWords });
  render(filterWords(searchInput.value));
}

async function clearAll() {
  if (!confirm(t("confirmDeleteAll"))) return;
  allWords = [];
  await chrome.storage.local.set({ vocabulary: [] });
  render([]);
}

let searchTimer = null;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    render(filterWords(searchInput.value));
  }, 200);
});

function exportVocabulary() {
  const data = allWords.map(normalizeEntry);
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `yomeru-vocabulary-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function addWordManually() {
  const word = addWordInput.value.trim();
  if (!word) return;

  addWordBtn.disabled = true;
  addWordInput.disabled = true;
  addWordBtn.textContent = "...";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "generateVocabEntry",
      word,
      sentence: "",
    });

    const { vocabulary = [] } = await chrome.storage.local.get("vocabulary");

    if (response?.entry && !response.error) {
      const data = response.entry;
      const dictForm = data.dictionaryForm || word;

      const existing = vocabulary.find((e) => e.dictionaryForm === dictForm);
      if (!existing) {
        const entry = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          word: data.originalText || word,
          dictionaryForm: dictForm,
          reading: data.reading || "",
          partOfSpeech: data.partOfSpeech || "",
          definition: data.definition || "",
          contexts: [],
          createdAt: Date.now(),
        };
        if (data.verbType) entry.verbType = data.verbType;
        if (data.conjugations) entry.conjugations = data.conjugations;
        if (data.adjectiveType) entry.adjectiveType = data.adjectiveType;
        if (data.adjectiveConjugations) entry.adjectiveConjugations = data.adjectiveConjugations;
        vocabulary.unshift(entry);
      }
    } else {
      // Fallback: save with minimal info
      const existing = vocabulary.find((e) => e.dictionaryForm === word || e.word === word);
      if (!existing) {
        vocabulary.unshift({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          word,
          dictionaryForm: word,
          reading: "",
          partOfSpeech: "",
          definition: "",
          contexts: [],
          createdAt: Date.now(),
        });
      }
    }

    await chrome.storage.local.set({ vocabulary });
    allWords = vocabulary;
    render(filterWords(searchInput.value));
    addWordInput.value = "";
  } catch {
    // silently fail
  } finally {
    addWordBtn.disabled = false;
    addWordInput.disabled = false;
    addWordBtn.textContent = t("addWord");
  }
}

addWordBtn.addEventListener("click", addWordManually);
addWordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addWordManually();
});

clearAllBtn.addEventListener("click", clearAll);
exportBtn.addEventListener("click", exportVocabulary);

loadWords();
