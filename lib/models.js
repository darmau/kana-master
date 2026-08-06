// Model catalog (checked against each vendor's docs on 2026-08-06).
//
// `reasoning: true` marks a model whose provider turns thinking on by default.
// Furigana / translation / grammar never benefit from it, so lib/api.js turns it
// off (OpenAI: reasoning_effort "none"; Anthropic: thinking "disabled"). It also
// changes which sampling params are legal — see the adapters in lib/api.js.
export const PROVIDERS = {
  openai: {
    name: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    chatModels: [
      { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", reasoning: true },
      { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", reasoning: true },
      { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", reasoning: true },
    ],
    ttsModels: [
      { id: "gpt-4o-mini-tts", name: "GPT-4o Mini TTS" },
      { id: "tts-1", name: "TTS-1" },
      { id: "tts-1-hd", name: "TTS-1 HD" },
    ],
    ttsVoices: [
      "alloy",
      "ash",
      "ballad",
      "coral",
      "echo",
      "fable",
      "nova",
      "onyx",
      "sage",
      "shimmer",
    ],
  },
  anthropic: {
    name: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    chatModels: [
      { id: "claude-opus-5", name: "Claude Opus 5", reasoning: true },
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", reasoning: true },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    ],
    ttsModels: [],
    ttsVoices: [],
  },
  google: {
    name: "Google",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    // `thinkingLevel` is sent verbatim in generationConfig. Gemini 3 models
    // always think; the lowest level each model accepts is used ("minimal" is
    // rejected by 3.1 Pro, which bottoms out at "low").
    chatModels: [
      { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro", thinkingLevel: "low" },
      { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash", thinkingLevel: "minimal" },
      { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite", thinkingLevel: "minimal" },
    ],
    ttsModels: [
      { id: "gemini-3.1-flash-tts-preview", name: "Gemini 3.1 Flash TTS" },
      { id: "gemini-2.5-flash-preview-tts", name: "Gemini 2.5 Flash TTS" },
      { id: "gemini-2.5-pro-preview-tts", name: "Gemini 2.5 Pro TTS" },
    ],
    ttsVoices: [
      "Zephyr",
      "Puck",
      "Charon",
      "Kore",
      "Fenrir",
      "Leda",
      "Orus",
      "Aoede",
      "Callirrhoe",
      "Autonoe",
      "Enceladus",
      "Iapetus",
      "Umbriel",
      "Algieba",
      "Despina",
      "Erinome",
      "Algenib",
      "Rasalgethi",
      "Laomedeia",
      "Achernar",
      "Alnilam",
      "Schedar",
      "Gacrux",
      "Pulcherrima",
      "Achird",
      "Zubenelgenubi",
      "Vindemiatrix",
      "Sadachbia",
      "Sadaltager",
      "Sulafat",
    ],
  },
  elevenlabs: {
    name: "ElevenLabs",
    defaultBaseUrl: "https://api.elevenlabs.io",
    chatModels: [],
    ttsModels: [
      { id: "eleven_v3", name: "Eleven v3" },
      { id: "eleven_flash_v2_5", name: "Flash v2.5" },
      { id: "eleven_turbo_v2_5", name: "Turbo v2.5" },
      { id: "eleven_multilingual_v2", name: "Multilingual v2" },
    ],
    ttsVoices: [
      { id: "3JDquces8E8bkmvbh6Bc", name: "Otani" },
      { id: "B8gJV1IhpuegLxdpXFOE", name: "Kuon" },
      { id: "Mv8AjrYZCBkdsmDHNwcB", name: "Ishibashi" },
      { id: "j210dv0vWm7fCknyQpbA", name: "Hinata" },
      { id: "WQz3clzUdMqvBf0jswZQ", name: "Shizuka" },
    ],
  },
};

// Look up a chat model's metadata. Returns undefined for models the user typed
// in or carried over from an older version of the catalog.
export function findChatModel(provider, modelId) {
  return PROVIDERS[provider]?.chatModels.find((m) => m.id === modelId);
}

export const DEFAULT_CHAT_MODEL = "openai/gpt-5.6-luna";
export const DEFAULT_TTS_MODEL = "openai/tts-1";
