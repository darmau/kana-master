import { t, applyI18n } from "../lib/i18n.js";
import { PROVIDERS } from "../lib/models.js";

applyI18n();

const PROVIDER_KEYS = { openai: "openaiKey", anthropic: "anthropicKey", google: "googleKey" };
const ALL_SETTINGS_KEYS = [
  "openaiKey", "anthropicKey", "googleKey", "openaiBaseUrl",
  // Legacy key for migration
  "apiKey",
];

// --- Provider status badges ---

function updateProviderStatus() {
  for (const [provider, keyField] of Object.entries(PROVIDER_KEYS)) {
    const hasKey = !!document.getElementById(keyField).value.trim();
    const card = document.getElementById(`${provider}Card`);
    const badge = document.getElementById(`${provider}Status`);
    card.classList.toggle("active", hasKey);
    badge.className = `provider-badge ${hasKey ? "badge-active" : "badge-inactive"}`;
    badge.textContent = hasKey ? t("configured") : t("notConfigured");
  }
}

// --- Load settings ---

chrome.storage.sync.get(ALL_SETTINGS_KEYS, (result) => {
  // Migrate from legacy single-key settings
  if (result.apiKey && !result.openaiKey) {
    result.openaiKey = result.apiKey;
  }

  if (result.openaiKey) document.getElementById("openaiKey").value = result.openaiKey;
  if (result.anthropicKey) document.getElementById("anthropicKey").value = result.anthropicKey;
  if (result.googleKey) document.getElementById("googleKey").value = result.googleKey;
  if (result.openaiBaseUrl) document.getElementById("openaiBaseUrl").value = result.openaiBaseUrl;

  updateProviderStatus();
});

// Update badges when API keys change
for (const keyField of Object.values(PROVIDER_KEYS)) {
  document.getElementById(keyField).addEventListener("input", updateProviderStatus);
}

// --- API test buttons ---

async function testProvider(provider) {
  const btnId = `test${provider.charAt(0).toUpperCase() + provider.slice(1)}`;
  const btn = document.getElementById(btnId);
  const result = document.getElementById(btnId + "Result");

  btn.disabled = true;
  result.className = "test-result";
  result.textContent = t("testing");

  try {
    if (provider === "openai") {
      const key = document.getElementById("openaiKey").value.trim();
      if (!key) throw new Error("No API key");
      const baseUrl = (document.getElementById("openaiBaseUrl").value.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
      const res = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${res.status} ${body.slice(0, 80)}`);
      }
    } else if (provider === "anthropic") {
      const key = document.getElementById("anthropicKey").value.trim();
      if (!key) throw new Error("No API key");
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          max_tokens: 1,
          messages: [{ role: "user", content: "Hi" }],
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${res.status} ${body.slice(0, 80)}`);
      }
    } else if (provider === "google") {
      const key = document.getElementById("googleKey").value.trim();
      if (!key) throw new Error("No API key");
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${res.status} ${body.slice(0, 80)}`);
      }
    }

    result.className = "test-result success";
    result.textContent = t("testSuccess");
  } catch (err) {
    result.className = "test-result error";
    const msg = err.name === "TimeoutError" ? "Timeout" : err.message.slice(0, 100);
    result.textContent = t("testFailed", { error: msg });
  } finally {
    btn.disabled = false;
  }
}

document.getElementById("testOpenai").addEventListener("click", () => testProvider("openai"));
document.getElementById("testAnthropic").addEventListener("click", () => testProvider("anthropic"));
document.getElementById("testGoogle").addEventListener("click", () => testProvider("google"));

// --- Save ---

document.getElementById("saveBtn").addEventListener("click", () => {
  const data = {};

  const openaiKey = document.getElementById("openaiKey").value.trim();
  const anthropicKey = document.getElementById("anthropicKey").value.trim();
  const googleKey = document.getElementById("googleKey").value.trim();
  const openaiBaseUrl = document.getElementById("openaiBaseUrl").value.trim();
  if (openaiKey) data.openaiKey = openaiKey;
  if (anthropicKey) data.anthropicKey = anthropicKey;
  if (googleKey) data.googleKey = googleKey;
  if (openaiBaseUrl) data.openaiBaseUrl = openaiBaseUrl;

  chrome.storage.sync.set(data, () => {
    const status = document.getElementById("status");
    status.textContent = t("saved");
    setTimeout(() => (status.textContent = ""), 2000);
  });
});

// --- Cost Calculator ---

// Estimate token count from text (heuristic, no external tokenizer)
// CJK characters ~1.5 tokens each, ASCII ~0.25 tokens per char
function estimateTokens(text) {
  let tokens = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x3000 && code <= 0x9fff || code >= 0xf900 && code <= 0xfaff || code >= 0xff00 && code <= 0xffef) {
      tokens += 1.5; // CJK / fullwidth
    } else if (code >= 0x20 && code <= 0x7e) {
      tokens += 0.25; // ASCII
    } else {
      tokens += 1; // other (emoji, etc.)
    }
  }
  return Math.max(1, Math.ceil(tokens));
}

// Approximate system prompt token counts
const FURIGANA_PROMPT_TOKENS = 400;
const TRANSLATION_PROMPT_TOKENS = 50;

// Furigana output is JSON with {t,r} pairs — roughly 3x input text tokens
const FURIGANA_OUTPUT_RATIO = 3;
// Translation output is roughly same length as input
const TRANSLATION_OUTPUT_RATIO = 1;

function formatCost(dollars) {
  if (dollars < 0.000001) return "$0";
  if (dollars < 0.001) return "$" + dollars.toFixed(6);
  if (dollars < 0.01) return "$" + dollars.toFixed(5);
  return "$" + dollars.toFixed(4);
}

function updateCostTable() {
  const text = document.getElementById("calcInput").value;
  const charCount = [...text].length;
  const textTokens = text ? estimateTokens(text) : 0;

  document.getElementById("calcChars").textContent = charCount;
  document.getElementById("calcTokens").textContent = textTokens;

  const tbody = document.getElementById("costTableBody");
  tbody.innerHTML = "";

  for (const [providerId, provider] of Object.entries(PROVIDERS)) {
    let isFirst = true;
    for (const model of provider.chatModels) {
      const inputPrice = model.inputPrice; // $ per 1M input tokens
      const outputPrice = model.outputPrice; // $ per 1M output tokens

      // Furigana: input = prompt + text, output = ~3x text
      const furiganaInput = FURIGANA_PROMPT_TOKENS + textTokens;
      const furiganaOutput = textTokens * FURIGANA_OUTPUT_RATIO;
      const furiganaCost = (furiganaInput * inputPrice + furiganaOutput * outputPrice) / 1_000_000;

      // Translation: input = prompt + text, output = ~1x text
      const transInput = TRANSLATION_PROMPT_TOKENS + textTokens;
      const transOutput = textTokens * TRANSLATION_OUTPUT_RATIO;
      const transCost = (transInput * inputPrice + transOutput * outputPrice) / 1_000_000;

      const totalCost = furiganaCost + transCost;

      const tr = document.createElement("tr");
      if (isFirst) tr.className = "provider-group";

      tr.innerHTML = `
        <td>
          ${isFirst ? `<span class="provider-label">${provider.name}</span><br>` : ""}
          <span class="model-name">${model.name}</span>
        </td>
        <td class="price-cell">${formatCost(furiganaCost)}</td>
        <td class="price-cell">${formatCost(transCost)}</td>
        <td class="price-cell"><strong>${formatCost(totalCost)}</strong></td>
      `;
      tbody.appendChild(tr);
      isFirst = false;
    }
  }
}

document.getElementById("calcInput").addEventListener("input", updateCostTable);
updateCostTable();
