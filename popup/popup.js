import { t, applyI18n } from "../lib/i18n.js";

const bulkBtn = document.getElementById("bulkBtn");
const annotateAllBtn = document.getElementById("annotateAllBtn");
const translateAllBtn = document.getElementById("translateAllBtn");
const vocabBtn = document.getElementById("vocabBtn");
const optionsBtn = document.getElementById("optionsBtn");
const status = document.getElementById("status");

applyI18n();

bulkBtn.addEventListener("click", async () => {
  bulkBtn.disabled = true;
  status.textContent = t("extracting");
  status.className = "";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const data = await chrome.tabs.sendMessage(tab.id, { type: "extractContent" });

    if (data?.error) {
      status.textContent = data.error;
      status.className = "error";
      bulkBtn.disabled = false;
      return;
    }

    if (!data?.content || data.content.length === 0) {
      status.textContent = t("noContent");
      status.className = "error";
      bulkBtn.disabled = false;
      return;
    }

    // Store extracted content and open reader
    await chrome.storage.local.set({ readerData: data });
    chrome.tabs.create({ url: chrome.runtime.getURL("reader/reader.html") });
    window.close();
  } catch (err) {
    status.textContent = err.message;
    status.className = "error";
    bulkBtn.disabled = false;
  }
});

async function handleBulkAction(messageType, btn, statusKey, completeKey) {
  btn.disabled = true;
  annotateAllBtn.disabled = true;
  translateAllBtn.disabled = true;
  status.textContent = t(statusKey);
  status.className = "";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await chrome.tabs.sendMessage(tab.id, { type: messageType });

    if (result?.error) {
      status.textContent = result.error;
      status.className = "error";
    } else {
      status.textContent = t(completeKey, [result?.count || 0]);
    }
  } catch (err) {
    status.textContent = err.message;
    status.className = "error";
  }

  btn.disabled = false;
  annotateAllBtn.disabled = false;
  translateAllBtn.disabled = false;
}

annotateAllBtn.addEventListener("click", () => {
  handleBulkAction("bulkAnnotateOnly", annotateAllBtn, "annotating", "annotateComplete");
});

translateAllBtn.addEventListener("click", () => {
  handleBulkAction("bulkTranslateOnly", translateAllBtn, "translating", "translateComplete");
});

vocabBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("vocabulary/vocabulary.html") });
  window.close();
});

optionsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
