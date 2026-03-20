import { getFurigana, getTranslation, getBulkFurigana } from "../lib/api.js";

let localTranslator = null;

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      ["apiKey", "apiBaseUrl", "model", "furiganaPrompt", "translationPrompt", "bulkFuriganaPrompt", "translationEngine"],
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

// Reset local translator when settings change
chrome.storage.onChanged.addListener((changes) => {
  if (changes.translationEngine) {
    localTranslator = null;
  }
});
