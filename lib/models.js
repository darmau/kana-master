export const PROVIDERS = {
  openai: {
    name: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    chatModels: [
      { id: "gpt-5.4", name: "GPT-5.4" },
      { id: "gpt-5.4-mini", name: "GPT-5.4 Mini" },
      { id: "gpt-5.4-nano", name: "GPT-5.4 Nano" },
      { id: "gpt-5-mini-2025-08-07", name: "GPT-5 Mini" },
      { id: "gpt-5-nano-2025-08-07", name: "GPT-5 Nano" },
    ],
    ttsModels: [
      { id: "tts-1", name: "TTS-1" },
      { id: "tts-1-hd", name: "TTS-1 HD" },
      { id: "gpt-4o-mini-tts", name: "GPT-4o Mini TTS" },
    ],
    ttsVoices: ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"],
  },
  anthropic: {
    name: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    chatModels: [
      { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    ],
    ttsModels: [],
    ttsVoices: [],
  },
  google: {
    name: "Google",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    chatModels: [
      { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro" },
      { id: "gemini-3-flash-preview", name: "Gemini 3 Flash" },
      { id: "gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash-Lite" },
    ],
    ttsModels: [
      { id: "gemini-2.5-flash-preview-tts", name: "Gemini 2.5 Flash TTS" },
      { id: "gemini-2.5-pro-preview-tts", name: "Gemini 2.5 Pro TTS" },
    ],
    ttsVoices: [
      "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
      "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
      "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
      "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
      "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
    ],
  },
};

export const DEFAULT_CHAT_MODEL = "openai/gpt-4o-mini";
export const DEFAULT_TTS_MODEL = "openai/tts-1";
