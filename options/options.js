const textFields = ["apiKey", "apiBaseUrl", "furiganaPrompt", "translationPrompt"];
const selectFields = ["targetLang", "ttsVoice"];

const LANGUAGE_NAMES = {
  "zh-CN": "Simplified Chinese", "zh-TW": "Traditional Chinese", "ko": "Korean",
  "en": "English", "fr": "French", "es": "Spanish", "de": "German", "ar": "Arabic",
  "ru": "Russian", "ne": "Nepali", "vi": "Vietnamese", "my": "Burmese",
  "fil": "Filipino", "pt": "Portuguese", "it": "Italian", "id": "Indonesian", "ms": "Malay",
};

const DEFAULT_FURIGANA_PROMPT = 'You are a Japanese language expert. Given Japanese text, return a JSON object {"tokens": [...]} where each element represents a segment. Add furigana to ALL kanji without exception — even common ones like 日, 人, 大. For any token containing kanji: {"t":"原文","r":"ひらがな"}. For tokens that are purely hiragana, katakana, punctuation, Arabic numerals (0-9), or non-Japanese text: {"t":"原文"} (no "r" field). Do NOT add furigana to Arabic numerals. Concatenating all "t" fields MUST exactly reproduce the input. Keep compound words together (e.g., 東京都 → {"t":"東京都","r":"とうきょうと"}). Return ONLY JSON.';

function getDefaultTranslationPrompt(targetLang) {
  const langName = LANGUAGE_NAMES[targetLang] || "Simplified Chinese";
  return `You are a Japanese-to-${langName} translator. Translate the following Japanese text into natural ${langName}. Return ONLY the translation.`;
}

function updateTranslationPlaceholder() {
  const lang = document.getElementById("targetLang").value;
  document.getElementById("translationPrompt").placeholder = getDefaultTranslationPrompt(lang);
}

// Fetch models from API
async function fetchModels() {
  const apiKey = document.getElementById("apiKey").value.trim();
  const baseUrl = (document.getElementById("apiBaseUrl").value.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  const modelSelect = document.getElementById("model");
  const savedModel = modelSelect.dataset.saved || "";

  if (!apiKey) {
    modelSelect.innerHTML = '<option value="">Please enter API Key first</option>';
    if (savedModel) {
      modelSelect.innerHTML += `<option value="${savedModel}" selected>${savedModel}</option>`;
    }
    return;
  }

  modelSelect.innerHTML = '<option value="">Loading...</option>';

  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();

    const models = (data.data || [])
      .map((m) => m.id)
      .sort((a, b) => a.localeCompare(b));

    modelSelect.innerHTML = models
      .map((id) => `<option value="${id}"${id === savedModel ? " selected" : ""}>${id}</option>`)
      .join("");

    // If saved model not in list, add it
    if (savedModel && !models.includes(savedModel)) {
      const opt = document.createElement("option");
      opt.value = savedModel;
      opt.textContent = `${savedModel} (not found)`;
      opt.selected = true;
      modelSelect.prepend(opt);
    }
  } catch (err) {
    modelSelect.innerHTML = '<option value="">Failed to load models</option>';
    if (savedModel) {
      modelSelect.innerHTML += `<option value="${savedModel}" selected>${savedModel}</option>`;
    }
  }
}

// Load saved settings
chrome.storage.sync.get([...textFields, "model", ...selectFields, "translationEngine"], (result) => {
  textFields.forEach((key) => {
    if (result[key]) {
      document.getElementById(key).value = result[key];
    }
  });

  selectFields.forEach((key) => {
    if (result[key]) {
      document.getElementById(key).value = result[key];
    }
  });

  // Store saved model for fetchModels to use
  document.getElementById("model").dataset.saved = result.model || "gpt-4o-mini";

  if (result.translationEngine === "local") {
    document.getElementById("engineLocal").checked = true;
  } else {
    document.getElementById("engineCloud").checked = true;
  }

  // Set placeholder prompts
  document.getElementById("furiganaPrompt").placeholder = DEFAULT_FURIGANA_PROMPT;
  updateTranslationPlaceholder();

  // Fetch models after settings are loaded
  fetchModels();
});

// Update translation prompt placeholder when language changes
document.getElementById("targetLang").addEventListener("change", updateTranslationPlaceholder);

// Refresh models on button click or when API key / base URL changes
document.getElementById("refreshModels").addEventListener("click", fetchModels);
document.getElementById("apiKey").addEventListener("change", fetchModels);
document.getElementById("apiBaseUrl").addEventListener("change", fetchModels);

// Map BCP-47 codes to Chrome Translator API short codes
function mapTargetLang(targetLang) {
  const map = { "zh-CN": "zh", "zh-TW": "zh-Hant" };
  return map[targetLang] || targetLang;
}

// Detect Chrome built-in Translator API availability
async function checkLocalAvailability() {
  const statusEl = document.getElementById("localStatus");
  if (!("ai" in self) || !("translator" in self.ai)) {
    statusEl.textContent = "Chrome Built-in AI not available in this browser. Requires Chrome 131+ with Translator API enabled.";
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
      statusEl.textContent = `Japanese → ${langName} translation model is ready.`;
      statusEl.style.color = "#0d7e3f";
    } else if (pair === "after-download") {
      statusEl.textContent = `Language model for Japanese → ${langName} needs to be downloaded first. Select Local and save to start download.`;
      statusEl.style.color = "#b36b00";
    } else {
      statusEl.textContent = `Japanese → ${langName} pair not supported by this browser.`;
      statusEl.style.color = "#d93025";
    }
  } catch (err) {
    statusEl.textContent = "Could not check Translator API: " + err.message;
    statusEl.style.color = "#d93025";
  }
}

checkLocalAvailability();

// Re-check when target language changes
document.getElementById("targetLang").addEventListener("change", checkLocalAvailability);

document.getElementById("saveBtn").addEventListener("click", () => {
  const data = {};
  textFields.forEach((key) => {
    const val = document.getElementById(key).value.trim();
    if (val) data[key] = val;
  });

  ["model", ...selectFields].forEach((key) => {
    data[key] = document.getElementById(key).value;
  });

  data.translationEngine = document.querySelector('input[name="translationEngine"]:checked').value;

  chrome.storage.sync.set(data, () => {
    const status = document.getElementById("status");
    status.textContent = "Saved!";
    setTimeout(() => (status.textContent = ""), 2000);
  });
});
