import { PROVIDERS, DEFAULT_CHAT_MODEL, DEFAULT_TTS_MODEL } from "../lib/models.js";
import { t, applyI18n } from "../lib/i18n.js";
import { PROVIDER_KEYS, CHAT_MODEL_FIELDS, SETTINGS_KEYS, LEGACY_KEYS, DEFAULTS } from "../lib/storage.js";

// Loaded via <script src="../lib/shared.js"> before this module (see popup.html)
const { isHostBlacklisted } = globalThis.KanaShared;

const bulkBtn = document.getElementById("bulkBtn");
const translatePageBtn = document.getElementById("translatePageBtn");
const vocabBtn = document.getElementById("vocabBtn");
const historyBtn = document.getElementById("historyBtn");
const status = document.getElementById("status");
const settingsToggle = document.getElementById("settingsToggle");
const settingsPanel = document.getElementById("settingsPanel");
const apisLink = document.getElementById("apisLink");

applyI18n();

// --- Settings toggle ---

settingsToggle.addEventListener("click", () => {
  const open = settingsPanel.classList.toggle("open");
  settingsToggle.classList.toggle("open", open);
  settingsToggle.setAttribute("aria-expanded", String(open));
  chrome.storage.local.set({ popupSettingsOpen: open });
});

// Restore toggle state
chrome.storage.local.get("popupSettingsOpen", (result) => {
  if (result.popupSettingsOpen) {
    settingsPanel.classList.add("open");
    settingsToggle.classList.add("open");
    settingsToggle.setAttribute("aria-expanded", "true");
  }
});

// --- Main action buttons: disabled without an API key or on a blacklisted site ---

let hasProviders = false;
let siteDisabled = false;

function updateMainButtons() {
  bulkBtn.disabled = !hasProviders || siteDisabled;
  translatePageBtn.disabled = !hasProviders || siteDisabled;
}

// --- Per-site disable toggle ---

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try {
    const url = new URL(tab?.url || "");
    if (url.protocol === "http:" || url.protocol === "https:") host = url.hostname;
  } catch (_) {}
  if (!host) return; // chrome:// and similar — keep the toggle hidden

  const { blacklist = [] } = await chrome.storage.sync.get("blacklist");
  siteDisabled = isHostBlacklisted(host, blacklist);

  const toggle = document.getElementById("siteDisableToggle");
  toggle.checked = siteDisabled;
  document.getElementById("siteHost").textContent = host;
  document.getElementById("siteToggleRow").hidden = false;
  updateMainButtons();

  toggle.addEventListener("change", async () => {
    const { blacklist = [] } = await chrome.storage.sync.get("blacklist");
    let next;
    if (toggle.checked) {
      // Store without the www. prefix so the rule also covers the bare domain
      const entry = host.replace(/^www\./, "");
      next = blacklist.includes(entry) ? blacklist : [...blacklist, entry];
    } else {
      // Remove every entry that covers this host (an exact entry and any
      // parent-domain entry), otherwise unchecking would not stick.
      next = blacklist.filter((p) => !isHostBlacklisted(host, [p]));
    }
    await chrome.storage.sync.set({ blacklist: next });
    siteDisabled = toggle.checked;
    updateMainButtons();
  });
})();

// --- Action buttons ---

bulkBtn.addEventListener("click", async () => {
  bulkBtn.disabled = true;
  status.textContent = t("extracting");
  status.className = "loading";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let data = null;
    try {
      data = await chrome.tabs.sendMessage(tab.id, { type: "extractContent" });
      if (data?.disabled) {
        status.textContent = t("siteDisabledNote");
        status.className = "";
        updateMainButtons();
        return;
      }
      if (data?.error || !data?.content || data.content.length === 0) {
        data = null;
      }
    } catch (_) {
      // Content script not available (e.g. chrome:// pages) — open empty reader
    }

    if (data) {
      await chrome.storage.local.set({ readerData: data });
    } else {
      await chrome.storage.local.remove("readerData");
    }
    chrome.tabs.create({ url: chrome.runtime.getURL("reader/reader.html") });
    window.close();
  } catch (err) {
    status.textContent = err.message;
    status.className = "error";
    bulkBtn.disabled = false;
  }
});

translatePageBtn.addEventListener("click", async () => {
  translatePageBtn.disabled = true;
  status.textContent = "";
  status.className = "";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const res = await chrome.tabs.sendMessage(tab.id, { type: "translatePage" });
    if (res?.disabled) {
      status.textContent = t("siteDisabledNote");
      updateMainButtons();
      return;
    }
    if (res?.count === 0) {
      status.textContent = t("noContent");
      translatePageBtn.disabled = false;
      return;
    }
    // Started (or already running) — progress is shown on the page itself
    window.close();
  } catch (_) {
    // Content script not available (e.g. chrome:// pages)
    status.textContent = t("cannotTranslatePage");
    status.className = "error";
    translatePageBtn.disabled = false;
  }
});

vocabBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("vocabulary/vocabulary.html") });
  window.close();
});

historyBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("history/history.html") });
  window.close();
});

apisLink.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("setupBtn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

// --- Model dropdown logic ---

const ALL_SETTINGS_KEYS = [...SETTINGS_KEYS, ...LEGACY_KEYS];

let availableProviders = [];
let savedTtsVoice = DEFAULTS.ttsVoice;

function getAvailableProviders(keys) {
  const available = [];
  for (const [provider, keyField] of Object.entries(PROVIDER_KEYS)) {
    if (keys[keyField]) available.push(provider);
  }
  return available;
}

function buildModelOptions(category, savedValue) {
  let html = "";
  for (const provider of availableProviders) {
    const models = PROVIDERS[provider]?.[category] || [];
    if (models.length === 0) continue;
    html += `<optgroup label="${PROVIDERS[provider].name}">`;
    for (const m of models) {
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

function rebuildVoiceSelect() {
  const ttsModel = document.getElementById("ttsModel").value || "";
  const slash = ttsModel.indexOf("/");
  const provider = slash === -1 ? "openai" : ttsModel.substring(0, slash);
  const voices = PROVIDERS[provider]?.ttsVoices || PROVIDERS.openai.ttsVoices;
  const voiceSel = document.getElementById("ttsVoice");
  const current = voiceSel.value || savedTtsVoice;

  voiceSel.innerHTML = voices
    .map((v) => {
      // ElevenLabs voices are objects {id, name}, others are plain strings
      const value = typeof v === "object" ? v.id : v;
      const display = typeof v === "object" ? v.name : v.charAt(0).toUpperCase() + v.slice(1);
      const selected = value.toLowerCase() === current.toLowerCase() ? " selected" : "";
      return `<option value="${value}"${selected}>${display}</option>`;
    })
    .join("");

  const hint = document.getElementById("ttsVoiceHint");
  if (provider === "elevenlabs") {
    hint.innerHTML = `${t("elevenlabsTtsHint")} <a href="https://elevenlabs.io/app/voice-library" target="_blank">ElevenLabs Voice Library</a>`;
  } else if (provider === "google") {
    hint.textContent = t("googleTtsHint");
  } else {
    hint.innerHTML = `${t("openaiTtsHint")} <a href="https://platform.openai.com/docs/guides/text-to-speech" target="_blank">OpenAI TTS docs</a>`;
  }
}

function rebuildAllModels(settings) {
  for (const field of CHAT_MODEL_FIELDS) {
    const sel = document.getElementById(field);
    const saved = settings[field] || DEFAULT_CHAT_MODEL;
    sel.innerHTML = buildModelOptions("chatModels", saved);
    if (saved && sel.value !== saved) {
      sel.innerHTML += `<option value="${saved}" selected>${saved}</option>`;
    }
  }

  const ttsSel = document.getElementById("ttsModel");
  const ttsSaved = settings.ttsModel || DEFAULT_TTS_MODEL;
  ttsSel.innerHTML = buildModelOptions("ttsModels", ttsSaved);
  if (ttsSaved && ttsSel.value !== ttsSaved) {
    ttsSel.innerHTML += `<option value="${ttsSaved}" selected>${ttsSaved}</option>`;
  }

  rebuildVoiceSelect();
}

// --- Auto-save on change ---

function autoSave(key, value) {
  chrome.storage.sync.set({ [key]: value });
}

function bindAutoSave() {
  for (const field of CHAT_MODEL_FIELDS) {
    document.getElementById(field).addEventListener("change", (e) => autoSave(field, e.target.value));
  }
  document.getElementById("ttsModel").addEventListener("change", (e) => {
    autoSave("ttsModel", e.target.value);
    rebuildVoiceSelect();
    // Save the new default voice so a stale voice ID from another provider doesn't persist
    autoSave("ttsVoice", document.getElementById("ttsVoice").value);
  });
  document.getElementById("ttsVoice").addEventListener("change", (e) => autoSave("ttsVoice", e.target.value));
  document.getElementById("targetLang").addEventListener("change", (e) => autoSave("targetLang", e.target.value));
  document.getElementById("jlptLevel").addEventListener("change", (e) => autoSave("jlptLevel", e.target.value));
  document.getElementById("debugMode").addEventListener("change", (e) => autoSave("debugMode", e.target.checked));
}

// --- Load settings ---

chrome.storage.sync.get(ALL_SETTINGS_KEYS, (result) => {
  // Migrate legacy
  if (result.apiKey && !result.openaiKey) {
    result.openaiKey = result.apiKey;
  }
  const legacyModel = result.model || "gpt-4o-mini";
  const legacyModelId = legacyModel.includes("/") ? legacyModel : `openai/${legacyModel}`;

  // Normalize per-task models
  for (const field of CHAT_MODEL_FIELDS) {
    if (!result[field]) result[field] = legacyModelId;
  }

  availableProviders = getAvailableProviders(result);
  savedTtsVoice = result.ttsVoice || DEFAULTS.ttsVoice;

  // First-run guidance: no API key configured yet
  hasProviders = availableProviders.length > 0;
  document.getElementById("setupCard").hidden = hasProviders;
  updateMainButtons();

  // Render API status tags
  const apiTags = document.getElementById("apiTags");
  apiTags.innerHTML = availableProviders
    .map((p) => `<span class="api-tag">${PROVIDERS[p].name}</span>`)
    .join("");

  // Set non-model fields
  if (result.targetLang) document.getElementById("targetLang").value = result.targetLang;
  if (result.jlptLevel) document.getElementById("jlptLevel").value = result.jlptLevel;
  document.getElementById("debugMode").checked = !!result.debugMode;

  rebuildAllModels(result);
  bindAutoSave();
});
