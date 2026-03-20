const bulkBtn = document.getElementById("bulkBtn");
const optionsBtn = document.getElementById("optionsBtn");
const status = document.getElementById("status");

bulkBtn.addEventListener("click", async () => {
  bulkBtn.disabled = true;
  status.textContent = "Translating...";
  status.className = "";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const response = await chrome.tabs.sendMessage(tab.id, { type: "bulkTranslate" });

    if (response?.error) {
      status.textContent = response.error;
      status.className = "error";
    } else {
      status.textContent = `Done! Annotated ${response?.count || 0} paragraphs.`;
    }
  } catch (err) {
    status.textContent = err.message;
    status.className = "error";
  }

  bulkBtn.disabled = false;
});

optionsBtn.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
