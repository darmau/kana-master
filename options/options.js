import { t, applyI18n } from "../lib/i18n.js";
import { PROVIDERS } from "../lib/models.js";
import { DEFAULT_FURIGANA_PROMPT, getTranslationPrompt } from "../lib/api.js";

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

// Heuristic token estimation (fallback when no API key)
function estimateTokens(text) {
  let tokens = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x3000 && code <= 0x9fff || code >= 0xf900 && code <= 0xfaff || code >= 0xff00 && code <= 0xffef) {
      tokens += 1.5; // CJK / fullwidth
    } else if (code >= 0x20 && code <= 0x7e) {
      tokens += 0.25; // ASCII
    } else {
      tokens += 1;
    }
  }
  return Math.max(1, Math.ceil(tokens));
}

// --- Token counting via API ---
// Each returns { furigana: N, translation: N } (input tokens including system prompt)

const TRANSLATION_PROMPT = getTranslationPrompt("zh-CN"); // representative prompt for counting

async function countTokensOpenAI(apiKey, baseUrl, text) {
  const model = PROVIDERS.openai.chatModels.at(-1)?.id || "gpt-4o-mini";
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
  const [r1, r2] = await Promise.all([
    fetch(`${baseUrl}/responses/input_tokens`, {
      method: "POST", headers,
      body: JSON.stringify({ model, input: text, instructions: DEFAULT_FURIGANA_PROMPT }),
      signal: AbortSignal.timeout(10000),
    }),
    fetch(`${baseUrl}/responses/input_tokens`, {
      method: "POST", headers,
      body: JSON.stringify({ model, input: text, instructions: TRANSLATION_PROMPT }),
      signal: AbortSignal.timeout(10000),
    }),
  ]);
  if (!r1.ok || !r2.ok) throw new Error("API error");
  const [d1, d2] = await Promise.all([r1.json(), r2.json()]);
  return { furigana: d1.input_tokens, translation: d2.input_tokens };
}

async function countTokensAnthropic(apiKey, text) {
  const headers = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  };
  const [r1, r2] = await Promise.all([
    fetch("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST", headers,
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        system: DEFAULT_FURIGANA_PROMPT,
        messages: [{ role: "user", content: text }],
      }),
      signal: AbortSignal.timeout(10000),
    }),
    fetch("https://api.anthropic.com/v1/messages/count_tokens", {
      method: "POST", headers,
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        system: TRANSLATION_PROMPT,
        messages: [{ role: "user", content: text }],
      }),
      signal: AbortSignal.timeout(10000),
    }),
  ]);
  if (!r1.ok || !r2.ok) throw new Error("API error");
  const [d1, d2] = await Promise.all([r1.json(), r2.json()]);
  return { furigana: d1.input_tokens, translation: d2.input_tokens };
}

async function countTokensGoogle(apiKey, text) {
  const base = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:countTokens";
  const headers = { "Content-Type": "application/json" };
  const [r1, r2] = await Promise.all([
    fetch(`${base}?key=${apiKey}`, {
      method: "POST", headers,
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        system_instruction: { parts: [{ text: DEFAULT_FURIGANA_PROMPT }] },
      }),
      signal: AbortSignal.timeout(10000),
    }),
    fetch(`${base}?key=${apiKey}`, {
      method: "POST", headers,
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        system_instruction: { parts: [{ text: TRANSLATION_PROMPT }] },
      }),
      signal: AbortSignal.timeout(10000),
    }),
  ]);
  if (!r1.ok || !r2.ok) throw new Error("API error");
  const [d1, d2] = await Promise.all([r1.json(), r2.json()]);
  return { furigana: d1.totalTokens, translation: d2.totalTokens };
}

// Per-provider token counts: { openai: { furigana, translation, exact }, ... }
let providerTokens = {};
let debounceTimer = null;

// Heuristic estimates including system prompt overhead
const FURIGANA_PROMPT_TOKENS = 400;
const TRANSLATION_PROMPT_TOKENS = 50;

function estimateProviderTokens(text) {
  const textTokens = estimateTokens(text);
  return {
    furigana: FURIGANA_PROMPT_TOKENS + textTokens,
    translation: TRANSLATION_PROMPT_TOKENS + textTokens,
    exact: false,
  };
}

function getApiKey(provider) {
  const field = PROVIDER_KEYS[provider];
  return field ? document.getElementById(field).value.trim() : "";
}

function getBaseUrl() {
  return (document.getElementById("openaiBaseUrl").value.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
}

async function fetchProviderTokens(text) {
  const tasks = [];

  for (const providerId of Object.keys(PROVIDERS)) {
    const apiKey = getApiKey(providerId);
    if (!apiKey) {
      providerTokens[providerId] = estimateProviderTokens(text);
      continue;
    }

    providerTokens[providerId] = { ...estimateProviderTokens(text), loading: true };

    const task = (async () => {
      try {
        let result;
        if (providerId === "openai") result = await countTokensOpenAI(apiKey, getBaseUrl(), text);
        else if (providerId === "anthropic") result = await countTokensAnthropic(apiKey, text);
        else if (providerId === "google") result = await countTokensGoogle(apiKey, text);

        if (result?.furigana != null && result?.translation != null) {
          providerTokens[providerId] = { ...result, exact: true };
        } else {
          providerTokens[providerId] = estimateProviderTokens(text);
        }
      } catch {
        providerTokens[providerId] = estimateProviderTokens(text);
      }
      updateCostTable();
    })();
    tasks.push(task);
  }

  if (tasks.length === 0) updateCostTable();
  else await Promise.all(tasks);
}

const FURIGANA_OUTPUT_RATIO = 3;
const TRANSLATION_OUTPUT_RATIO = 1;

function getCostUnit() {
  return document.querySelector('input[name="costUnit"]:checked')?.value || "dollar";
}

function formatCost(dollars) {
  if (getCostUnit() === "cent") {
    const cents = dollars * 100;
    if (cents < 0.0001) return "0¢";
    if (cents < 0.1) return cents.toFixed(4) + "¢";
    return cents.toFixed(3) + "¢";
  }
  if (dollars < 0.000001) return "$0";
  if (dollars < 0.001) return "$" + dollars.toFixed(6);
  if (dollars < 0.01) return "$" + dollars.toFixed(5);
  return "$" + dollars.toFixed(4);
}

function updateCostTable() {
  const text = document.getElementById("calcInput").value;
  const charCount = [...text].length;

  document.getElementById("calcChars").textContent = charCount;

  // Token stats per provider (show furigana input tokens as representative)
  const statsEl = document.getElementById("calcTokenStats");
  statsEl.innerHTML = "";
  for (const [providerId, provider] of Object.entries(PROVIDERS)) {
    const info = providerTokens[providerId];
    if (!info) continue;
    const badgeClass = info.loading ? "loading" : info.exact ? "exact" : "est";
    const badgeText = info.loading ? "..." : info.exact ? "API" : "~";
    const label = info.exact ? t("costCalcIncPrompt") : "";
    statsEl.innerHTML += `<span class="calc-token-line">${provider.name}: <strong>${info.furigana}</strong>`
      + `<span class="token-badge ${badgeClass}">${badgeText}</span>`
      + (label ? ` <span style="font-size:11px;color:#888">${label}</span>` : "")
      + `</span>`;
  }

  const tbody = document.getElementById("costTableBody");
  tbody.innerHTML = "";

  // Output tokens are estimated from text-only tokens (exclude prompt overhead)
  const textOnlyTokens = text ? estimateTokens(text) : 0;

  for (const [providerId, provider] of Object.entries(PROVIDERS)) {
    const info = providerTokens[providerId] || estimateProviderTokens(text || "");
    const furiganaInput = text ? info.furigana : 0;
    const transInput = text ? info.translation : 0;
    let isFirst = true;

    for (const model of provider.chatModels) {
      const furiganaOutput = textOnlyTokens * FURIGANA_OUTPUT_RATIO;
      const furiganaCost = (furiganaInput * model.inputPrice + furiganaOutput * model.outputPrice) / 1_000_000;

      const transOutput = textOnlyTokens * TRANSLATION_OUTPUT_RATIO;
      const transCost = (transInput * model.inputPrice + transOutput * model.outputPrice) / 1_000_000;

      const tr = document.createElement("tr");
      if (isFirst) tr.className = "provider-group";

      tr.innerHTML = `
        <td>
          ${isFirst ? `<span class="provider-label">${provider.name}</span><br>` : ""}
          <span class="model-name">${model.name}</span>
        </td>
        <td class="price-cell">${formatCost(furiganaCost)}</td>
        <td class="price-cell">${formatCost(transCost)}</td>
      `;
      tbody.appendChild(tr);
      isFirst = false;
    }
  }
}

function onCalcInput() {
  const text = document.getElementById("calcInput").value;
  // Immediate: update with heuristic estimates
  for (const providerId of Object.keys(PROVIDERS)) {
    providerTokens[providerId] = text ? estimateProviderTokens(text) : { furigana: 0, translation: 0, exact: false };
  }
  updateCostTable();

  // Debounced: fetch accurate counts from APIs
  clearTimeout(debounceTimer);
  if (text) {
    debounceTimer = setTimeout(() => fetchProviderTokens(text), 600);
  }
}

document.getElementById("calcInput").addEventListener("input", onCalcInput);
for (const radio of document.querySelectorAll('input[name="costUnit"]')) {
  radio.addEventListener("change", updateCostTable);
}
onCalcInput();
