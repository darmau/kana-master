const JP_REGEX = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/;

const translateBtn = document.getElementById("translateBtn");
const progress = document.getElementById("progress");
const readerTitle = document.getElementById("reader-title");
const readerBody = document.getElementById("reader-body");
const originalLink = document.getElementById("originalLink");

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

// Load extracted content from storage
async function loadContent() {
  const { readerData } = await chrome.storage.local.get("readerData");
  if (!readerData) {
    readerBody.innerHTML = "<p>No content to display.</p>";
    return;
  }

  document.title = `${readerData.title} - Kana Master`;
  readerTitle.textContent = readerData.title;
  originalLink.href = readerData.url;

  // Render extracted paragraphs
  for (const item of readerData.content) {
    const el = document.createElement(item.tag);
    el.textContent = item.text;
    if (item.tag === "img") {
      el.src = item.src;
      el.alt = item.alt || "";
    }
    readerBody.appendChild(el);
  }

  // Clean up storage
  chrome.storage.local.remove("readerData");
}

// Translate all paragraphs in reader view
async function translateAll() {
  const elements = Array.from(
    readerBody.querySelectorAll("p, li, h2, h3, h4, h5, h6, blockquote, figcaption")
  ).filter((el) => JP_REGEX.test(el.textContent) && el.textContent.trim().length > 0);

  if (elements.length === 0) {
    progress.textContent = "No Japanese text found.";
    return;
  }

  translateBtn.disabled = true;
  let done = 0;
  const total = elements.length;
  progress.textContent = `0 / ${total}`;

  // Process elements in chunks for the bulk API
  const CHUNK_SIZE = 2000;
  const chunks = [];
  let current = [];
  let currentLen = 0;
  const chunkElementMap = []; // maps chunk index to element indices

  for (let i = 0; i < elements.length; i++) {
    const text = elements[i].textContent;
    if (currentLen + text.length > CHUNK_SIZE && current.length > 0) {
      chunks.push(current);
      chunkElementMap.push([...Array(current.length)].map((_, j) => i - current.length + j));
      current = [];
      currentLen = 0;
    }
    current.push(text);
    currentLen += text.length;
  }
  if (current.length > 0) {
    const startIdx = elements.length - current.length;
    chunks.push(current);
    chunkElementMap.push(current.map((_, j) => startIdx + j));
  }

  // Process chunks sequentially (2 concurrent)
  const CONCURRENCY = 2;
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    const batchMaps = chunkElementMap.slice(i, i + CONCURRENCY);

    // Mark elements as loading
    for (const map of batchMaps) {
      for (const idx of map) {
        elements[idx].classList.add("kana-loading");
      }
    }

    try {
      const batchResults = await Promise.all(
        batch.map((chunk) =>
          chrome.runtime.sendMessage({ type: "bulkAnnotate", paragraphs: chunk })
        )
      );

      for (let b = 0; b < batchResults.length; b++) {
        const response = batchResults[b];
        const map = batchMaps[b];
        const results = response.results || [];

        for (let j = 0; j < results.length && j < map.length; j++) {
          const el = elements[map[j]];
          el.classList.remove("kana-loading");

          if (results[j].furigana && results[j].furigana.length > 0) {
            el.innerHTML = tokensToHtml(results[j].furigana);
            el.classList.add("kana-annotated");
          }

          if (results[j].translation) {
            const transDiv = document.createElement("div");
            transDiv.className = "reader-translation";
            transDiv.lang = "zh-CN";
            transDiv.textContent = results[j].translation;
            el.after(transDiv);
          }

          done++;
          progress.textContent = `${done} / ${total}`;
        }
      }
    } catch (err) {
      progress.textContent = `Error: ${err.message}`;
      progress.classList.add("error");
      translateBtn.disabled = false;
      return;
    }
  }

  progress.textContent = `Done! ${done} paragraphs translated.`;
  translateBtn.textContent = "完了";
  translateBtn.disabled = true;
}

translateBtn.addEventListener("click", translateAll);

loadContent();
