const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_RETRIES = 3;
const TIMEOUT_MS = 30000;

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

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(settings) {
  return (settings.apiBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function getAuthHeaders(settings) {
  if (!settings.apiKey) {
    throw new Error("API key not configured. Please set it in the extension options.");
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${settings.apiKey}`,
  };
}

async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  for (let i = 0; i <= retries; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeoutId);

      if (res.status === 429 && i < retries) {
        const wait = Math.pow(2, i) * 1000;
        await sleep(wait);
        continue;
      }

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`API error ${res.status}: ${body}`);
      }

      return await res.json();
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === "AbortError") {
        throw new Error("Request timed out after 30s");
      }
      if (i === retries) throw err;
      await sleep(Math.pow(2, i) * 1000);
    }
  }
}

export async function callOpenAI(settings, systemPrompt, userMessage, jsonMode = false) {
  const baseUrl = normalizeBaseUrl(settings);
  const model = settings.model || DEFAULT_MODEL;
  const headers = getAuthHeaders(settings);

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature: 0.1,
  };

  if (jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const data = await fetchWithRetry(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  return data.choices[0].message.content.trim();
}

function parseJsonResponse(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Try extracting from markdown fences
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      return JSON.parse(match[1].trim());
    }
    throw new Error("Failed to parse JSON response");
  }
}

// Returns true if the string is only hiragana, punctuation, numbers, whitespace (no kanji, no katakana)
function isHiraganaOrPlain(str) {
  return /^[\u3040-\u309f\u0000-\u00ff\u2000-\u206f\uff00-\uffef\s\d、。！？「」『』（）・ー〜…]+$/.test(str);
}

function cleanFuriganaTokens(tokens) {
  return tokens.map((tok) => {
    // Strip spurious readings from pure hiragana/punctuation/number tokens
    // but keep readings on kanji (furigana) and katakana (original foreign word)
    if (tok.r && isHiraganaOrPlain(tok.t)) {
      return { t: tok.t };
    }
    return tok;
  });
}

export async function getFurigana(settings, text) {
  const prompt = DEFAULT_FURIGANA_PROMPT;
  const raw = await callOpenAI(settings, prompt, text, true);
  const parsed = parseJsonResponse(raw);

  // Validate concatenation
  const reconstructed = (parsed.tokens || []).map((t) => t.t).join("");
  if (reconstructed !== text) {
    console.warn("Kana Master: furigana reconstruction mismatch, retrying...");
    const raw2 = await callOpenAI(settings, prompt, text, true);
    const parsed2 = parseJsonResponse(raw2);
    return cleanFuriganaTokens(parsed2.tokens || []);
  }

  return cleanFuriganaTokens(parsed.tokens || []);
}

export async function getTranslation(settings, text) {
  const prompt = getTranslationPrompt(settings.targetLang);
  return await callOpenAI(settings, prompt, text, false);
}

export async function streamTranslation(settings, text, onChunk) {
  const baseUrl = normalizeBaseUrl(settings);
  const model = settings.model || DEFAULT_MODEL;
  const headers = getAuthHeaders(settings);
  const prompt = getTranslationPrompt(settings.targetLang);

  const controller = new AbortController();
  const initialTimeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: text },
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

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let idleTimer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Reset idle timeout on each chunk
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6);
        if (data === "[DONE]") return;
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices[0]?.delta?.content;
          if (content) onChunk(content);
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

export async function getBulkFurigana(settings, paragraphs) {
  const prompt = DEFAULT_BULK_FURIGANA_PROMPT;
  const joined = paragraphs.join("\n===PARA===\n");
  const raw = await callOpenAI(settings, prompt, joined, true);
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

const TTS_TIMEOUT_MS = 60000;

export async function fetchTTS(settings, text) {
  const baseUrl = normalizeBaseUrl(settings);
  const headers = getAuthHeaders(settings);
  const voice = settings.ttsVoice || "alloy";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TTS_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "tts-1",
        voice,
        input: text,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`TTS API error ${res.status}: ${body}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    return "data:audio/mp3;base64," + arrayBufferToBase64(arrayBuffer);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === "AbortError") {
      throw new Error("TTS request timed out after 60s");
    }
    throw err;
  }
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
