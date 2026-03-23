import { LANGUAGE_NAMES } from "../lib/api.js";
import { PROVIDERS, DEFAULT_CHAT_MODEL, DEFAULT_TTS_MODEL } from "../lib/models.js";
import { t, applyI18n } from "../lib/i18n.js";

applyI18n();

const PROVIDER_KEYS = { openai: "openaiKey", anthropic: "anthropicKey", google: "googleKey" };
const CHAT_MODEL_FIELDS = ["furiganaModel", "translationModel", "grammarModel"];
const ALL_SETTINGS_KEYS = [
  "openaiKey", "anthropicKey", "googleKey", "openaiBaseUrl",
  ...CHAT_MODEL_FIELDS, "ttsModel",
  "ttsVoice", "targetLang", "translationEngine", "twoStepFurigana",
  // Legacy key for migration
  "apiKey", "model",
];

// Track saved voice to restore after rebuilds
let savedTtsVoice = "alloy";

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
  rebuildModelSelects();
}

// --- Build model dropdowns from static list ---

function getAvailableProviders() {
  const available = [];
  for (const [provider, keyField] of Object.entries(PROVIDER_KEYS)) {
    if (document.getElementById(keyField).value.trim()) {
      available.push(provider);
    }
  }
  return available;
}

function buildModelOptions(models, savedValue) {
  const available = getAvailableProviders();
  let html = "";

  for (const provider of available) {
    const providerModels = PROVIDERS[provider]?.[models] || [];
    if (providerModels.length === 0) continue;
    html += `<optgroup label="${PROVIDERS[provider].name}">`;
    for (const m of providerModels) {
      const value = `${provider}/${m.id}`;
      const selected = value === savedValue ? " selected" : "";
      html += `<option value="${value}"${selected}>${m.name}</option>`;
    }
    html += "</optgroup>";
  }

  if (!html) {
    html = `<option value="">${t("configureKeyPrompt")}</option>`;
  }

  return html;
}

function rebuildModelSelects() {
  for (const field of CHAT_MODEL_FIELDS) {
    const sel = document.getElementById(field);
    const saved = sel.dataset.saved || DEFAULT_CHAT_MODEL;
    sel.innerHTML = buildModelOptions("chatModels", saved);
    if (saved && sel.value !== saved) {
      sel.innerHTML += `<option value="${saved}" selected>${saved}</option>`;
    }
  }

  // TTS models
  const ttsSel = document.getElementById("ttsModel");
  const ttsSaved = ttsSel.dataset.saved || DEFAULT_TTS_MODEL;
  ttsSel.innerHTML = buildModelOptions("ttsModels", ttsSaved);
  if (ttsSaved && ttsSel.value !== ttsSaved) {
    ttsSel.innerHTML += `<option value="${ttsSaved}" selected>${ttsSaved}</option>`;
  }

  rebuildVoiceSelect();
}

// --- Dynamic voice list based on TTS model provider ---

function getTtsProvider() {
  const ttsModel = document.getElementById("ttsModel").value || "";
  const slash = ttsModel.indexOf("/");
  return slash === -1 ? "openai" : ttsModel.substring(0, slash);
}

function rebuildVoiceSelect() {
  const provider = getTtsProvider();
  const voices = PROVIDERS[provider]?.ttsVoices || PROVIDERS.openai.ttsVoices;
  const voiceSel = document.getElementById("ttsVoice");
  const current = voiceSel.value || savedTtsVoice;

  voiceSel.innerHTML = voices
    .map((v) => {
      const display = v.charAt(0).toUpperCase() + v.slice(1);
      const selected = v.toLowerCase() === current.toLowerCase() ? " selected" : "";
      return `<option value="${v}"${selected}>${display}</option>`;
    })
    .join("");

  // Update hint
  const hint = document.getElementById("ttsVoiceHint");
  if (provider === "google") {
    hint.textContent = t("googleTtsHint");
  } else {
    hint.innerHTML = `${t("openaiTtsHint")} <a href="https://platform.openai.com/docs/guides/text-to-speech" target="_blank">OpenAI TTS docs</a>`;
  }
}

// Rebuild voices when TTS model changes
document.getElementById("ttsModel").addEventListener("change", rebuildVoiceSelect);

// --- Load settings ---

chrome.storage.sync.get(ALL_SETTINGS_KEYS, (result) => {
  // Migrate from legacy single-key settings
  if (result.apiKey && !result.openaiKey) {
    result.openaiKey = result.apiKey;
  }
  const legacyModel = result.model || "gpt-4o-mini";
  const legacyModelId = legacyModel.includes("/") ? legacyModel : `openai/${legacyModel}`;

  // API keys
  if (result.openaiKey) document.getElementById("openaiKey").value = result.openaiKey;
  if (result.anthropicKey) document.getElementById("anthropicKey").value = result.anthropicKey;
  if (result.googleKey) document.getElementById("googleKey").value = result.googleKey;
  if (result.openaiBaseUrl) document.getElementById("openaiBaseUrl").value = result.openaiBaseUrl;

  // Per-task models (fall back to legacy)
  for (const field of CHAT_MODEL_FIELDS) {
    document.getElementById(field).dataset.saved = result[field] || legacyModelId;
  }
  document.getElementById("ttsModel").dataset.saved = result.ttsModel || DEFAULT_TTS_MODEL;

  // Voice — save before updateProviderStatus triggers rebuild
  savedTtsVoice = result.ttsVoice || "alloy";

  // Other settings
  if (result.targetLang) document.getElementById("targetLang").value = result.targetLang;
  if (result.translationEngine === "local") {
    document.getElementById("engineLocal").checked = true;
  } else {
    document.getElementById("engineCloud").checked = true;
  }

  document.getElementById("twoStepFurigana").checked = !!result.twoStepFurigana;

  updateProviderStatus();
});

// Update badges & model lists when API keys change
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

// --- Local translator check ---

function mapTargetLang(targetLang) {
  const map = { "zh-CN": "zh", "zh-TW": "zh-Hant" };
  return map[targetLang] || targetLang;
}

async function checkLocalAvailability() {
  const statusEl = document.getElementById("localStatus");
  if (!("ai" in self) || !("translator" in self.ai)) {
    statusEl.textContent = t("localNotAvailable");
    statusEl.style.color = "#b36b00";
    return;
  }

  const targetLang = document.getElementById("targetLang").value || "zh-CN";
  const shortLang = mapTargetLang(targetLang);
  const langName = LANGUAGE_NAMES[targetLang] || targetLang;

  try {
    const canTranslate = await self.ai.translator.capabilities();
    const pair = canTranslate.languagePairAvailable("ja", shortLang);
    if (pair === "readily") {
      statusEl.textContent = t("localReady", { lang: langName });
      statusEl.style.color = "#0d7e3f";
    } else if (pair === "after-download") {
      statusEl.textContent = t("localNeedDownload", { lang: langName });
      statusEl.style.color = "#b36b00";
    } else {
      statusEl.textContent = t("localNotSupported", { lang: langName });
      statusEl.style.color = "#d93025";
    }
  } catch (err) {
    statusEl.textContent = t("localCheckError") + err.message;
    statusEl.style.color = "#d93025";
  }
}

checkLocalAvailability();
document.getElementById("targetLang").addEventListener("change", () => {
  checkLocalAvailability();
});

// --- Save ---

document.getElementById("saveBtn").addEventListener("click", () => {
  const data = {};

  // API keys
  const openaiKey = document.getElementById("openaiKey").value.trim();
  const anthropicKey = document.getElementById("anthropicKey").value.trim();
  const googleKey = document.getElementById("googleKey").value.trim();
  const openaiBaseUrl = document.getElementById("openaiBaseUrl").value.trim();
  if (openaiKey) data.openaiKey = openaiKey;
  if (anthropicKey) data.anthropicKey = anthropicKey;
  if (googleKey) data.googleKey = googleKey;
  if (openaiBaseUrl) data.openaiBaseUrl = openaiBaseUrl;

  // Models
  for (const field of CHAT_MODEL_FIELDS) {
    data[field] = document.getElementById(field).value;
  }
  data.ttsModel = document.getElementById("ttsModel").value;

  // Other
  data.ttsVoice = document.getElementById("ttsVoice").value;
  data.targetLang = document.getElementById("targetLang").value;
  data.translationEngine = document.querySelector('input[name="translationEngine"]:checked').value;
  data.twoStepFurigana = document.getElementById("twoStepFurigana").checked;

  chrome.storage.sync.set(data, () => {
    const status = document.getElementById("status");
    status.textContent = t("saved");
    setTimeout(() => (status.textContent = ""), 2000);
  });
});
