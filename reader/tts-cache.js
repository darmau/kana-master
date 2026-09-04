// reader/tts-cache.js — LRU cache of *encoded* TTS audio, keyed by what was
// actually asked for: the text plus the voice that read it.
//
// Encoded bytes, not decoded PCM: an mp3 paragraph is a few tens of KB, while
// the same paragraph decoded at 48 kHz float is megabytes. Re-decoding from
// this cache costs tens of milliseconds, so the engine keeps only a small
// window of decoded buffers and leans on this for everything else.
//
// It lives at module scope, so closing the playbar does not throw away audio
// the user already paid for.

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export class TtsAudioCache {
  constructor({ maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.maxBytes = maxBytes;
    this.totalBytes = 0;
    this.entries = new Map(); // insertion order doubles as LRU order
  }

  static key(model, voice, text) {
    return `${model}${voice}${text}`;
  }

  has(key) {
    return this.entries.has(key);
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key); // re-insert to mark as most recently used
    this.entries.set(key, entry);
    return entry;
  }

  set(key, bytes) {
    const existing = this.entries.get(key);
    if (existing) this.totalBytes -= existing.bytes.byteLength;
    this.entries.delete(key);
    this.entries.set(key, { bytes, duration: existing?.duration ?? null });
    this.totalBytes += bytes.byteLength;
    this.evict();
  }

  // Durations are learned at decode time and kept even after the decoded buffer
  // is dropped, so the timeline stays accurate without re-decoding.
  setDuration(key, duration) {
    const entry = this.entries.get(key);
    if (entry) entry.duration = duration;
  }

  evict() {
    for (const [key, entry] of this.entries) {
      if (this.totalBytes <= this.maxBytes) break;
      this.entries.delete(key);
      this.totalBytes -= entry.bytes.byteLength;
    }
  }

  clear() {
    this.entries.clear();
    this.totalBytes = 0;
  }
}

export const ttsCache = new TtsAudioCache();
