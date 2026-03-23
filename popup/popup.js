const bulkBtn = document.getElementById("bulkBtn");
const vocabBtn = document.getElementById("vocabBtn");
const optionsBtn = document.getElementById("optionsBtn");
const status = document.getElementById("status");

bulkBtn.addEventListener("click", async () => {
  bulkBtn.disabled = true;
  status.textContent = "Extracting content...";
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
      status.textContent = "No content found on this page.";
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

vocabBtn.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("vocabulary/vocabulary.html") });
  window.close();
});

optionsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
