import { getFurigana, getTranslation, getBulkFurigana, streamTranslation, fetchTTS, getGrammarAnalysisPrompt } from "../lib/api.js";

let localTranslator = null;
let localTranslatorLang = null;

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(
      ["apiKey", "apiBaseUrl", "model", "furiganaModel", "translationModel", "grammarModel", "translationEngine", "ttsVoice", "targetLang"],
      (result) => resolve(result)
    );
  });
}

// Return settings with model overridden for a specific task
function settingsFor(settings, task) {
  const fallback = settings.model || "gpt-4o-mini";
  const modelMap = {
    furigana: settings.furiganaModel || fallback,
    translation: settings.translationModel || fallback,
    grammar: settings.grammarModel || fallback,
  };
  return { ...settings, model: modelMap[task] || fallback };
}

function mapTargetLang(targetLang) {
  // Chrome Translator API uses short language codes
  const map = { "zh-CN": "zh", "zh-TW": "zh-Hant" };
  return map[targetLang] || targetLang;
}

async function getLocalTranslator(targetLang = "zh-CN") {
  const shortLang = mapTargetLang(targetLang);

  if (localTranslator && localTranslatorLang === shortLang) return localTranslator;

  // Recreate if target language changed
  if (localTranslator) {
    localTranslator.destroy?.();
    localTranslator = null;
  }

  if (!("ai" in self) || !("translator" in self.ai)) {
    throw new Error("Chrome Built-in AI Translator not available. Please switch to Cloud in options.");
  }

  localTranslator = await self.ai.translator.create({
    sourceLanguage: "ja",
    targetLanguage: shortLang,
  });
  localTranslatorLang = shortLang;

  return localTranslator;
}

async function translateText(settings, text) {
  if (settings.translationEngine === "local") {
    const translator = await getLocalTranslator(settings.targetLang);
    return await translator.translate(text);
  }
  return await getTranslation(settingsFor(settings, "translation"), text);
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

  if (message.type === "translateWord") {
    handleTranslateWord(message.word).then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }
});

async function handleAnnotate(text) {
  const settings = await getSettings();
  const [furigana, translation] = await Promise.all([
    getFurigana(settingsFor(settings, "furigana"), text),
    translateText(settings, text),
  ]);
  return { furigana, translation };
}

async function handleBulkAnnotate(paragraphs) {
  const settings = await getSettings();
  const targetLang = settings.targetLang || "zh-CN";
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
          getBulkFurigana(settingsFor(settings, "furigana"), chunk),
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

  return { results, targetLang };
}

async function handleTranslateWord(word) {
  const settings = await getSettings();
  const translation = await translateText(settings, word);
  return { translation };
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
      handleStreamTranslate(port, msg.paragraphs, msg.mode || "both");
    }
  });
});

async function handleStreamTranslate(port, paragraphs, mode) {
  const settings = await getSettings();
  const targetLang = settings.targetLang || "zh-CN";
  const useLocalTranslation = settings.translationEngine === "local";
  const CONCURRENCY = 3;
  let nextIdx = 0;

  // Inform client of target language for lang/dir attributes
  if (mode !== "annotate") {
    try { port.postMessage({ type: "langInfo", targetLang }); } catch {}
  }
  let doneCount = 0;
  let disconnected = false;

  port.onDisconnect.addListener(() => { disconnected = true; });

  function safeSend(msg) {
    if (disconnected) return;
    try { port.postMessage(msg); } catch { disconnected = true; }
  }

  async function processOne(idx, text) {
    try {
      if (mode === "grammar") {
        const grammarPrompt = getGrammarAnalysisPrompt(targetLang);
        const grammarSettings = settingsFor(settings, "grammar");
        await streamTranslation(
          { ...grammarSettings, translationPrompt: grammarPrompt },
          text,
          (chunk) => { safeSend({ type: "grammarChunk", index: idx, text: chunk }); }
        );
        safeSend({ type: "grammarDone", index: idx });
      } else if (mode === "annotate") {
        const furigana = await getFurigana(settingsFor(settings, "furigana"), text);
        safeSend({ type: "furigana", index: idx, tokens: furigana });
      } else if (mode === "translate") {
        if (useLocalTranslation) {
          const translation = await translateText(settings, text);
          safeSend({ type: "translation", index: idx, text: translation });
        } else {
          const translationPromise = streamTranslation(settingsFor(settings, "translation"), text, (chunk) => {
            safeSend({ type: "translationChunk", index: idx, text: chunk });
          });
          await translationPromise;
          safeSend({ type: "translationDone", index: idx });
        }
      } else {
        // "both" — original behavior
        const furiganaPromise = getFurigana(settingsFor(settings, "furigana"), text);

        if (useLocalTranslation) {
          const [furigana, translation] = await Promise.all([
            furiganaPromise,
            translateText(settings, text),
          ]);
          safeSend({ type: "furigana", index: idx, tokens: furigana });
          safeSend({ type: "translation", index: idx, text: translation });
        } else {
          const translationPromise = streamTranslation(settingsFor(settings, "translation"), text, (chunk) => {
            safeSend({ type: "translationChunk", index: idx, text: chunk });
          });

          const furigana = await furiganaPromise;
          safeSend({ type: "furigana", index: idx, tokens: furigana });

          await translationPromise;
          safeSend({ type: "translationDone", index: idx });
        }
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
  await Promise.all(workers);
}

// Reset local translator when settings change
chrome.storage.onChanged.addListener((changes) => {
  if (changes.translationEngine || changes.targetLang) {
    if (localTranslator) {
      localTranslator.destroy?.();
    }
    localTranslator = null;
    localTranslatorLang = null;
  }
});
