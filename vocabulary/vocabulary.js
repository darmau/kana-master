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

function renderCard(entry) {
  const card = document.createElement("div");
  card.className = "vocab-card";
  card.dataset.id = entry.id;

  let contextHtml = "";
  if (entry.context) {
    contextHtml = `<div class="vocab-context">
      <div class="vocab-context-text">${escapeHtml(entry.context)}</div>
      ${entry.contextTranslation ? `<div class="vocab-context-translation">${escapeHtml(entry.contextTranslation)}</div>` : ""}
    </div>`;
  }

  card.innerHTML = `
    <div class="vocab-card-header">
      <span class="vocab-word">${escapeHtml(entry.word)}</span>
      <span class="vocab-reading">${escapeHtml(entry.reading || "")}</span>
    </div>
    ${entry.wordTranslation ? `<div class="vocab-word-translation">${escapeHtml(entry.wordTranslation)}</div>` : ""}
    ${contextHtml}
    <div class="vocab-card-footer">
      <span class="vocab-date">${formatDate(entry.createdAt)}</span>
      <button class="vocab-delete">删除</button>
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
  return allWords.filter(
    (e) =>
      e.word.toLowerCase().includes(q) ||
      (e.reading || "").toLowerCase().includes(q) ||
      (e.wordTranslation || "").toLowerCase().includes(q) ||
      (e.context || "").toLowerCase().includes(q) ||
      (e.contextTranslation || "").toLowerCase().includes(q)
  );
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
