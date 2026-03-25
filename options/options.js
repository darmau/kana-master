import { t, applyI18n } from "../lib/i18n.js";

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
