const textFields = ["apiKey", "apiBaseUrl", "model", "furiganaPrompt", "translationPrompt"];
const selectFields = ["targetLang", "ttsVoice"];

// Load saved settings
chrome.storage.sync.get([...textFields, ...selectFields, "translationEngine"], (result) => {
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

  if (result.translationEngine === "local") {
    document.getElementById("engineLocal").checked = true;
  } else {
    document.getElementById("engineCloud").checked = true;
  }
});

// Detect Chrome built-in Translator API availability
async function checkLocalAvailability() {
  const statusEl = document.getElementById("localStatus");
  if (!("ai" in self) || !("translator" in self.ai)) {
    statusEl.textContent = "Chrome Built-in AI not available in this browser. Requires Chrome 131+ with Translator API enabled.";
    statusEl.style.color = "#b36b00";
    return;
  }

  try {
    const canTranslate = await self.ai.translator.capabilities();
    const pair = canTranslate.languagePairAvailable("ja", "zh");
    if (pair === "readily") {
      statusEl.textContent = "Japanese → Chinese translation model is ready.";
      statusEl.style.color = "#0d7e3f";
    } else if (pair === "after-download") {
      statusEl.textContent = "Language model needs to be downloaded first. Select Local and save to start download.";
      statusEl.style.color = "#b36b00";
    } else {
      statusEl.textContent = "Japanese → Chinese pair not supported by this browser.";
      statusEl.style.color = "#d93025";
    }
  } catch (err) {
    statusEl.textContent = "Could not check Translator API: " + err.message;
    statusEl.style.color = "#d93025";
  }
}

checkLocalAvailability();

document.getElementById("saveBtn").addEventListener("click", () => {
  const data = {};
  textFields.forEach((key) => {
    const val = document.getElementById(key).value.trim();
    if (val) data[key] = val;
  });

  selectFields.forEach((key) => {
    data[key] = document.getElementById(key).value;
  });

  data.translationEngine = document.querySelector('input[name="translationEngine"]:checked').value;

  chrome.storage.sync.set(data, () => {
    const status = document.getElementById("status");
    status.textContent = "Saved!";
    setTimeout(() => (status.textContent = ""), 2000);
  });
});
