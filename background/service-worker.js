import { getFurigana, getTranslation, streamTranslation, fetchTTS, getTranslationPrompt, getGrammarAnalysisPrompt, generateVocabEntry, generateQuiz } from "../lib/api.js";

const SETTINGS_KEYS = [
  "openaiKey", "anthropicKey", "googleKey", "openaiBaseUrl",
  "furiganaModel", "translationModel", "grammarModel", "quizModel", "ttsModel",
  "ttsVoice", "targetLang", "jlptLevel",
];

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(SETTINGS_KEYS, (result) => resolve(result));
  });
}

// Return settings with model overridden for a specific task
function settingsFor(settings, task) {
  const modelMap = {
    furigana: settings.furiganaModel,
    translation: settings.translationModel,
    grammar: settings.grammarModel,
    quiz: settings.quizModel,
  };
  return { ...settings, model: modelMap[task] || settings.furiganaModel };
}

async function translateText(settings, text) {
  return await getTranslation(settingsFor(settings, "translation"), text);
}

// --- Request-response handlers ---

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "annotate") {
    handleAnnotate(message.text, message.upgrade).then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (message.type === "bulkAnnotate") {
    handleBulkAnnotate(message.paragraphs, message.mode).then(sendResponse).catch((err) =>
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

  if (message.type === "generateQuiz") {
    handleGenerateQuiz(message.text, message.jlptLevel).then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }

  if (message.type === "generateVocabEntry") {
    handleGenerateVocabEntry(message.word, message.sentence).then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }
});

async function handleAnnotate(text, upgrade) {
  const settings = await getSettings();
  const furiganaTask = upgrade ? "grammar" : "furigana";
  const [furiganaResult, translation] = await Promise.all([
    getFurigana(settingsFor(settings, furiganaTask), text),
    translateText(settings, text),
  ]);
  return { furigana: furiganaResult.tokens, rawTokens: furiganaResult.rawTokens, translation };
}

async function handleBulkAnnotate(paragraphs, mode = "both") {
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

  const needsFurigana = mode === "both" || mode === "annotate";
  const needsTranslation = mode === "both" || mode === "translate";

  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (chunk) => {
        const [furiganaResults, translations] = await Promise.all([
          needsFurigana
            ? Promise.all(chunk.map((text) => getFurigana(settingsFor(settings, "furigana"), text)))
            : Promise.resolve(chunk.map(() => ({ tokens: [], rawTokens: [] }))),
          needsTranslation
            ? Promise.all(chunk.map((text) => translateText(settings, text)))
            : Promise.resolve(chunk.map(() => "")),
        ]);
        return chunk.map((_, j) => ({
          furigana: (furiganaResults[j] && furiganaResults[j].tokens) || [],
          translation: translations[j] || "",
        }));
      })
    );
    results.push(...batchResults.flat());
  }

  return { results, targetLang };
}

async function handleGenerateQuiz(text, jlptLevel) {
  const settings = await getSettings();
  const quiz = await generateQuiz(settingsFor(settings, "quiz"), text, jlptLevel);
  return { quiz };
}

async function handleGenerateVocabEntry(word, sentence) {
  const settings = await getSettings();
  const entry = await generateVocabEntry(settingsFor(settings, "translation"), word, sentence);
  // Use provided sentence, or AI-generated example sentence
  const effectiveSentence = sentence || entry?.exampleSentence || "";
  const sentenceTranslation = effectiveSentence ? await translateText(settings, effectiveSentence) : "";
  return { entry, sentenceTranslation, generatedSentence: sentence ? "" : effectiveSentence };
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
      handleStreamTranslate(port, msg.paragraphs, msg.mode || "both", msg.upgrade);
    }
  });
});

async function handleStreamTranslate(port, paragraphs, mode, upgrade) {
  const settings = await getSettings();
  const targetLang = settings.targetLang || "zh-CN";
  const furiganaTask = upgrade ? "grammar" : "furigana";
  const CONCURRENCY = 3;
  let nextIdx = 0;

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

  // Split text into sentences by 。and group into chunks of SENTENCES_PER_CHUNK.
  // Each chunk is a string (sentences joined back together).
  const SENTENCES_PER_CHUNK = 5;
  function splitSentences(text) {
    // Split after each 。, keeping the delimiter attached to the preceding sentence
    const parts = text.split(/(?<=。)/);
    if (parts.length <= SENTENCES_PER_CHUNK) return [text];
    const chunks = [];
    for (let i = 0; i < parts.length; i += SENTENCES_PER_CHUNK) {
      chunks.push(parts.slice(i, i + SENTENCES_PER_CHUNK).join(""));
    }
    return chunks;
  }

  async function processFuriganaChunked(idx, text) {
    const chunks = splitSentences(text);
    if (chunks.length === 1) {
      const result = await getFurigana(settingsFor(settings, furiganaTask), text);
      safeSend({ type: "furigana", index: idx, tokens: result.tokens, rawTokens: result.rawTokens });
      return;
    }
    // Process chunks sequentially, send partial results as they arrive
    let allTokens = [];
    let allRawTokens = [];
    for (const chunk of chunks) {
      const result = await getFurigana(settingsFor(settings, furiganaTask), chunk);
      allTokens = allTokens.concat(result.tokens);
      allRawTokens = allRawTokens.concat(result.rawTokens);
      safeSend({ type: "furiganaPartial", index: idx, tokens: allTokens, rawTokens: allRawTokens });
    }
    safeSend({ type: "furigana", index: idx, tokens: allTokens, rawTokens: allRawTokens });
  }

  async function processOne(idx, text) {
    try {
      if (mode === "grammar") {
        const grammarPrompt = getGrammarAnalysisPrompt(targetLang);
        await streamTranslation(
          settingsFor(settings, "grammar"),
          grammarPrompt,
          text,
          (chunk) => { safeSend({ type: "grammarChunk", index: idx, text: chunk }); }
        );
        safeSend({ type: "grammarDone", index: idx });
      } else if (mode === "annotate") {
        await processFuriganaChunked(idx, text);
      } else if (mode === "translate") {
        const translationPrompt = getTranslationPrompt(targetLang);
        await streamTranslation(settingsFor(settings, "translation"), translationPrompt, text, (chunk) => {
          safeSend({ type: "translationChunk", index: idx, text: chunk });
        });
        safeSend({ type: "translationDone", index: idx });
      } else {
        // "both" — furigana + translation
        const furiganaPromise = processFuriganaChunked(idx, text);
        const translationPrompt = getTranslationPrompt(targetLang);
        const translationPromise = streamTranslation(settingsFor(settings, "translation"), translationPrompt, text, (chunk) => {
          safeSend({ type: "translationChunk", index: idx, text: chunk });
        });

        await furiganaPromise;
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

