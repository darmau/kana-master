// --- Internationalization module ---
// UI language follows browser locale via Chrome's _locales mechanism.
// Translation target language is controlled by the targetLang setting.

// For multi-placeholder messages, define the parameter order
// so named-object callers map correctly to positional $1, $2, etc.
const PARAM_ORDER = {
  progressFormat: ["done", "total"],
};

/**
 * Get a translated string using Chrome's native i18n.
 * @param {string} key - message key from _locales messages.json
 * @param {object|array|string|number} [params] - placeholder values
 */
export function t(key, params) {
  if (!params) return chrome.i18n.getMessage(key) || key;

  let subs;
  if (Array.isArray(params)) {
    subs = params.map(String);
  } else if (typeof params === "object") {
    const order = PARAM_ORDER[key];
    subs = order
      ? order.map((k) => String(params[k] ?? ""))
      : Object.values(params).map(String);
  } else {
    subs = [String(params)];
  }

  return chrome.i18n.getMessage(key, subs) || key;
}

/**
 * Apply translations to all elements with data-i18n attributes.
 * - data-i18n="key"              → sets textContent
 * - data-i18n-placeholder="key"  → sets placeholder
 * - data-i18n-title="key"        → sets title attribute
 */
export function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const msg = chrome.i18n.getMessage(el.dataset.i18n);
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const msg = chrome.i18n.getMessage(el.dataset.i18nPlaceholder);
    if (msg) el.placeholder = msg;
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const msg = chrome.i18n.getMessage(el.dataset.i18nTitle);
    if (msg) el.title = msg;
  });
}
