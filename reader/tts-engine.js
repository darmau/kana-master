// reader/tts-engine.js — continuous read-aloud for the reader.
//
// The previous implementation requested every paragraph at once, waited for the
// slowest one, then concatenated all of them into a single AudioBuffer that was
// reallocated on every arrival. A 50-paragraph article meant 50 simultaneous
// API calls and hundreds of MB of PCM before a single word was spoken.
//
// This engine instead keeps a bounded fetch queue just ahead of the playhead
// and chains one AudioBufferSourceNode per segment, so playback starts as soon
// as the first segment decodes. Positions are tracked in "content seconds" —
// unscaled by playback rate — so a speed change never has to restart a node.

import { ttsCache, TtsAudioCache } from "./tts-cache.js";

const CONCURRENCY = 2; // simultaneous network requests
const LOOKAHEAD = 3; // segments fetched ahead of the playhead
const DECODE_BEHIND = 1; // decoded segments kept behind it
const MAX_TTS_CHARS = 4000; // OpenAI's input ceiling, with headroom
const GAP_SEC = 1; // silence between paragraphs
const DEFAULT_SEC_PER_CHAR = 0.2; // until real durations are known
const MAX_CONSECUTIVE_ERRORS = 3;

// Split text too long for one request, preferring sentence boundaries.
export function splitForTts(text, max = MAX_TTS_CHARS) {
  if (text.length <= max) return [text];

  const pieces = [];
  for (const sentence of text.split(/(?<=[。！？!?\n])/)) {
    if (sentence.length <= max) {
      pieces.push(sentence);
      continue;
    }
    // A single sentence over the limit: fall back to commas, then a hard cut.
    let rest = sentence;
    while (rest.length > max) {
      const clause = rest.slice(0, max);
      const cut = clause.lastIndexOf("、") + 1 || max;
      pieces.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) pieces.push(rest);
  }

  const chunks = [];
  let current = "";
  for (const piece of pieces) {
    if (current && current.length + piece.length > max) {
      chunks.push(current);
      current = "";
    }
    current += piece;
  }
  if (current) chunks.push(current);
  return chunks;
}

export class TtsEngine extends EventTarget {
  constructor({ getBlockText, blockExists, getVoiceSettings }) {
    super();
    this.getBlockText = getBlockText;
    this.blockExists = blockExists;
    this.getVoiceSettings = getVoiceSettings;

    this.ctx = null;
    this.playlist = null;
    this.status = "idle"; // idle | buffering | playing | gap | paused | ended
    this.cursor = 0;
    this.offsetInSegment = 0;
    this.speed = 1;
    this.current = null; // { node, checkpointOffset, checkpointTime }
    this.gap = null; // { timer, startTime, prevIdx, nextIdx }
    this.pendingSeekRatio = null;
    this.inFlight = new Map(); // reqId -> segment index
    this.nextReqId = 1;
    this.port = null;
    this.secPerChar = DEFAULT_SEC_PER_CHAR;
    this.consecutiveErrors = 0;
    this.starts = null; // memoised segment start times
  }

  get isActive() {
    return this.playlist !== null;
  }

  get segments() {
    return this.playlist?.segments ?? [];
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit("status", { status, speed: this.speed });
  }

  // --- Playlist ---------------------------------------------------------

  async load(blockIds, { startBlockId = null } = {}) {
    this.stopPlayback();
    const { ttsModel, ttsVoice } = await this.getVoiceSettings();

    const segments = [];
    const blockOrder = [];
    const blockFirstSeg = new Map();

    for (const blockId of blockIds) {
      const text = (this.getBlockText(blockId) || "").trim();
      if (!text) continue;
      blockOrder.push(blockId);
      blockFirstSeg.set(blockId, segments.length);

      splitForTts(text).forEach((chunk, subIndex) => {
        const key = TtsAudioCache.key(ttsModel, ttsVoice, chunk);
        segments.push({
          idx: segments.length,
          blockId,
          subIndex,
          text: chunk,
          chars: chunk.replace(/\s/g, "").length,
          key,
          status: "idle",
          buffer: null,
          // A duration already known from a previous listen keeps the timeline
          // honest before anything is re-decoded.
          duration: ttsCache.get(key)?.duration ?? null,
          error: null,
          retries: 0,
          reqId: null,
        });
      });
    }

    if (segments.length === 0) {
      this.playlist = null;
      return false;
    }

    this.playlist = { segments, blockOrder, blockFirstSeg, voiceKey: { ttsModel, ttsVoice } };
    this.cursor = startBlockId != null && blockFirstSeg.has(startBlockId)
      ? blockFirstSeg.get(startBlockId)
      : 0;
    this.offsetInSegment = 0;
    this.consecutiveErrors = 0;
    this.refreshSecPerChar();
    this.setStatus("paused");
    this.emit("timeline");
    return true;
  }

  // --- Timeline ---------------------------------------------------------

  duration(i) {
    const seg = this.segments[i];
    if (!seg) return 0;
    return seg.duration ?? seg.chars * this.secPerChar;
  }

  segStart(i) {
    if (!this.starts) {
      this.starts = [];
      let acc = 0;
      for (let j = 0; j < this.segments.length; j++) {
        this.starts.push(acc);
        acc += this.duration(j) + GAP_SEC;
      }
    }
    return this.starts[i] ?? 0;
  }

  invalidateTimeline() {
    this.starts = null;
  }

  refreshSecPerChar() {
    let seconds = 0;
    let chars = 0;
    for (const seg of this.segments) {
      if (seg.duration == null) continue;
      seconds += seg.duration;
      chars += seg.chars;
    }
    if (chars > 0) this.secPerChar = seconds / chars;
    this.invalidateTimeline();
  }

  getTimeline() {
    const n = this.segments.length;
    if (n === 0) return { total: 0, knownTotal: 0, estimatedTotal: 0, ranges: [] };

    let knownTotal = 0;
    let estimatedTotal = 0;
    const ranges = this.segments.map((seg, i) => {
      const dur = this.duration(i);
      if (seg.duration == null) estimatedTotal += dur;
      else knownTotal += dur;
      return { start: this.segStart(i), dur, ready: seg.duration != null, idx: i, blockId: seg.blockId };
    });

    return {
      total: this.segStart(n - 1) + this.duration(n - 1),
      knownTotal,
      estimatedTotal,
      ranges,
    };
  }

  positionInSegment() {
    if (this.status === "playing" && this.current) {
      const elapsed = (this.ctx.currentTime - this.current.checkpointTime) * this.speed;
      return Math.min(this.current.checkpointOffset + elapsed, this.duration(this.cursor));
    }
    return this.offsetInSegment;
  }

  getPosition() {
    if (!this.playlist) return 0;
    if (this.status === "gap" && this.gap) {
      const elapsed = (this.ctx.currentTime - this.gap.startTime) * this.speed;
      return (
        this.segStart(this.gap.prevIdx) +
        this.duration(this.gap.prevIdx) +
        Math.min(Math.max(elapsed, 0), GAP_SEC)
      );
    }
    return this.segStart(this.cursor) + this.positionInSegment();
  }

  // Map a global position back to a segment; a position inside the silent gap
  // belongs to the segment that follows it.
  locate(pos) {
    const n = this.segments.length;
    let i = 0;
    for (let j = n - 1; j >= 0; j--) {
      if (pos >= this.segStart(j)) {
        i = j;
        break;
      }
    }
    const offset = pos - this.segStart(i);
    if (offset >= this.duration(i) && i < n - 1) return { i: i + 1, offset: 0 };
    return { i, offset: Math.max(0, Math.min(offset, this.duration(i))) };
  }

  // --- Playback ---------------------------------------------------------

  // Must be reached from a user gesture the first time, or the context stays
  // suspended and nothing plays.
  ensureContext() {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") this.ctx.resume();
    return this.ctx;
  }

  play() {
    if (!this.playlist) return;
    this.ensureContext();
    if (this.status === "gap" && this.gap) {
      clearTimeout(this.gap.timer);
      this.cursor = this.gap.nextIdx;
      this.offsetInSegment = 0;
      this.gap = null;
    }
    this.playCursor();
  }

  playCursor() {
    const seg = this.segments[this.cursor];
    if (!seg) return this.finishPlaylist();

    if (!this.blockExists(seg.blockId) || (seg.status === "error" && seg.retries > 0)) {
      return this.advance();
    }
    if (seg.status === "ready" && seg.buffer) {
      return this.startSegment(this.cursor, this.offsetInSegment);
    }
    this.setStatus("buffering");
    this.pump();
  }

  startSegment(i, offset) {
    const seg = this.segments[i];
    const ctx = this.ensureContext();
    const prevBlockId = this.segments[this.cursor]?.blockId;

    const node = ctx.createBufferSource();
    node.buffer = seg.buffer;
    node.playbackRate.value = this.speed;
    node.connect(ctx.destination);
    node.onended = () => {
      if (this.current?.node === node) this.onSegmentEnded(i);
    };
    node.start(0, Math.max(0, Math.min(offset, seg.duration - 0.01)));

    this.current = { node, checkpointOffset: offset, checkpointTime: ctx.currentTime };
    this.cursor = i;
    this.offsetInSegment = 0;
    this.consecutiveErrors = 0;
    this.setStatus("playing");
    this.emit("segment", { blockId: seg.blockId, prevBlockId });
    this.evictDecodedOutsideWindow(i);
    this.pump();
  }

  stopCurrentNode() {
    if (!this.current) return;
    const { node } = this.current;
    this.current = null;
    node.onended = null;
    try {
      node.stop();
    } catch {
      /* already stopped */
    }
  }

  nextPlayableIdx(from) {
    for (let i = from; i < this.segments.length; i++) {
      const seg = this.segments[i];
      if (!this.blockExists(seg.blockId)) continue;
      if (seg.status === "error" && seg.retries > 0) continue;
      return i;
    }
    return null;
  }

  onSegmentEnded(i) {
    this.current = null;
    const next = this.nextPlayableIdx(i + 1);
    if (next === null) return this.finishPlaylist();

    // Wall-clock gap shrinks with speed, so 2× really is twice as fast.
    this.gap = {
      prevIdx: i,
      nextIdx: next,
      startTime: this.ctx.currentTime,
      timer: setTimeout(() => {
        this.gap = null;
        this.cursor = next;
        this.offsetInSegment = 0;
        this.playCursor();
      }, (GAP_SEC / this.speed) * 1000),
    };
    this.setStatus("gap");
  }

  pause() {
    if (this.status === "playing") {
      this.offsetInSegment = this.positionInSegment();
      this.stopCurrentNode();
    } else if (this.status === "gap" && this.gap) {
      clearTimeout(this.gap.timer);
      this.cursor = this.gap.nextIdx;
      this.offsetInSegment = 0;
      this.gap = null;
    } else if (this.status !== "buffering") {
      return;
    }
    this.setStatus("paused");
  }

  toggle() {
    if (this.status === "playing" || this.status === "gap" || this.status === "buffering") {
      this.pause();
    } else {
      this.play();
    }
  }

  advance() {
    const next = this.nextPlayableIdx(this.cursor + 1);
    if (next === null) return this.finishPlaylist();
    this.cursor = next;
    this.offsetInSegment = 0;
    this.playCursor();
  }

  finishPlaylist() {
    this.stopCurrentNode();
    this.cursor = 0;
    this.offsetInSegment = 0;
    this.setStatus("ended");
    this.emit("segment", { blockId: null, prevBlockId: null });
  }

  seekToSegment(i, offset, resume) {
    if (this.gap) {
      clearTimeout(this.gap.timer);
      this.gap = null;
    }
    this.stopCurrentNode();
    this.cursor = i;
    this.offsetInSegment = offset;
    if (resume) {
      this.playCursor();
    } else {
      this.setStatus("paused");
      this.emit("segment", { blockId: this.segments[i]?.blockId ?? null });
      this.pump();
    }
  }

  seek(seconds) {
    if (!this.playlist) return;
    const wasRunning = ["playing", "gap", "buffering"].includes(this.status);
    const { i, offset } = this.locate(Math.max(0, seconds));
    this.pendingSeekRatio = null;

    if (this.segments[i].status === "ready") {
      this.seekToSegment(i, offset, wasRunning);
      return;
    }
    // Landing in a segment whose real length is still a guess: remember how far
    // in the listener aimed, and convert once the audio arrives.
    const est = this.duration(i);
    this.pendingSeekRatio = est > 0 ? offset / est : 0;
    this.seekToSegment(i, 0, wasRunning);
  }

  seekRatio(ratio) {
    this.seek(ratio * this.getTimeline().total);
  }

  skip(dir) {
    if (!this.playlist) return;
    const { blockOrder, blockFirstSeg } = this.playlist;
    const currentBlock = this.segments[this.cursor]?.blockId;
    const at = blockOrder.indexOf(currentBlock);
    const target = Math.max(0, Math.min(at + dir, blockOrder.length - 1));
    const wasRunning = ["playing", "gap", "buffering"].includes(this.status);
    this.pendingSeekRatio = null;
    this.seekToSegment(blockFirstSeg.get(blockOrder[target]), 0, wasRunning);
  }

  // Re-checkpoint rather than restart, so changing speed mid-sentence is seamless.
  setSpeed(value) {
    const offset = this.positionInSegment();
    if (this.status === "gap" && this.gap) {
      const elapsed = (this.ctx.currentTime - this.gap.startTime) * this.speed;
      const remaining = Math.max(0, GAP_SEC - elapsed);
      clearTimeout(this.gap.timer);
      this.speed = value;
      const { nextIdx } = this.gap;
      this.gap.startTime = this.ctx.currentTime - elapsed / value;
      this.gap.timer = setTimeout(() => {
        this.gap = null;
        this.cursor = nextIdx;
        this.offsetInSegment = 0;
        this.playCursor();
      }, (remaining / value) * 1000);
      this.emit("status", { status: this.status, speed: this.speed });
      return;
    }

    this.speed = value;
    if (this.current) {
      this.current.checkpointOffset = offset;
      this.current.checkpointTime = this.ctx.currentTime;
      this.current.node.playbackRate.value = value;
    } else {
      this.offsetInSegment = offset;
    }
    this.emit("status", { status: this.status, speed: this.speed });
  }

  stopPlayback() {
    if (this.gap) {
      clearTimeout(this.gap.timer);
      this.gap = null;
    }
    this.stopCurrentNode();
    for (const reqId of [...this.inFlight.keys()]) this.cancelRequest(reqId);
  }

  stop() {
    this.stopPlayback();
    try {
      this.port?.disconnect();
    } catch {
      /* already gone */
    }
    this.port = null;
    this.playlist = null;
    this.pendingSeekRatio = null;
    this.invalidateTimeline();
    this.setStatus("idle");
    this.ctx?.suspend();
  }

  // --- Fetching ---------------------------------------------------------

  // The service worker is stateless per message, and only this side knows where
  // the playhead is, so all queueing and cancellation happens here.
  pump() {
    if (!this.playlist || this.status === "idle" || this.status === "ended") return;
    const last = this.segments.length - 1;
    const hi = Math.min(this.cursor + LOOKAHEAD, last);

    // Release slots held by work the playhead has moved away from *before*
    // filling them (±1 segment of slack). Doing this afterwards would let a
    // seek cancel its way to an empty queue and then never refill it.
    for (const [reqId, idx] of [...this.inFlight]) {
      if (idx < this.cursor - 1 || idx > hi + 1) this.cancelRequest(reqId);
    }

    for (let i = this.cursor; i <= hi; i++) {
      const seg = this.segments[i];
      const retryable = seg.status === "error" && seg.retries < 1 && i === this.cursor;
      if (seg.status !== "idle" && !retryable) continue;
      if (!this.blockExists(seg.blockId)) continue;

      if (ttsCache.has(seg.key)) {
        this.decodeFromCache(i); // decoding costs no network slot
        continue;
      }
      if (this.inFlight.size >= CONCURRENCY) break;
      this.requestSegment(i);
    }
  }

  ensurePort() {
    if (this.port) return this.port;
    // Chrome may recycle the worker during a long pause, so connect lazily and
    // reconnect rather than holding one port for the session.
    const port = chrome.runtime.connect({ name: "kana-tts" });
    port.onMessage.addListener((msg) => this.onPortMessage(msg));
    port.onDisconnect.addListener(() => {
      this.port = null;
      for (const idx of this.inFlight.values()) {
        const seg = this.segments[idx];
        if (seg) {
          seg.status = "idle";
          seg.reqId = null;
        }
      }
      this.inFlight.clear();
      if (this.playlist) this.pump();
    });
    this.port = port;
    return port;
  }

  requestSegment(i) {
    const seg = this.segments[i];
    seg.status = "loading";
    seg.reqId = this.nextReqId++;
    this.inFlight.set(seg.reqId, i);
    this.ensurePort().postMessage({ type: "ttsRequest", reqId: seg.reqId, text: seg.text });
  }

  cancelRequest(reqId) {
    const idx = this.inFlight.get(reqId);
    this.inFlight.delete(reqId);
    const seg = this.segments[idx];
    if (seg) {
      seg.status = "idle";
      seg.reqId = null;
    }
    try {
      this.port?.postMessage({ type: "ttsCancel", reqId });
    } catch {
      /* the port is already gone */
    }
  }

  async onPortMessage(msg) {
    const idx = this.inFlight.get(msg.reqId);
    this.inFlight.delete(msg.reqId);
    if (idx === undefined) return; // cancelled before it landed

    if (msg.type === "ttsAudio") {
      const seg = this.segments[idx];
      if (!seg) return;
      const bytes = await (await fetch(msg.audioDataUrl)).arrayBuffer();
      ttsCache.set(seg.key, bytes);
      // The same text may appear more than once in an article; every waiting
      // segment with this key can now decode.
      for (const other of this.segments) {
        if (other.key === seg.key && (other.status === "loading" || other.status === "idle")) {
          this.decodeFromCache(other.idx);
        }
      }
      this.pump();
      return;
    }

    if (msg.type === "ttsError") {
      const seg = this.segments[idx];
      if (!seg) return;
      seg.status = "error";
      seg.error = msg.message;
      seg.retries++;
      this.consecutiveErrors++;
      const fatal = this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS;
      this.emit("error", { idx, blockId: seg.blockId, message: msg.message, fatal });
      // Stop chewing through the whole article on a bad key or a dead network.
      if (fatal) this.pause();
      else if (idx === this.cursor && this.status === "buffering") this.advance();
      this.pump();
    }
  }

  async decodeFromCache(i) {
    const seg = this.segments[i];
    const entry = ttsCache.get(seg.key);
    if (!entry) return;
    seg.status = "loading";

    let buffer;
    try {
      // decodeAudioData detaches its input, so hand it a copy and keep ours.
      buffer = await this.ensureContext().decodeAudioData(entry.bytes.slice(0));
    } catch (err) {
      seg.status = "error";
      seg.error = err.message;
      seg.retries++;
      this.emit("error", { idx: i, blockId: seg.blockId, message: err.message, fatal: false });
      return;
    }

    if (this.segments[i] !== seg || seg.status !== "loading") return; // playlist moved on
    seg.buffer = buffer;
    seg.duration = buffer.duration;
    seg.status = "ready";
    ttsCache.setDuration(seg.key, buffer.duration);
    this.refreshSecPerChar();
    this.emit("timeline");

    if (i === this.cursor && this.status === "buffering") {
      if (this.pendingSeekRatio !== null) {
        this.offsetInSegment = this.pendingSeekRatio * buffer.duration;
        this.pendingSeekRatio = null;
      }
      this.startSegment(i, this.offsetInSegment);
    }
  }

  // Decoded PCM is the expensive part, so keep only a window of it around the
  // playhead; the bytes stay cached and re-decode in tens of milliseconds.
  evictDecodedOutsideWindow(center) {
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      if (!seg.buffer) continue;
      if (i < center - DECODE_BEHIND || i > center + LOOKAHEAD + 1) {
        seg.buffer = null;
        seg.status = "idle";
      }
    }
  }
}
