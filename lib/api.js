import { PROVIDERS, DEFAULT_CHAT_MODEL, DEFAULT_TTS_MODEL } from "./models.js";

const MAX_RETRIES = 3;
const TIMEOUT_MS = 30000;
const TTS_TIMEOUT_MS = 60000;

// === Prompts ===

// --- One-step furigana prompt (original) ---

const DEFAULT_FURIGANA_PROMPT = `You are a Japanese language expert. Given Japanese text, return a JSON object {"tokens": [...]} where each element represents a word or segment. Rules:
- Segment by WORDS, not by character type. A word that contains both kanji and hiragana (e.g., 多い, 食べる, 美しい, 行きたい) must be kept as ONE token — never split kanji from its okurigana.
- Words containing kanji: {"t":"原文","r":"ひらがな reading of the whole word"}. Add furigana to ALL kanji without exception — even common ones like 日, 人, 大. Examples: {"t":"多い","r":"おおい"}, {"t":"食べる","r":"たべる"}, {"t":"美しい","r":"うつくしい"}.
- Katakana words — distinguish by origin:
  - Foreign loanwords (外来語): annotate with the original foreign word. E.g., {"t":"コンピューター","r":"computer"}, {"t":"アルバイト","r":"Arbeit"}.
  - Native Japanese words written in katakana (for emphasis, style, or convention): annotate with the standard kanji or hiragana form. E.g., {"t":"キレイ","r":"綺麗"}, {"t":"ダメ","r":"駄目"}, {"t":"ヤバい","r":"やばい"}, {"t":"ウマい","r":"旨い"}, {"t":"デキる","r":"出来る"}.
- Words with katakana substituting for kanji (交ぜ書き): keep as one token and annotate with the full standard kanji form. E.g., {"t":"皮フ科","r":"皮膚科"}, {"t":"ねつ造","r":"捏造"}, {"t":"隠ぺい","r":"隠蔽"}.
- Pure hiragana words (particles, etc.), punctuation, Arabic numerals (0-9), or non-Japanese text: {"t":"原文"} (no "r" field).
- Keep compound words together (e.g., 東京都 → {"t":"東京都","r":"とうきょうと"}).
- Concatenating all "t" fields MUST exactly reproduce the input.
Return ONLY JSON.`;


const LANGUAGE_NAMES = {
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
  "ko": "Korean",
  "en": "English",
  "fr": "French",
  "es": "Spanish",
  "de": "German",
  "ar": "Arabic",
  "ru": "Russian",
  "ne": "Nepali",
  "vi": "Vietnamese",
  "my": "Burmese",
  "fil": "Filipino",
  "pt": "Portuguese",
  "it": "Italian",
  "id": "Indonesian",
  "ms": "Malay",
  "th": "Thai",
};

function getTranslationPrompt(targetLang) {
  const langName = LANGUAGE_NAMES[targetLang] || "Simplified Chinese";
  return `You are a Japanese-to-${langName} translator. Translate the following Japanese text into natural ${langName}. Return ONLY the translation.`;
}

const DEFAULT_BULK_FURIGANA_PROMPT = `You are a Japanese language expert. You will receive multiple paragraphs separated by ===PARA===. For each paragraph, produce a token array. Return a JSON object {"paragraphs": [[tokens], [tokens], ...]}. Rules:
- Segment by WORDS, not by character type. A word that contains both kanji and hiragana (e.g., 多い, 食べる, 美しい) must be kept as ONE token — never split kanji from its okurigana.
- Words containing kanji: {"t":"原文","r":"ひらがな reading of the whole word"}. Add furigana to ALL kanji without exception — even common ones like 日, 人, 大. Examples: {"t":"多い","r":"おおい"}, {"t":"食べる","r":"たべる"}.
- Katakana words — foreign loanwords: annotate with the original foreign word (e.g., {"t":"コンピューター","r":"computer"}). Native Japanese words in katakana: annotate with standard kanji/hiragana (e.g., {"t":"キレイ","r":"綺麗"}, {"t":"ダメ","r":"駄目"}).
- Words with katakana substituting for kanji (交ぜ書き): annotate with full kanji form (e.g., {"t":"皮フ科","r":"皮膚科"}, {"t":"ねつ造","r":"捏造"}).
- Pure hiragana words (particles, etc.), punctuation, Arabic numerals (0-9), or non-Japanese text: {"t":"原文"} (no "r" field).
- Keep compound words together (e.g., 東京都, 食べ物).
- Concatenating all "t" fields in each paragraph MUST exactly reproduce that paragraph's input.
Return ONLY JSON.`;

function getVocabEntryPrompt(targetLang) {
  const langName = LANGUAGE_NAMES[targetLang] || "Simplified Chinese";
  return `You are a Japanese dictionary expert. Given a Japanese word and the sentence it appears in, generate a dictionary entry. Return a JSON object with these fields:

- "originalText": the word exactly as it appears in the sentence (string)
- "dictionaryForm": the dictionary/lemma form of the word (string, may be same as originalText)
- "reading": the hiragana reading of the dictionary form (string)
- "partOfSpeech": part of speech in ${langName} (string, e.g. "动词"/"名词"/"形容词"/"副词"/"助词" etc.)
- "definition": brief definition in ${langName} (string)

If the word is a **verb**, also include:
- "verbType": verb classification in ${langName} (e.g. "五段動詞"/"一段動詞"/"サ変動詞"/"カ変動詞")
- "conjugations": object with common conjugation forms:
  {"ます形":"...","て形":"...","ない形":"...","た形":"...","意志形":"...","仮定形":"..."}

If the word is an **い-adjective**, also include:
- "adjectiveType": "い形容詞"
- "adjectiveConjugations": {"く形":"...","くない":"...","かった":"...","くなかった":"..."}

If the word is a **な-adjective**, also include:
- "adjectiveType": "な形容詞"
- "adjectiveConjugations": {"に形":"...","ではない":"...","だった":"...","ではなかった":"..."}

For other parts of speech, omit verb/adjective-specific fields.

Return ONLY JSON.`;
}

function getGrammarAnalysisPrompt(targetLang) {
  const langName = LANGUAGE_NAMES[targetLang] || "Simplified Chinese";
  return `You are a Japanese tutor helping a learner read native text. Explain the grammar of the given sentence in ${langName}. Use Markdown. Use \`code\` for Japanese, **bold** for grammar term names.

Rules:
- Skip anything obvious (は marks topic, を marks object, etc.) — only explain particles when their usage is non-trivial or easily confused
- Focus on: verb/adjective conjugation forms, grammar patterns, and sentence structure that a learner might struggle with
- For conjugations, show: \`conjugated\` ← \`辞書形\` (**form name**)
- For grammar patterns (e.g. ～てしまう、～ことにする), give the pattern name and briefly explain its meaning/nuance
- If the sentence is simple with no noteworthy grammar, just say so in one line
- Be brief. A short sentence needs only a few bullet points, not multiple sections
- Do not add any follow-up offers, suggestions, or conversational remarks at the end. Output only the grammar analysis itself`;
}

function getQuizPrompt(targetLang, jlptLevel) {
  const langName = LANGUAGE_NAMES[targetLang] || "Simplified Chinese";
  return `You are a Japanese reading comprehension quiz generator. Given a Japanese text and a student's JLPT level, generate 5 multiple-choice questions to test reading comprehension.

The student's JLPT level is ${jlptLevel}. Adjust question difficulty accordingly:
- N5/N4: Focus on factual information extraction, basic vocabulary recognition, and straightforward content comprehension
- N3: Mix of factual questions and light inferential questions
- N2/N1: Focus on inference, author's intent, tone, nuance, and implicit meaning (but never beyond what the text discusses)

Return a JSON object:
{
  "difficulty": <1-10 integer rating the text's difficulty>,
  "questions": [
    {
      "question": "<question text in Japanese>",
      "options": ["<option A in Japanese>", "<option B>", "<option C>", "<option D>"],
      "answer": <0-3 index of the correct option>,
      "explanation": "<brief explanation in ${langName}>"
    }
  ]
}

Rules:
- Generate exactly 5 questions with exactly 4 options each
- Questions and options MUST be written in Japanese
- Explanations MUST be written in ${langName}
- All questions must be answerable solely from the given text
- The "difficulty" score should reflect the actual text complexity (1=very easy, 10=very hard), independent of the student's level
- Return ONLY valid JSON, no other text`;
}

// === Provider routing ===

function parseModelId(modelId) {
  const slash = modelId.indexOf("/");
  if (slash === -1) return { provider: "openai", model: modelId };
  return { provider: modelId.substring(0, slash), model: modelId.substring(slash + 1) };
}

function getProviderKey(settings, provider) {
  const keyMap = { openai: "openaiKey", anthropic: "anthropicKey", google: "googleKey" };
  const key = settings[keyMap[provider]];
  if (!key) throw new Error(`${PROVIDERS[provider]?.name || provider} API key not configured. Please set it in the extension options.`);
  return key;
}

function getBaseUrl(settings, provider) {
  if (provider === "openai") return (settings.openaiBaseUrl || PROVIDERS.openai.defaultBaseUrl).replace(/\/+$/, "");
  return PROVIDERS[provider]?.defaultBaseUrl || "";
}

// === Utilities ===

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);

      if (res.status === 429 && i < retries) {
        await sleep(Math.pow(2, i) * 1000);
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`API error ${res.status}: ${body}`);
      }

      return await res.json();
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === "AbortError") throw new Error("Request timed out after 30s");
      if (i === retries) throw err;
      await sleep(Math.pow(2, i) * 1000);
    }
  }
}

function parseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) return JSON.parse(match[1].trim());
    throw new Error("Failed to parse JSON response");
  }
}

function isHiraganaOrPlain(str) {
  return /^[\u3040-\u309f\u0000-\u00ff\u2000-\u206f\uff00-\uffef\s\d、。！？「」『』（）・ー〜…]+$/.test(str);
}

function isKatakana(str) {
  return /^[\u30A0-\u30FF\u31F0-\u31FFー・]+$/.test(str);
}

function cleanFuriganaTokens(tokens) {
  return tokens.map((tok) => {
    if (!tok.r) return tok;
    // Remove ruby if it's identical to the original text
    if (tok.r === tok.t) return { t: tok.t };
    // Remove ruby from pure hiragana / plain text (no kanji to annotate)
    if (isHiraganaOrPlain(tok.t)) return { t: tok.t };
    // If original is katakana and ruby is also katakana, the model just echoed it back — remove
    if (isKatakana(tok.t) && isKatakana(tok.r)) return { t: tok.t };
    return tok;
  });
}

// === Provider: OpenAI ===

async function openaiChat(apiKey, baseUrl, model, systemPrompt, userMessage, jsonMode) {
  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature: 0.1,
  };
  if (jsonMode) body.response_format = { type: "json_object" };

  const data = await fetchWithRetry(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  return data.choices[0].message.content.trim();
}

async function openaiStream(apiKey, baseUrl, model, systemPrompt, userMessage, onChunk) {
  const controller = new AbortController();
  const initialTimeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0.1,
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(initialTimeout);
    if (err.name === "AbortError") throw new Error("Stream request timed out after 30s");
    throw err;
  }
  clearTimeout(initialTimeout);
  if (!res.ok) { const body = await res.text(); throw new Error(`API error ${res.status}: ${body}`); }

  await readSSE(res, controller, (data) => data.choices[0]?.delta?.content, onChunk);
}

// === Provider: Anthropic ===

async function anthropicChat(apiKey, model, systemPrompt, userMessage) {
  const data = await fetchWithRetry("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      temperature: 0.1,
    }),
  });
  return data.content[0].text.trim();
}

async function anthropicStream(apiKey, model, systemPrompt, userMessage, onChunk) {
  const controller = new AbortController();
  const initialTimeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
        temperature: 0.1,
        stream: true,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(initialTimeout);
    if (err.name === "AbortError") throw new Error("Stream request timed out after 30s");
    throw err;
  }
  clearTimeout(initialTimeout);
  if (!res.ok) { const body = await res.text(); throw new Error(`API error ${res.status}: ${body}`); }

  await readSSE(res, controller, (data) => {
    if (data.type === "content_block_delta") return data.delta?.text;
    return null;
  }, onChunk);
}

// === Provider: Google ===

function googleUrl(model, stream = false) {
  const action = stream ? "streamGenerateContent?alt=sse" : "generateContent";
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:${action}`;
}

function googleHeaders(apiKey) {
  return { "Content-Type": "application/json", "x-goog-api-key": apiKey };
}

function googleBody(systemPrompt, userMessage) {
  return {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ parts: [{ text: userMessage }] }],
    generationConfig: { temperature: 0.1 },
  };
}

async function googleChat(apiKey, model, systemPrompt, userMessage, jsonMode) {
  const body = googleBody(systemPrompt, userMessage);
  if (jsonMode) body.generationConfig.responseMimeType = "application/json";

  const data = await fetchWithRetry(googleUrl(model), {
    method: "POST",
    headers: googleHeaders(apiKey),
    body: JSON.stringify(body),
  });
  return data.candidates[0].content.parts[0].text.trim();
}

async function googleStream(apiKey, model, systemPrompt, userMessage, onChunk) {
  const controller = new AbortController();
  const initialTimeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(googleUrl(model, true), {
      method: "POST",
      headers: googleHeaders(apiKey),
      body: JSON.stringify(googleBody(systemPrompt, userMessage)),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(initialTimeout);
    if (err.name === "AbortError") throw new Error("Stream request timed out after 30s");
    throw err;
  }
  clearTimeout(initialTimeout);
  if (!res.ok) { const body = await res.text(); throw new Error(`API error ${res.status}: ${body}`); }

  await readSSE(res, controller, (data) => data.candidates?.[0]?.content?.parts?.[0]?.text, onChunk);
}

// === SSE reader (shared) ===

async function readSSE(res, controller, extractText, onChunk) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let idleTimer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6);
        if (raw === "[DONE]") return;
        try {
          const text = extractText(JSON.parse(raw));
          if (text) onChunk(text);
        } catch {}
      }
    }
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Stream stalled — no data received for 30s");
    throw err;
  } finally {
    clearTimeout(idleTimer);
  }
}

// === Unified chat / stream ===

async function callChat(settings, systemPrompt, userMessage, jsonMode = false) {
  const { provider, model } = parseModelId(settings.model || DEFAULT_CHAT_MODEL);
  const apiKey = getProviderKey(settings, provider);
  const baseUrl = getBaseUrl(settings, provider);

  switch (provider) {
    case "openai": return openaiChat(apiKey, baseUrl, model, systemPrompt, userMessage, jsonMode);
    case "anthropic": return anthropicChat(apiKey, model, systemPrompt, userMessage);
    case "google": return googleChat(apiKey, model, systemPrompt, userMessage, jsonMode);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

async function streamChat(settings, systemPrompt, userMessage, onChunk) {
  const { provider, model } = parseModelId(settings.model || DEFAULT_CHAT_MODEL);
  const apiKey = getProviderKey(settings, provider);
  const baseUrl = getBaseUrl(settings, provider);

  switch (provider) {
    case "openai": return openaiStream(apiKey, baseUrl, model, systemPrompt, userMessage, onChunk);
    case "anthropic": return anthropicStream(apiKey, model, systemPrompt, userMessage, onChunk);
    case "google": return googleStream(apiKey, model, systemPrompt, userMessage, onChunk);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}

// === Public API ===

const FURIGANA_CHUNK_LIMIT = 200;

// Split text into sentences at Japanese/common punctuation boundaries.
// Each sentence includes its trailing punctuation.
function splitSentences(text) {
  const parts = text.split(/(?<=[。！？\n!?])/);
  // Merge empty splits back
  return parts.filter((s) => s.length > 0);
}

// Group sentences into chunks that stay under the character limit.
function groupSentences(sentences, limit) {
  const chunks = [];
  let current = "";
  for (const s of sentences) {
    if (current.length > 0 && current.length + s.length > limit) {
      chunks.push(current);
      current = "";
    }
    current += s;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

async function getFuriganaSingle(settings, text) {
  const prompt = DEFAULT_FURIGANA_PROMPT;
  const raw = await callChat(settings, prompt, text, true);
  const parsed = parseJsonResponse(raw);

  const reconstructed = (parsed.tokens || []).map((t) => t.t).join("");
  if (reconstructed !== text) {
    console.warn("Yomeru: furigana reconstruction mismatch, retrying...");
    const raw2 = await callChat(settings, prompt, text, true);
    const parsed2 = parseJsonResponse(raw2);
    const rawTokens = parsed2.tokens || [];
    return { tokens: cleanFuriganaTokens(rawTokens), rawTokens };
  }

  const rawTokens = parsed.tokens || [];
  return { tokens: cleanFuriganaTokens(rawTokens), rawTokens };
}

const FURIGANA_CONTEXT_PROMPT = `You are a Japanese language expert. You will receive a text divided into three sections:
[BEFORE] — preceding context (may be empty)
[TARGET] — the text to annotate
[AFTER] — following context (may be empty)

Return a JSON object {"tokens": [...]} containing furigana ONLY for the [TARGET] section. Use [BEFORE] and [AFTER] only as context for accurate readings — do NOT include tokens for them. Rules:
- Segment by WORDS, not by character type. A word that contains both kanji and hiragana (e.g., 多い, 食べる, 美しい, 行きたい) must be kept as ONE token — never split kanji from its okurigana.
- Words containing kanji: {"t":"原文","r":"ひらがな reading of the whole word"}. Add furigana to ALL kanji without exception — even common ones like 日, 人, 大. Examples: {"t":"多い","r":"おおい"}, {"t":"食べる","r":"たべる"}, {"t":"美しい","r":"うつくしい"}.
- Katakana words — distinguish by origin:
  - Foreign loanwords (外来語): annotate with the original foreign word. E.g., {"t":"コンピューター","r":"computer"}, {"t":"アルバイト","r":"Arbeit"}.
  - Native Japanese words written in katakana (for emphasis, style, or convention): annotate with the standard kanji or hiragana form. E.g., {"t":"キレイ","r":"綺麗"}, {"t":"ダメ","r":"駄目"}, {"t":"ヤバい","r":"やばい"}, {"t":"ウマい","r":"旨い"}, {"t":"デキる","r":"出来る"}.
- Words with katakana substituting for kanji (交ぜ書き): keep as one token and annotate with the full standard kanji form. E.g., {"t":"皮フ科","r":"皮膚科"}, {"t":"ねつ造","r":"捏造"}, {"t":"隠ぺい","r":"隠蔽"}.
- Pure hiragana words (particles, etc.), punctuation, Arabic numerals (0-9), or non-Japanese text: {"t":"原文"} (no "r" field).
- Keep compound words together (e.g., 東京都 → {"t":"東京都","r":"とうきょうと"}).
- Concatenating all "t" fields MUST exactly reproduce the [TARGET] text.
Return ONLY JSON.`;

async function getFuriganaWithContext(settings, before, target, after) {
  const userMessage = `[BEFORE]\n${before}\n[TARGET]\n${target}\n[AFTER]\n${after}`;
  const raw = await callChat(settings, FURIGANA_CONTEXT_PROMPT, userMessage, true);
  const parsed = parseJsonResponse(raw);

  const reconstructed = (parsed.tokens || []).map((t) => t.t).join("");
  if (reconstructed !== target) {
    console.warn("Yomeru: furigana chunk mismatch, retrying...");
    const raw2 = await callChat(settings, FURIGANA_CONTEXT_PROMPT, userMessage, true);
    const parsed2 = parseJsonResponse(raw2);
    const rawTokens = parsed2.tokens || [];
    return { tokens: cleanFuriganaTokens(rawTokens), rawTokens };
  }

  const rawTokens = parsed.tokens || [];
  return { tokens: cleanFuriganaTokens(rawTokens), rawTokens };
}

export async function getFurigana(settings, text) {
  // Short text: single request
  if (text.length <= FURIGANA_CHUNK_LIMIT) {
    return getFuriganaSingle(settings, text);
  }

  // Long text: split into sentence-based chunks with context
  const sentences = splitSentences(text);
  const chunks = groupSentences(sentences, FURIGANA_CHUNK_LIMIT);

  // Single chunk after grouping: use simple path
  if (chunks.length === 1) {
    return getFuriganaSingle(settings, text);
  }

  const allTokens = [];
  const allRawTokens = [];

  for (let i = 0; i < chunks.length; i++) {
    const before = i > 0 ? chunks[i - 1] : "";
    const after = i < chunks.length - 1 ? chunks[i + 1] : "";
    const result = await getFuriganaWithContext(settings, before, chunks[i], after);
    allTokens.push(...result.tokens);
    allRawTokens.push(...result.rawTokens);
  }

  return { tokens: allTokens, rawTokens: allRawTokens };
}

export async function getTranslation(settings, text) {
  const prompt = getTranslationPrompt(settings.targetLang);
  return await callChat(settings, prompt, text, false);
}

export async function streamTranslation(settings, systemPrompt, text, onChunk) {
  return await streamChat(settings, systemPrompt, text, onChunk);
}

export async function getBulkFurigana(settings, paragraphs) {
  const prompt = DEFAULT_BULK_FURIGANA_PROMPT;
  const joined = paragraphs.join("\n===PARA===\n");
  const raw = await callChat(settings, prompt, joined, true);
  const parsed = parseJsonResponse(raw);
  return parsed.paragraphs || [];
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Convert raw PCM (s16le, 24kHz, mono) to WAV data URL
function pcmToWavDataUrl(base64Pcm) {
  const pcmBytes = Uint8Array.from(atob(base64Pcm), (c) => c.charCodeAt(0));
  const dataSize = pcmBytes.byteLength;
  const sampleRate = 24000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;

  const wav = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wav);

  // RIFF header
  const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, "WAVE");
  // fmt chunk
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  // data chunk
  writeStr(36, "data");
  view.setUint32(40, dataSize, true);
  new Uint8Array(wav, 44).set(pcmBytes);

  return "data:audio/wav;base64," + arrayBufferToBase64(wav);
}

async function openaiTTS(apiKey, baseUrl, model, voice, text) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, voice, input: text }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    if (!res.ok) { const body = await res.text(); throw new Error(`TTS API error ${res.status}: ${body}`); }

    const arrayBuffer = await res.arrayBuffer();
    return "data:audio/mp3;base64," + arrayBufferToBase64(arrayBuffer);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") throw new Error("TTS request timed out after 60s");
    throw err;
  }
}

async function googleTTS(apiKey, model, voice, text) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);

  try {
    const res = await fetch(googleUrl(model), {
      method: "POST",
      headers: googleHeaders(apiKey),
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice },
            },
          },
        },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    if (!res.ok) { const body = await res.text(); throw new Error(`TTS API error ${res.status}: ${body}`); }

    const data = await res.json();
    const base64Pcm = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Pcm) throw new Error("No audio data in Google TTS response");

    return pcmToWavDataUrl(base64Pcm);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") throw new Error("TTS request timed out after 60s");
    throw err;
  }
}

export async function fetchTTS(settings, text) {
  const { provider, model } = parseModelId(settings.ttsModel || DEFAULT_TTS_MODEL);
  const apiKey = getProviderKey(settings, provider);
  const voice = settings.ttsVoice || "alloy";

  switch (provider) {
    case "openai": return openaiTTS(apiKey, getBaseUrl(settings, "openai"), model, voice, text);
    case "google": return googleTTS(apiKey, model, voice, text);
    default: throw new Error(`TTS is not supported for provider: ${provider}`);
  }
}

export async function generateQuiz(settings, text, jlptLevel) {
  const prompt = getQuizPrompt(settings.targetLang, jlptLevel);
  // Truncate very long text to avoid exceeding context limits
  const truncated = text.length > 4000 ? text.slice(0, 4000) : text;
  const raw = await callChat(settings, prompt, truncated, true);
  return parseJsonResponse(raw);
}

export async function generateVocabEntry(settings, word, sentence) {
  const prompt = getVocabEntryPrompt(settings.targetLang);
  const userMessage = `Word: ${word}\nSentence: ${sentence}`;
  const raw = await callChat(settings, prompt, userMessage, true);
  return parseJsonResponse(raw);
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function tokensToHtml(tokens) {
  return tokens
    .map((tok) => {
      if (tok.r) {
        return `<ruby>${escapeHtml(tok.t)}<rt>${escapeHtml(tok.r)}</rt></ruby>`;
      }
      return escapeHtml(tok.t);
    })
    .join("");
}

export {
  LANGUAGE_NAMES, getTranslationPrompt, getGrammarAnalysisPrompt, getVocabEntryPrompt, getQuizPrompt,
  escapeHtml, tokensToHtml,
};
