import { t, applyI18n } from "../lib/i18n.js";
import { PROVIDER_KEYS } from "../lib/storage.js";

applyI18n();

// This page manages API keys + base URL + the site blacklist; read just those
// plus the legacy key for migration.
const ALL_SETTINGS_KEYS = [...Object.values(PROVIDER_KEYS), "openaiBaseUrl", "apiKey", "blacklist"];

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
  if (result.elevenlabsKey) document.getElementById("elevenlabsKey").value = result.elevenlabsKey;
  if (result.openaiBaseUrl) document.getElementById("openaiBaseUrl").value = result.openaiBaseUrl;
  if (Array.isArray(result.blacklist)) {
    document.getElementById("blacklistInput").value = result.blacklist.join("\n");
  }

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
    } else if (provider === "elevenlabs") {
      const key = document.getElementById("elevenlabsKey").value.trim();
      if (!key) throw new Error("No API key");
      const res = await fetch("https://api.elevenlabs.io/v1/voices", {
        headers: { "xi-api-key": key },
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
document.getElementById("testElevenlabs").addEventListener("click", () => testProvider("elevenlabs"));

// --- Site blacklist ---

// Users paste anything from bare domains to full URLs; reduce each line to a
// bare lowercase hostname so matching (KanaShared.isHostBlacklisted) stays simple.
function normalizeBlacklistEntry(line) {
  let s = line.trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  s = s.split(/[/?#]/, 1)[0]; // path / query / hash
  s = s.replace(/^[^@]*@/, ""); // userinfo
  s = s.replace(/:\d+$/, ""); // port
  return s;
}

function parseBlacklist() {
  const lines = document.getElementById("blacklistInput").value.split("\n");
  return [...new Set(lines.map(normalizeBlacklistEntry).filter(Boolean))];
}

// --- Save ---

document.getElementById("saveBtn").addEventListener("click", () => {
  const data = {};

  const openaiKey = document.getElementById("openaiKey").value.trim();
  const anthropicKey = document.getElementById("anthropicKey").value.trim();
  const googleKey = document.getElementById("googleKey").value.trim();
  const elevenlabsKey = document.getElementById("elevenlabsKey").value.trim();
  const openaiBaseUrl = document.getElementById("openaiBaseUrl").value.trim();
  if (openaiKey) data.openaiKey = openaiKey;
  if (anthropicKey) data.anthropicKey = anthropicKey;
  if (googleKey) data.googleKey = googleKey;
  if (elevenlabsKey) data.elevenlabsKey = elevenlabsKey;
  if (openaiBaseUrl) data.openaiBaseUrl = openaiBaseUrl;

  // Always write the blacklist (unlike keys) so clearing the textarea clears it
  data.blacklist = parseBlacklist();
  document.getElementById("blacklistInput").value = data.blacklist.join("\n");

  chrome.storage.sync.set(data, () => {
    const status = document.getElementById("status");
    status.textContent = t("saved");
    setTimeout(() => (status.textContent = ""), 2000);
  });
});
