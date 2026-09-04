// lib/storage.js — single source of truth for chrome.storage keys, defaults, and access helpers.
// Imported by every ESM context (service worker, options, popup, reader, vocabulary, history).
// NOT used by content/content.js (IIFE, cannot import modules).

// Provider id -> the sync key that holds that provider's API key.
export const PROVIDER_KEYS = {
  openai: "openaiKey",
  anthropic: "anthropicKey",
  google: "googleKey",
  elevenlabs: "elevenlabsKey",
};

// Sync keys holding the per-feature chat model selection (format: "provider/model").
export const CHAT_MODEL_FIELDS = ["furiganaModel", "translationModel", "grammarModel", "quizModel"];

// All sync-stored settings keys (superset). Reading a few unused keys in a given
// page is harmless, so every site can safely read from this single list.
export const SETTINGS_KEYS = [
  ...Object.values(PROVIDER_KEYS),
  "openaiBaseUrl",
  ...CHAT_MODEL_FIELDS,
  "ttsModel", "ttsVoice", "targetLang", "jlptLevel", "debugMode",
  "blacklist",
];

// Legacy keys kept only for one-time migration of old single-model settings.
export const LEGACY_KEYS = ["apiKey", "model"];

// Default values used when a key is unset. Scalars only — array/object defaults
// are intentionally kept inline at each call site to avoid aliasing a shared
// mutable instance (callers push into the returned vocabulary/quizHistory arrays).
export const DEFAULTS = {
  targetLang: "zh-CN",
  jlptLevel: "N3",
  ttsVoice: "alloy",
  debugMode: false,
};

// --- Promise-wrapped chrome.storage helpers (propagate lastError as a rejection) ---

export function getSync(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.get(keys, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
}

export function setSync(obj) {
  return new Promise((resolve, reject) => {
    chrome.storage.sync.set(obj, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

export function getLocal(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
}

export function setLocal(obj) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(obj, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

export function removeLocal(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}
