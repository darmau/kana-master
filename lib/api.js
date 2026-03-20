const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_RETRIES = 3;
const TIMEOUT_MS = 30000;

const DEFAULT_FURIGANA_PROMPT = `You are a Japanese language expert. Given Japanese text, return a JSON object {"tokens": [...]} where each element represents a segment. Add furigana to ALL kanji without exception — even common ones like 日, 人, 大. For any token containing kanji: {"t":"原文","r":"ひらがな"}. For tokens that are purely hiragana, katakana, punctuation, or non-Japanese text: {"t":"原文"}. Concatenating all "t" fields MUST exactly reproduce the input. Keep compound words together (e.g., 東京都 → {"t":"東京都","r":"とうきょうと"}). Return ONLY JSON.`;

const DEFAULT_TRANSLATION_PROMPT = `You are a Japanese-to-Chinese translator. Translate the following Japanese text into natural Simplified Chinese. Return ONLY the translation.`;

const DEFAULT_BULK_FURIGANA_PROMPT = `You are a Japanese language expert. You will receive multiple paragraphs separated by ===PARA===. For each paragraph, produce a token array. Return a JSON object {"paragraphs": [[tokens], [tokens], ...]}. Add furigana to ALL kanji without exception — even common ones like 日, 人, 大. For any token containing kanji: {"t":"原文","r":"ひらがな"}. For tokens that are purely hiragana, katakana, punctuation, or non-Japanese text: {"t":"原文"}. Concatenating all "t" fields in each paragraph MUST exactly reproduce that paragraph's input. Keep compound words together. Return ONLY JSON.`;

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
  const baseUrl = (settings.apiBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = settings.model || DEFAULT_MODEL;
  const apiKey = settings.apiKey;

  if (!apiKey) {
    throw new Error("API key not configured. Please set it in the extension options.");
  }

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
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
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

export async function getFurigana(settings, text) {
  const prompt = settings.furiganaPrompt || DEFAULT_FURIGANA_PROMPT;
  const raw = await callOpenAI(settings, prompt, text, true);
  const parsed = parseJsonResponse(raw);

  // Validate concatenation
  const reconstructed = (parsed.tokens || []).map((t) => t.t).join("");
  if (reconstructed !== text) {
    console.warn("Kana Master: furigana reconstruction mismatch, retrying...");
    const raw2 = await callOpenAI(settings, prompt, text, true);
    const parsed2 = parseJsonResponse(raw2);
    return parsed2.tokens || [];
  }

  return parsed.tokens || [];
}

export async function getTranslation(settings, text) {
  const prompt = settings.translationPrompt || DEFAULT_TRANSLATION_PROMPT;
  return await callOpenAI(settings, prompt, text, false);
}

export async function streamTranslation(settings, text, onChunk) {
  const baseUrl = (settings.apiBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = settings.model || DEFAULT_MODEL;
  const apiKey = settings.apiKey;
  const prompt = settings.translationPrompt || DEFAULT_TRANSLATION_PROMPT;

  if (!apiKey) {
    throw new Error("API key not configured. Please set it in the extension options.");
  }

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: text },
      ],
      temperature: 0.1,
      stream: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API error ${res.status}: ${body}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
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
}

export async function getBulkFurigana(settings, paragraphs) {
  const prompt = settings.bulkFuriganaPrompt || DEFAULT_BULK_FURIGANA_PROMPT;
  const joined = paragraphs.join("\n===PARA===\n");
  const raw = await callOpenAI(settings, prompt, joined, true);
  const parsed = parseJsonResponse(raw);
  return parsed.paragraphs || [];
}

export { DEFAULT_FURIGANA_PROMPT, DEFAULT_TRANSLATION_PROMPT, DEFAULT_BULK_FURIGANA_PROMPT };
