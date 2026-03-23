import { PROVIDERS, DEFAULT_CHAT_MODEL, DEFAULT_TTS_MODEL } from "./models.js";

const MAX_RETRIES = 3;
const TIMEOUT_MS = 30000;
const TTS_TIMEOUT_MS = 60000;

// === Prompts ===

const DEFAULT_FURIGANA_PROMPT = `You are a Japanese language expert. Given Japanese text, return a JSON object {"tokens": [...]} where each element represents a segment. Rules:
- Kanji tokens: {"t":"原文","r":"ひらがな"}. Add furigana to ALL kanji without exception — even common ones like 日, 人, 大.
- Katakana loanword tokens: {"t":"カタカナ","r":"original_word"}. Annotate with the original foreign word in its source language (e.g., コンピューター → {"t":"コンピューター","r":"computer"}, アルバイト → {"t":"アルバイト","r":"Arbeit"}).
- Pure hiragana, punctuation, Arabic numerals (0-9), or non-Japanese text: {"t":"原文"} (no "r" field).
- Concatenating all "t" fields MUST exactly reproduce the input.
- Keep compound words together (e.g., 東京都 → {"t":"東京都","r":"とうきょうと"}).
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
};

function getTranslationPrompt(targetLang) {
  const langName = LANGUAGE_NAMES[targetLang] || "Simplified Chinese";
  return `You are a Japanese-to-${langName} translator. Translate the following Japanese text into natural ${langName}. Return ONLY the translation.`;
}

const DEFAULT_BULK_FURIGANA_PROMPT = `You are a Japanese language expert. You will receive multiple paragraphs separated by ===PARA===. For each paragraph, produce a token array. Return a JSON object {"paragraphs": [[tokens], [tokens], ...]}. Rules:
- Kanji tokens: {"t":"原文","r":"ひらがな"}. Add furigana to ALL kanji without exception — even common ones like 日, 人, 大.
- Katakana loanword tokens: {"t":"カタカナ","r":"original_word"}. Annotate with the original foreign word in its source language (e.g., コンピューター → {"t":"コンピューター","r":"computer"}).
- Pure hiragana, punctuation, Arabic numerals (0-9), or non-Japanese text: {"t":"原文"} (no "r" field).
- Concatenating all "t" fields in each paragraph MUST exactly reproduce that paragraph's input.
- Keep compound words together.
Return ONLY JSON.`;

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

function cleanFuriganaTokens(tokens) {
  return tokens.map((tok) => {
    if (tok.r && isHiraganaOrPlain(tok.t)) return { t: tok.t };
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

function googleBody(systemPrompt, userMessage) {
  return {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userMessage }] }],
    generationConfig: { temperature: 0.1 },
  };
}

async function googleChat(apiKey, model, systemPrompt, userMessage, jsonMode) {
  const body = googleBody(systemPrompt, userMessage);
  if (jsonMode) body.generationConfig.responseMimeType = "application/json";

  const data = await fetchWithRetry(`${googleUrl(model)}&key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return data.candidates[0].content.parts[0].text.trim();
}

async function googleStream(apiKey, model, systemPrompt, userMessage, onChunk) {
  const controller = new AbortController();
  const initialTimeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${googleUrl(model, true)}&key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

export async function getFurigana(settings, text) {
  const prompt = DEFAULT_FURIGANA_PROMPT;
  const raw = await callChat(settings, prompt, text, true);
  const parsed = parseJsonResponse(raw);

  const reconstructed = (parsed.tokens || []).map((t) => t.t).join("");
  if (reconstructed !== text) {
    console.warn("Kana Master: furigana reconstruction mismatch, retrying...");
    const raw2 = await callChat(settings, prompt, text, true);
    const parsed2 = parseJsonResponse(raw2);
    return cleanFuriganaTokens(parsed2.tokens || []);
  }

  return cleanFuriganaTokens(parsed.tokens || []);
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

export async function fetchTTS(settings, text) {
  const { provider, model } = parseModelId(settings.ttsModel || DEFAULT_TTS_MODEL);
  const apiKey = getProviderKey(settings, provider);
  const baseUrl = getBaseUrl(settings, provider);
  const voice = settings.ttsVoice || "alloy";

  if (provider !== "openai") throw new Error("TTS is currently only supported with OpenAI models.");

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

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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

export {
  LANGUAGE_NAMES, getTranslationPrompt, getGrammarAnalysisPrompt,
  escapeHtml, tokensToHtml,
};
