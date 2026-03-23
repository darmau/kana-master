const vocabList = document.getElementById("vocabList");
const emptyState = document.getElementById("emptyState");
const searchInput = document.getElementById("searchInput");
const countText = document.getElementById("countText");
const clearAllBtn = document.getElementById("clearAllBtn");

let allWords = [];

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

function renderContexts(contexts) {
  if (!contexts || contexts.length === 0) return "";
  return contexts.map((ctx) => {
    const sourceLink = ctx.sourceUrl
      ? `<a class="context-source" href="${escapeHtml(ctx.sourceUrl)}" target="_blank" title="${escapeHtml(ctx.sourceUrl)}">source</a>`
      : "";
    return `<div class="vocab-context">
      <div class="vocab-context-text">${escapeHtml(ctx.text || "")}</div>
      ${ctx.translation ? `<div class="vocab-context-translation">${escapeHtml(ctx.translation)}</div>` : ""}
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
    conjHtml += renderConjugations("活用形", entry.conjugations);
  }
  if (entry.adjectiveConjugations) {
    conjHtml += renderConjugations("活用形", entry.adjectiveConjugations);
  }

  card.innerHTML = `
    <div class="vocab-card-header">
      <span class="vocab-word">${escapeHtml(entry.dictionaryForm || entry.word)}</span>
      <span class="vocab-reading">${escapeHtml(entry.reading || "")}</span>
      ${metaHtml}
    </div>
    ${showDictForm ? `<div class="vocab-original-form">${escapeHtml(entry.word)}</div>` : ""}
    ${entry.definition ? `<div class="vocab-word-translation">${escapeHtml(entry.definition)}</div>` : ""}
    ${conjHtml}
    <div class="vocab-contexts-section">
      ${renderContexts(entry.contexts)}
    </div>
    <div class="vocab-card-footer">
      <span class="vocab-date">${formatDate(entry.createdAt)}</span>
      <div class="vocab-card-actions">
        <span class="vocab-context-count">${(entry.contexts || []).length} 例文</span>
        <button class="vocab-delete">删除</button>
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
  countText.textContent = `${words.length} 词`;

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
  allWords = vocabulary;
  render(filterWords(searchInput.value));
}

async function deleteWord(id) {
  allWords = allWords.filter((e) => e.id !== id);
  await chrome.storage.local.set({ vocabulary: allWords });
  render(filterWords(searchInput.value));
}

async function clearAll() {
  if (!confirm("确定要删除全部生词吗？")) return;
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

clearAllBtn.addEventListener("click", clearAll);

loadWords();
