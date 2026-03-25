import { t, applyI18n } from "../lib/i18n.js";

const historyList = document.getElementById("historyList");
const emptyState = document.getElementById("emptyState");
const countText = document.getElementById("countText");
const clearAllBtn = document.getElementById("clearAllBtn");
const chartContainer = document.getElementById("chartContainer");

let allHistory = [];

applyI18n();
document.title = `${t("historyTitle")} - 読める`;

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

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function difficultyClass(d) {
  if (d <= 3) return "difficulty-easy";
  if (d <= 6) return "difficulty-medium";
  return "difficulty-hard";
}

function renderCard(entry) {
  const card = document.createElement("div");
  card.className = "history-card";
  card.dataset.id = entry.id;

  const titleLink = entry.url && entry.url !== "#"
    ? `<a href="${escapeHtml(entry.url)}" target="_blank">${escapeHtml(entry.title || "Untitled")}</a>`
    : escapeHtml(entry.title || "Untitled");

  card.innerHTML = `
    <div class="history-card-main">
      <div class="history-card-title">${titleLink}</div>
      <div class="history-card-meta">
        <span>${formatDate(entry.timestamp)}</span>
        <span class="difficulty-badge ${difficultyClass(entry.difficulty)}">Lv.${entry.difficulty}</span>
        <span>${entry.timeTaken}s</span>
        <button class="history-delete">${t("delete")}</button>
      </div>
    </div>
    <div class="history-card-stats">
      <div class="history-stat">
        <div class="history-stat-value correct">${entry.correct}/${entry.total}</div>
        <div class="history-stat-label">${t("quizScore", { correct: entry.correct, total: entry.total })}</div>
      </div>
      <div class="history-stat">
        <div class="history-stat-value score">${entry.progressScore}</div>
        <div class="history-stat-label">${t("progressScore")}</div>
      </div>
    </div>
  `;

  card.querySelector(".history-delete").addEventListener("click", () => deleteEntry(entry.id));
  return card;
}

function render(history) {
  historyList.innerHTML = "";

  if (history.length === 0 && allHistory.length === 0) {
    emptyState.hidden = false;
    clearAllBtn.hidden = true;
    countText.textContent = "";
    chartContainer.hidden = true;
    return;
  }

  emptyState.hidden = true;
  clearAllBtn.hidden = allHistory.length === 0;
  countText.textContent = `${history.length} quizzes`;

  for (const entry of history) {
    historyList.appendChild(renderCard(entry));
  }

  renderChart(allHistory);
}

// --- SVG Chart ---

function renderChart(history) {
  // Need at least 2 entries sorted chronologically for a meaningful chart
  const sorted = [...history].sort((a, b) => a.timestamp - b.timestamp);
  if (sorted.length < 2) {
    chartContainer.hidden = true;
    return;
  }
  chartContainer.hidden = false;

  const svg = document.getElementById("progressChart");
  const W = 600, H = 200, PAD_L = 36, PAD_R = 16, PAD_T = 16, PAD_B = 28;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

  const scores = sorted.map((h) => h.progressScore);
  const maxScore = 100;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const points = scores.map((s, i) => ({
    x: PAD_L + (scores.length === 1 ? plotW / 2 : (i / (scores.length - 1)) * plotW),
    y: PAD_T + plotH - (s / maxScore) * plotH,
  }));

  let svgContent = "";

  // Grid lines and Y-axis labels
  for (const v of [0, 25, 50, 75, 100]) {
    const y = PAD_T + plotH - (v / maxScore) * plotH;
    svgContent += `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="#f0f0f0" stroke-width="1"/>`;
    svgContent += `<text x="${PAD_L - 6}" y="${y + 4}" text-anchor="end" font-size="10" fill="#bbb" font-family="-apple-system,sans-serif">${v}</text>`;
  }

  // Axes
  svgContent += `<line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${H - PAD_B}" stroke="#e0e0e0"/>`;
  svgContent += `<line x1="${PAD_L}" y1="${H - PAD_B}" x2="${W - PAD_R}" y2="${H - PAD_B}" stroke="#e0e0e0"/>`;

  // X-axis date labels (show up to 6 evenly spaced)
  const maxLabels = Math.min(6, sorted.length);
  for (let i = 0; i < maxLabels; i++) {
    const idx = Math.round((i / (maxLabels - 1)) * (sorted.length - 1));
    const x = points[idx].x;
    svgContent += `<text x="${x}" y="${H - 6}" text-anchor="middle" font-size="9" fill="#bbb" font-family="-apple-system,sans-serif">${formatShortDate(sorted[idx].timestamp)}</text>`;
  }

  // Line connecting points
  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
  svgContent += `<path d="${linePath}" fill="none" stroke="#7c4dff" stroke-width="2" stroke-linejoin="round"/>`;

  // Moving average (window=3)
  if (scores.length >= 3) {
    const ma = [];
    for (let i = 0; i < scores.length; i++) {
      const start = Math.max(0, i - 1);
      const end = Math.min(scores.length - 1, i + 1);
      const slice = scores.slice(start, end + 1);
      ma.push(slice.reduce((a, b) => a + b, 0) / slice.length);
    }
    const maPoints = ma.map((s, i) => ({
      x: points[i].x,
      y: PAD_T + plotH - (s / maxScore) * plotH,
    }));
    const maPath = maPoints.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ");
    svgContent += `<path d="${maPath}" fill="none" stroke="#7c4dff" stroke-width="1.5" stroke-dasharray="4,4" opacity="0.4" stroke-linejoin="round"/>`;
  }

  // Dots
  points.forEach((p) => {
    svgContent += `<circle cx="${p.x}" cy="${p.y}" r="4" fill="#7c4dff"/>`;
    svgContent += `<circle cx="${p.x}" cy="${p.y}" r="3" fill="#fff"/>`;
    svgContent += `<circle cx="${p.x}" cy="${p.y}" r="2" fill="#7c4dff"/>`;
  });

  svg.innerHTML = svgContent;
}

// --- Data operations ---

async function loadHistory() {
  const { quizHistory = [] } = await chrome.storage.local.get("quizHistory");
  // Show newest first in list
  allHistory = quizHistory;
  render([...quizHistory].reverse());
}

async function deleteEntry(id) {
  allHistory = allHistory.filter((e) => e.id !== id);
  await chrome.storage.local.set({ quizHistory: allHistory });
  render([...allHistory].reverse());
}

async function clearAll() {
  if (!confirm(t("confirmDeleteHistory"))) return;
  allHistory = [];
  await chrome.storage.local.set({ quizHistory: [] });
  render([]);
}

clearAllBtn.addEventListener("click", clearAll);

loadHistory();
