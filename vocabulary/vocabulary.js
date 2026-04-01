import { t, applyI18n } from "../lib/i18n.js";

const vocabList = document.getElementById("vocabList");
const emptyState = document.getElementById("emptyState");
const searchInput = document.getElementById("searchInput");
const countText = document.getElementById("countText");
const clearAllBtn = document.getElementById("clearAllBtn");
const exportBtn = document.getElementById("exportBtn");
const addWordInput = document.getElementById("addWordInput");
const addWordBtn = document.getElementById("addWordBtn");
const posFilter = document.getElementById("posFilter");

const PAGE_SIZE = 20;

let allWords = [];
let targetLang = "zh-CN";
let activePOS = null;
let currentPage = 1;

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

function renderContexts(contexts, word, entryId) {
  if (!contexts || contexts.length === 0) return "";
  return contexts.map((ctx, idx) => {
    let sourceHtml = "";
    if (ctx.manualAdd) {
      sourceHtml = `<span class="context-source context-manual">${t("manualAdd")}</span>`;
    } else if (ctx.sourceUrl) {
      sourceHtml = `<a class="context-source" href="${escapeHtml(ctx.sourceUrl)}" target="_blank" title="${escapeHtml(ctx.sourceUrl)}">${t("source")}</a>`;
    }
    return `<div class="vocab-context" data-entry-id="${entryId}" data-ctx-idx="${idx}">
      <div class="vocab-context-text">${highlightWord(ctx.text, word)}</div>
      ${ctx.translation ? `<div class="vocab-context-translation" lang="${targetLang}">${escapeHtml(ctx.translation)}</div>` : ""}
      <div class="vocab-context-meta">
        ${ctx.addedAt ? `<span class="context-date">${formatDate(ctx.addedAt)}</span>` : ""}
        ${sourceHtml}
      </div>
      <div class="context-actions">
        <button class="context-action-btn context-edit-btn" title="${t("editContext")}">${t("editContext")}</button>
        <button class="context-action-btn context-regenerate-btn" title="${t("regenerateExample")}">↻</button>
        <button class="context-action-btn context-delete-btn" title="${t("deleteContext")}">×</button>
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
      ${renderContexts(entry.contexts, entry.word, entry.id)}
    </div>
    <div class="vocab-card-footer">
      <span class="vocab-date">${formatDate(entry.createdAt)}</span>
      <div class="vocab-card-actions">
        <button class="vocab-generate-example">${t("generateExample")}</button>
        <span class="vocab-context-count">${t("nExamples", { n: (entry.contexts || []).length })}</span>
        <button class="vocab-delete">${t("delete")}</button>
      </div>
    </div>
  `;

  card.querySelector(".vocab-delete").addEventListener("click", () => deleteWord(entry.id));
  card.querySelector(".vocab-generate-example").addEventListener("click", (e) => generateNewExample(entry.id, entry.dictionaryForm || entry.word, e.target));

  // Context action buttons
  card.querySelectorAll(".vocab-context").forEach((ctxEl) => {
    const entryId = ctxEl.dataset.entryId;
    const ctxIdx = parseInt(ctxEl.dataset.ctxIdx, 10);
    ctxEl.querySelector(".context-edit-btn").addEventListener("click", () => startEditContext(entryId, ctxIdx, ctxEl));
    ctxEl.querySelector(".context-regenerate-btn").addEventListener("click", (e) => regenerateContext(entryId, ctxIdx, e.target));
    ctxEl.querySelector(".context-delete-btn").addEventListener("click", () => deleteContext(entryId, ctxIdx));
  });

  return card;
}

function render(words) {
  vocabList.innerHTML = "";
  removePagination();

  if (words.length === 0 && allWords.length === 0) {
    emptyState.hidden = false;
    clearAllBtn.hidden = true;
    countText.textContent = "";
    return;
  }
  emptyState.hidden = true;
  clearAllBtn.hidden = allWords.length === 0;
  exportBtn.hidden = allWords.length === 0;

  const totalPages = Math.max(1, Math.ceil(words.length / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;

  const start = (currentPage - 1) * PAGE_SIZE;
  const pageWords = words.slice(start, start + PAGE_SIZE);

  countText.textContent = t("nWords", { n: words.length });

  for (const entry of pageWords) {
    vocabList.appendChild(renderCard(entry));
  }

  if (totalPages > 1) {
    renderPagination(totalPages);
  }
}

function renderPagination(totalPages) {
  const bar = document.createElement("div");
  bar.className = "pagination-bar";
  bar.id = "paginationBar";

  const prevBtn = document.createElement("button");
  prevBtn.className = "pagination-btn";
  prevBtn.textContent = "←";
  prevBtn.disabled = currentPage <= 1;
  prevBtn.addEventListener("click", () => {
    currentPage--;
    applyFilters();
    vocabList.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  const info = document.createElement("span");
  info.className = "pagination-info";
  info.textContent = `${currentPage} / ${totalPages}`;

  const nextBtn = document.createElement("button");
  nextBtn.className = "pagination-btn";
  nextBtn.textContent = "→";
  nextBtn.disabled = currentPage >= totalPages;
  nextBtn.addEventListener("click", () => {
    currentPage++;
    applyFilters();
    vocabList.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  bar.appendChild(prevBtn);
  bar.appendChild(info);
  bar.appendChild(nextBtn);
  vocabList.after(bar);
}

function removePagination() {
  document.getElementById("paginationBar")?.remove();
}

function filterWords(query) {
  let words = allWords;
  if (activePOS) {
    words = words.filter((raw) => normalizeEntry(raw).partOfSpeech === activePOS);
  }
  if (!query) return words;
  const q = query.toLowerCase();
  return words.filter((rawEntry) => {
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

function buildPOSSidebar() {
  const counts = {};
  let total = 0;
  for (const raw of allWords) {
    const e = normalizeEntry(raw);
    const pos = e.partOfSpeech || "";
    if (pos) {
      counts[pos] = (counts[pos] || 0) + 1;
    }
    total++;
  }

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  posFilter.innerHTML = "";

  const allBtn = document.createElement("button");
  allBtn.className = `pos-filter-item${activePOS === null ? " active" : ""}`;
  allBtn.innerHTML = `${t("allWords")}<span class="pos-filter-count">${total}</span>`;
  allBtn.addEventListener("click", () => {
    activePOS = null;
    currentPage = 1;
    applyFilters();
  });
  posFilter.appendChild(allBtn);

  for (const [pos, count] of sorted) {
    const btn = document.createElement("button");
    btn.className = `pos-filter-item${activePOS === pos ? " active" : ""}`;
    btn.innerHTML = `${escapeHtml(pos)}<span class="pos-filter-count">${count}</span>`;
    btn.addEventListener("click", () => {
      activePOS = pos;
      currentPage = 1;
      applyFilters();
    });
    posFilter.appendChild(btn);
  }
}

function applyFilters() {
  buildPOSSidebar();
  render(filterWords(searchInput.value));
}

function startEditContext(entryId, ctxIdx, ctxEl) {
  if (ctxEl.querySelector(".context-edit-form")) return;
  const entry = normalizeEntry(allWords.find((e) => e.id === entryId));
  if (!entry) return;
  const ctx = entry.contexts[ctxIdx];
  if (!ctx) return;

  const textEl = ctxEl.querySelector(".vocab-context-text");
  const transEl = ctxEl.querySelector(".vocab-context-translation");
  const metaEl = ctxEl.querySelector(".vocab-context-meta");
  const actionsEl = ctxEl.querySelector(".context-actions");

  // Hide original content
  textEl.hidden = true;
  if (transEl) transEl.hidden = true;
  metaEl.hidden = true;
  actionsEl.hidden = true;

  const form = document.createElement("div");
  form.className = "context-edit-form";
  form.innerHTML = `
    <textarea class="edit-sentence" rows="2">${escapeHtml(ctx.text || "")}</textarea>
    <textarea class="edit-translation" rows="2">${escapeHtml(ctx.translation || "")}</textarea>
    <div class="edit-buttons">
      <button class="edit-save-btn">${t("saveEdit")}</button>
      <button class="edit-cancel-btn">${t("cancelEdit")}</button>
    </div>
  `;
  ctxEl.insertBefore(form, textEl);

  form.querySelector(".edit-save-btn").addEventListener("click", async () => {
    const newText = form.querySelector(".edit-sentence").value.trim();
    const newTrans = form.querySelector(".edit-translation").value.trim();
    if (!newText) return;
    await updateContext(entryId, ctxIdx, newText, newTrans);
  });

  form.querySelector(".edit-cancel-btn").addEventListener("click", () => {
    form.remove();
    textEl.hidden = false;
    if (transEl) transEl.hidden = false;
    metaEl.hidden = false;
    actionsEl.hidden = false;
  });
}

function ensureNormalized(raw) {
  if (!raw.contexts) {
    const normalized = normalizeEntry(raw);
    Object.assign(raw, normalized);
  }
}

async function updateContext(entryId, ctxIdx, newText, newTranslation) {
  const raw = allWords.find((e) => e.id === entryId);
  if (!raw) return;
  ensureNormalized(raw);
  if (!raw.contexts[ctxIdx]) return;

  raw.contexts[ctxIdx].text = newText;
  raw.contexts[ctxIdx].translation = newTranslation;
  await chrome.storage.local.set({ vocabulary: allWords });
  applyFilters();
}

async function deleteContext(entryId, ctxIdx) {
  if (!confirm(t("confirmDeleteContext"))) return;
  const raw = allWords.find((e) => e.id === entryId);
  if (!raw) return;
  ensureNormalized(raw);
  raw.contexts.splice(ctxIdx, 1);
  await chrome.storage.local.set({ vocabulary: allWords });
  applyFilters();
}

async function regenerateContext(entryId, ctxIdx, btn) {
  const raw = allWords.find((e) => e.id === entryId);
  if (!raw) return;
  ensureNormalized(raw);
  const word = raw.dictionaryForm || raw.word;

  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = "...";

  try {
    const response = await chrome.runtime.sendMessage({
      type: "generateVocabEntry",
      word,
      sentence: "",
    });

    if (response?.generatedSentence) {
      raw.contexts[ctxIdx].text = response.generatedSentence;
      raw.contexts[ctxIdx].translation = response.sentenceTranslation || "";
      await chrome.storage.local.set({ vocabulary: allWords });
      applyFilters();
    }
  } catch {
    // silently fail
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

async function generateNewExample(entryId, word, btn) {
  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = t("generating");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "generateVocabEntry",
      word,
      sentence: "",
    });

    if (response?.generatedSentence) {
      const raw = allWords.find((e) => e.id === entryId);
      if (!raw) return;
      ensureNormalized(raw);
      raw.contexts.push({
        text: response.generatedSentence,
        translation: response.sentenceTranslation || "",
        sourceUrl: "",
        manualAdd: true,
        addedAt: Date.now(),
      });
      await chrome.storage.local.set({ vocabulary: allWords });
      applyFilters();
    }
  } catch {
    // silently fail
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

async function loadWords() {
  const { vocabulary = [] } = await chrome.storage.local.get("vocabulary");
  const settings = await chrome.storage.sync.get("targetLang");
  targetLang = settings.targetLang || "zh-CN";
  allWords = vocabulary;
  applyFilters();
}

async function deleteWord(id) {
  allWords = allWords.filter((e) => e.id !== id);
  await chrome.storage.local.set({ vocabulary: allWords });
  applyFilters();
}

async function clearAll() {
  if (!confirm(t("confirmDeleteAll"))) return;
  allWords = [];
  activePOS = null;
  await chrome.storage.local.set({ vocabulary: [] });
  applyFilters();
}

let searchTimer = null;
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { currentPage = 1; applyFilters(); }, 200);
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
        const generatedSentence = response.generatedSentence || "";
        const contexts = generatedSentence
          ? [{ text: generatedSentence, translation: response.sentenceTranslation || "", sourceUrl: "", manualAdd: true, addedAt: Date.now() }]
          : [];
        const entry = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          word: data.originalText || word,
          dictionaryForm: dictForm,
          reading: data.reading || "",
          partOfSpeech: data.partOfSpeech || "",
          definition: data.definition || "",
          contexts,
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
    applyFilters();
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
