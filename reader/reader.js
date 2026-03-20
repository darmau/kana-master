const JP_REGEX = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/;

const translateBtn = document.getElementById("translateBtn");
const deleteSelBtn = document.getElementById("deleteSelBtn");
const progress = document.getElementById("progress");
const hint = document.getElementById("hint");
const readerTitle = document.getElementById("reader-title");
const readerBody = document.getElementById("reader-body");
const originalLink = document.getElementById("originalLink");

// --- Selection state ---
let lastClickedBlock = null;

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function tokensToHtml(tokens) {
  return tokens
    .map((tok) => {
      if (tok.r) {
        return `<ruby>${escapeHtml(tok.t)}<rp>(</rp><rt>${escapeHtml(tok.r)}</rt><rp>)</rp></ruby>`;
      }
      return escapeHtml(tok.t);
    })
    .join("");
}

function getAllBlocks() {
  return Array.from(readerBody.querySelectorAll(".reader-block"));
}

function clearSelection() {
  for (const b of getAllBlocks()) b.classList.remove("block-selected");
  lastClickedBlock = null;
  updateDeleteBtn();
}

function getSelectedBlocks() {
  return getAllBlocks().filter((b) => b.classList.contains("block-selected"));
}

function updateDeleteBtn() {
  const count = getSelectedBlocks().length;
  deleteSelBtn.hidden = count === 0;
  deleteSelBtn.textContent = `Delete (${count})`;
}

function deleteSelected() {
  for (const b of getSelectedBlocks()) b.remove();
  lastClickedBlock = null;
  updateDeleteBtn();
}

function handleBlockClick(e) {
  const block = e.target.closest(".reader-block");
  if (!block || readerBody.classList.contains("reader-locked")) return;

  if (e.target.closest(".block-delete")) return;
  if (e.target.isContentEditable && !e.shiftKey) return;

  if (e.shiftKey && lastClickedBlock) {
    e.preventDefault();
    const blocks = getAllBlocks();
    const from = blocks.indexOf(lastClickedBlock);
    const to = blocks.indexOf(block);
    if (from === -1 || to === -1) return;
    const [start, end] = from < to ? [from, to] : [to, from];
    for (let i = start; i <= end; i++) {
      blocks[i].classList.add("block-selected");
    }
  } else {
    block.classList.toggle("block-selected");
    lastClickedBlock = block.classList.contains("block-selected") ? block : null;
  }

  updateDeleteBtn();
  if (e.shiftKey) window.getSelection()?.removeAllRanges();
}

readerBody.addEventListener("click", handleBlockClick);
deleteSelBtn.addEventListener("click", deleteSelected);

document.addEventListener("keydown", (e) => {
  if (readerBody.classList.contains("reader-locked")) return;
  if (e.target.isContentEditable) return;

  if ((e.key === "Delete" || e.key === "Backspace") && getSelectedBlocks().length > 0) {
    e.preventDefault();
    deleteSelected();
  }
  if (e.key === "Escape") {
    clearSelection();
  }
});

function createBlock(tag, text) {
  const wrapper = document.createElement("div");
  wrapper.className = "reader-block";

  const el = document.createElement(tag);
  el.textContent = text;
  el.setAttribute("contenteditable", "true");
  el.setAttribute("spellcheck", "false");

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "block-delete";
  deleteBtn.textContent = "\u00d7";
  deleteBtn.title = "Remove this paragraph";
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    wrapper.remove();
    updateDeleteBtn();
  });

  wrapper.appendChild(el);
  wrapper.appendChild(deleteBtn);
  return wrapper;
}

async function loadContent() {
  const { readerData } = await chrome.storage.local.get("readerData");
  if (!readerData) {
    readerBody.innerHTML = "<p>No content to display.</p>";
    return;
  }

  document.title = `${readerData.title} - Kana Master`;
  readerTitle.textContent = readerData.title;
  originalLink.href = readerData.url;

  for (const item of readerData.content) {
    if (item.tag === "img") continue;
    readerBody.appendChild(createBlock(item.tag, item.text));
  }

  chrome.storage.local.remove("readerData");
}

// --- Streaming translation via port ---

function translateAll() {
  clearSelection();
  readerBody.classList.add("reader-locked");
  readerBody.querySelectorAll("[contenteditable]").forEach((el) => {
    el.removeAttribute("contenteditable");
  });
  if (hint) hint.remove();
  deleteSelBtn.hidden = true;

  const elements = Array.from(
    readerBody.querySelectorAll("p, li, h2, h3, h4, h5, h6, blockquote, figcaption, pre")
  ).filter((el) => JP_REGEX.test(el.textContent) && el.textContent.trim().length > 0);

  if (elements.length === 0) {
    progress.textContent = "No Japanese text found.";
    return;
  }

  translateBtn.disabled = true;
  const total = elements.length;
  progress.textContent = `0 / ${total}`;

  // Mark all as loading
  elements.forEach((el) => el.classList.add("kana-loading"));

  // Prepare translation divs for streaming
  const transDivs = elements.map((el) => {
    const transDiv = document.createElement("div");
    transDiv.className = "reader-translation";
    transDiv.lang = "zh-CN";
    el.closest(".reader-block").after(transDiv);
    return transDiv;
  });

  const texts = elements.map((el) => el.textContent);

  // Open port to service worker
  const port = chrome.runtime.connect({ name: "kana-stream" });

  port.onMessage.addListener((msg) => {
    if (msg.type === "furigana") {
      const el = elements[msg.index];
      el.classList.remove("kana-loading");
      if (msg.tokens && msg.tokens.length > 0) {
        el.innerHTML = tokensToHtml(msg.tokens);
        el.classList.add("kana-annotated");
      }
    }

    if (msg.type === "translationChunk") {
      transDivs[msg.index].textContent += msg.text;
    }

    if (msg.type === "translation") {
      // Non-streaming (local translator) — set all at once
      transDivs[msg.index].textContent = msg.text;
    }

    if (msg.type === "translationDone") {
      // Streaming complete for this paragraph — nothing extra needed
    }

    if (msg.type === "progress") {
      progress.textContent = `${msg.done} / ${total}`;
    }

    if (msg.type === "error") {
      const el = elements[msg.index];
      el.classList.remove("kana-loading");
      transDivs[msg.index].textContent = `Error: ${msg.message}`;
      transDivs[msg.index].classList.add("error");
    }

    if (msg.type === "allDone") {
      progress.textContent = `Done! ${total} paragraphs.`;
      translateBtn.textContent = "完了";
      port.disconnect();
    }
  });

  port.postMessage({ type: "streamTranslate", paragraphs: texts });
}

translateBtn.addEventListener("click", translateAll);

loadContent();
