import { getFurigana, getTranslation, getBulkFurigana, streamTranslation, fetchTTS } from "../lib/api.js";

let localTranslator = null;

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      ["apiKey", "apiBaseUrl", "model", "furiganaPrompt", "translationPrompt", "bulkFuriganaPrompt", "translationEngine", "ttsVoice"],
      (result) => resolve(result)
    );
  });
}

async function getLocalTranslator() {
  if (localTranslator) return localTranslator;

  if (!("ai" in self) || !("translator" in self.ai)) {
    throw new Error("Chrome Built-in AI Translator not available. Please switch to Cloud in options.");
  }

  localTranslator = await self.ai.translator.create({
    sourceLanguage: "ja",
    targetLanguage: "zh",
  });

  return localTranslator;
}

async function translateText(settings, text) {
  if (settings.translationEngine === "local") {
    const translator = await getLocalTranslator();
    return await translator.translate(text);
  }
  return await getTranslation(settings, text);
}

// --- Request-response handlers (for content script Alt+Click and legacy bulk) ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "annotate") {
    handleAnnotate(message.text).then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (message.type === "bulkAnnotate") {
    handleBulkAnnotate(message.paragraphs).then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (message.type === "tts") {
    handleTTS(message.text).then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }
});

async function handleAnnotate(text) {
  const settings = await getSettings();
  const [furigana, translation] = await Promise.all([
    getFurigana(settings, text),
    translateText(settings, text),
  ]);
  return { furigana, translation };
}

async function handleBulkAnnotate(paragraphs) {
  const settings = await getSettings();
  const CHUNK_SIZE = 2000;
  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const p of paragraphs) {
    if (currentLen + p.length > CHUNK_SIZE && current.length > 0) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(p);
    currentLen += p.length;
  }
  if (current.length > 0) chunks.push(current);

  const results = [];
  const CONCURRENCY = 2;

  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (chunk) => {
        const [furiganaArrays, translations] = await Promise.all([
          getBulkFurigana(settings, chunk),
          Promise.all(chunk.map((text) => translateText(settings, text))),
        ]);
        return chunk.map((text, j) => ({
          furigana: furiganaArrays[j] || [],
          translation: translations[j] || "",
        }));
      })
    );
    results.push(...batchResults.flat());
  }

  return { results };
}

async function handleTTS(text) {
  const settings = await getSettings();
  const audioDataUrl = await fetchTTS(settings, text);
  return { audioDataUrl };
}

// --- Port-based streaming handler (for reader page) ---

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "kana-tts") {
    let disconnected = false;
    port.onDisconnect.addListener(() => { disconnected = true; });

    port.onMessage.addListener(async (msg) => {
      if (msg.type === "ttsRequest") {
        try {
          const settings = await getSettings();
          const audioDataUrl = await fetchTTS(settings, msg.text);
          if (!disconnected) {
            port.postMessage({ type: "ttsAudio", index: msg.index, audioDataUrl });
          }
        } catch (err) {
          if (!disconnected) {
            port.postMessage({ type: "ttsError", index: msg.index, message: err.message });
          }
        }
      }
    });
    return;
  }

  if (port.name !== "kana-stream") return;

  port.onMessage.addListener((msg) => {
    if (msg.type === "streamTranslate") {
      handleStreamTranslate(port, msg.paragraphs);
    }
  });
});

async function handleStreamTranslate(port, paragraphs) {
  const settings = await getSettings();
  const useLocalTranslation = settings.translationEngine === "local";
  const CONCURRENCY = 3;
  let nextIdx = 0;
  let doneCount = 0;
  let disconnected = false;

  port.onDisconnect.addListener(() => { disconnected = true; });

  function safeSend(msg) {
    if (disconnected) return;
    try { port.postMessage(msg); } catch { disconnected = true; }
  }

  async function processOne(idx, text) {
    try {
      // Start furigana and translation in parallel
      const furiganaPromise = getFurigana(settings, text);

      if (useLocalTranslation) {
        // Local translator: no streaming, send all at once
        const [furigana, translation] = await Promise.all([
          furiganaPromise,
          translateText(settings, text),
        ]);
        safeSend({ type: "furigana", index: idx, tokens: furigana });
        safeSend({ type: "translation", index: idx, text: translation });
      } else {
        // Cloud API: stream translation
        const translationPromise = streamTranslation(settings, text, (chunk) => {
          safeSend({ type: "translationChunk", index: idx, text: chunk });
        });

        const furigana = await furiganaPromise;
        safeSend({ type: "furigana", index: idx, tokens: furigana });

        await translationPromise;
        safeSend({ type: "translationDone", index: idx });
      }
    } catch (err) {
      safeSend({ type: "error", index: idx, message: err.message });
    }

    doneCount++;
    safeSend({ type: "progress", done: doneCount, total: paragraphs.length });

    if (doneCount === paragraphs.length) {
      safeSend({ type: "allDone" });
    }
  }

  // Simple concurrency pool
  async function worker() {
    while (nextIdx < paragraphs.length && !disconnected) {
      const idx = nextIdx++;
      await processOne(idx, paragraphs[idx]);
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, paragraphs.length); i++) {
    workers.push(worker());
  }
  Promise.all(workers);
}

// Reset local translator when settings change
chrome.storage.onChanged.addListener((changes) => {
  if (changes.translationEngine) {
    localTranslator = null;
  }
});
