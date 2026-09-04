// Drives TtsEngine against fake Web Audio and a fake kana-tts port, checking
// the things the old implementation got wrong: bounded concurrency, playing
// before every segment has arrived, cancelling work the listener seeked away
// from, and not restarting audio on a speed change.
import assert from "node:assert/strict";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

// --- Fake Web Audio -------------------------------------------------------

let now = 0;
const started = []; // every node that was actually started

class FakeBufferSource {
  constructor(ctx) {
    this.ctx = ctx;
    this.buffer = null;
    this.playbackRate = { value: 1 };
    this.onended = null;
    this.stopped = false;
  }
  connect() {}
  start(_when, offset = 0) {
    this.startedAt = now;
    this.offset = offset;
    started.push(this);
  }
  stop() {
    this.stopped = true;
  }
  end() {
    this.onended?.();
  }
}

class FakeAudioContext {
  constructor() {
    this.state = "running";
    this.destination = {};
  }
  get currentTime() {
    return now;
  }
  createBufferSource() {
    return new FakeBufferSource(this);
  }
  resume() {
    this.state = "running";
  }
  suspend() {
    this.state = "suspended";
  }
  // Duration is encoded in the fake bytes so tests can control the timeline.
  async decodeAudioData(bytes) {
    const seconds = new Uint8Array(bytes)[0];
    if (seconds === 0) throw new Error("corrupt audio");
    return { duration: seconds };
  }
}

// --- Fake extension messaging --------------------------------------------

const requests = []; // { reqId, text }
const cancelled = [];
let portListeners = [];
let portClosed = false;

function makePort() {
  portListeners = [];
  portClosed = false;
  return {
    postMessage(msg) {
      if (msg.type === "ttsRequest") requests.push({ reqId: msg.reqId, text: msg.text });
      if (msg.type === "ttsCancel") cancelled.push(msg.reqId);
    },
    disconnect() {
      portClosed = true;
    },
    onMessage: { addListener: (fn) => portListeners.push(fn) },
    onDisconnect: { addListener: () => {} },
  };
}

// Reply to a pending request as the service worker would.
function deliver(reqId, seconds) {
  const bytes = new Uint8Array([seconds]);
  const dataUrl = `data:audio/mp3;base64,${Buffer.from(bytes).toString("base64")}`;
  for (const fn of portListeners) fn({ type: "ttsAudio", reqId, audioDataUrl: dataUrl });
}

function deliverError(reqId, message = "boom") {
  for (const fn of portListeners) fn({ type: "ttsError", reqId, message });
}

globalThis.AudioContext = FakeAudioContext;
globalThis.CustomEvent = class extends Event {
  constructor(type, init = {}) {
    super(type, init);
    this.detail = init.detail;
  }
};
globalThis.chrome = { runtime: { connect: makePort } };
globalThis.fetch = async (dataUrl) => {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const buf = Buffer.from(b64, "base64");
  return { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
};

const { TtsEngine, splitForTts } = await import(`file://${ROOT}/reader/tts-engine.js`);
const { ttsCache } = await import(`file://${ROOT}/reader/tts-cache.js`);

const settle = () => new Promise((r) => setTimeout(r, 0));
const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await settle();
};

function makeEngine(texts) {
  const blocks = new Map(texts.map((text, i) => [`b${i}`, text]));
  const engine = new TtsEngine({
    getBlockText: (id) => blocks.get(id) ?? "",
    blockExists: (id) => blocks.has(id),
    getVoiceSettings: async () => ({ ttsModel: "openai/tts", ttsVoice: "alloy" }),
  });
  return { engine, blocks, ids: [...blocks.keys()] };
}

function reset() {
  now = 0;
  started.length = 0;
  requests.length = 0;
  cancelled.length = 0;
  ttsCache.clear();
}

// --- splitForTts ----------------------------------------------------------
{
  assert.deepEqual(splitForTts("短い文。", 100), ["短い文。"], "short text is one segment");

  const long = "あ".repeat(50) + "。" + "い".repeat(50) + "。" + "う".repeat(50) + "。";
  const chunks = splitForTts(long, 60);
  assert.ok(chunks.length >= 3, "long text is split");
  assert.ok(chunks.every((c) => c.length <= 60), "no chunk exceeds the limit");
  assert.equal(chunks.join(""), long, "splitting loses nothing");

  const runOn = "か".repeat(200); // no sentence boundary at all
  const hard = splitForTts(runOn, 60);
  assert.ok(hard.every((c) => c.length <= 60), "a sentence with no boundary is hard-cut");
  assert.equal(hard.join(""), runOn);
  console.log("✓ splitForTts: sentence-aware, lossless, respects the limit");
}

// --- Playback starts before everything is fetched -------------------------
{
  reset();
  const { engine, ids } = makeEngine(["一つ目。", "二つ目。", "三つ目。", "四つ目。", "五つ目。"]);
  await engine.load(ids);
  engine.play();
  await flush();

  assert.equal(requests.length, 2, "at most CONCURRENCY requests are in flight");
  assert.equal(engine.status, "buffering", "the play button reacts immediately");

  deliver(requests[0].reqId, 3);
  await flush();
  assert.equal(engine.status, "playing", "playback starts on the first segment, not the last");
  assert.equal(started.length, 1);
  assert.ok(requests.length > 2, "and the queue keeps fetching ahead");
  assert.ok(requests.length <= 5);
  console.log("✓ queue: bounded concurrency, plays as soon as segment 0 decodes");
}

// --- Segments chain with a gap, and the timeline firms up -----------------
{
  reset();
  const { engine, ids } = makeEngine(["一つ目。", "二つ目。"]);
  await engine.load(ids);
  engine.play();
  await flush();
  deliver(requests[0].reqId, 3);
  deliver(requests[1].reqId, 5);
  await flush();

  const timeline = engine.getTimeline();
  assert.equal(timeline.estimatedTotal, 0, "with every duration known nothing is estimated");
  assert.equal(timeline.total, 3 + 1 + 5, "total includes the inter-paragraph gap");

  const first = started[0];
  now = 3;
  first.end();
  await flush();
  assert.equal(engine.status, "gap", "a silent gap separates paragraphs");
  assert.equal(started.length, 1, "the next node has not started yet");

  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(started.length, 2, "the next paragraph starts after the gap");
  assert.equal(engine.status, "playing");
  console.log("✓ chaining: per-segment nodes with a gap, no concat buffer");
}

// --- Speed changes do not restart audio -----------------------------------
{
  reset();
  const { engine, ids } = makeEngine(["一つ目。"]);
  await engine.load(ids);
  engine.play();
  await flush();
  deliver(requests[0].reqId, 10);
  await flush();

  now = 2;
  const posBefore = engine.getPosition();
  engine.setSpeed(2);
  assert.equal(started.length, 1, "changing speed must not restart the node");
  assert.equal(started[0].playbackRate.value, 2, "the running node is re-rated in place");
  assert.equal(engine.getPosition(), posBefore, "and the position is continuous");

  now = 3; // one wall-clock second at 2x
  assert.equal(engine.getPosition(), posBefore + 2, "content time advances twice as fast");
  console.log("✓ speed: re-rates the live node, position stays continuous");
}

// --- Seeking far ahead cancels work that is no longer wanted --------------
{
  reset();
  const { engine, ids } = makeEngine(Array.from({ length: 12 }, (_, i) => `段落${i}。`));
  await engine.load(ids);
  engine.play();
  await flush();
  const early = requests.map((r) => r.reqId);

  engine.seek(engine.getTimeline().total * 0.9); // jump near the end
  await flush();
  assert.ok(
    early.some((id) => cancelled.includes(id)),
    "requests the listener seeked away from are cancelled"
  );
  assert.equal(engine.status, "buffering", "and the far segment is fetched instead");

  // Landing mid-paragraph keeps the listener's intent once the real length is known.
  const target = engine.cursor;
  engine.pendingSeekRatio = 0.5;
  const pending = requests.find((r) => r.text === engine.segments[target].text);
  deliver(pending.reqId, 8);
  await flush();
  assert.equal(started.at(-1).offset, 4, "a mid-paragraph seek resolves against the real duration");
  console.log("✓ seek: cancels stale fetches, resolves ratio against real duration");
}

// --- Cached audio replays without touching the network --------------------
{
  reset();
  const { engine, ids } = makeEngine(["一つ目。", "二つ目。"]);
  await engine.load(ids);
  engine.play();
  await flush();
  deliver(requests[0].reqId, 3);
  deliver(requests[1].reqId, 4);
  await flush();

  engine.stop();
  assert.equal(portClosed, true, "stopping closes the port");

  requests.length = 0;
  await engine.load(ids);
  engine.play();
  await flush();
  assert.equal(requests.length, 0, "a replay is free — the cache survives stop()");
  assert.equal(engine.status, "playing");
  console.log("✓ cache: replaying an article makes no new requests");
}

// --- A different voice is a different cache entry -------------------------
{
  reset();
  const blocks = new Map([["b0", "一つ目。"]]);
  let voice = "alloy";
  const engine = new TtsEngine({
    getBlockText: (id) => blocks.get(id),
    blockExists: (id) => blocks.has(id),
    getVoiceSettings: async () => ({ ttsModel: "openai/tts", ttsVoice: voice }),
  });

  await engine.load(["b0"]);
  engine.play();
  await flush();
  deliver(requests[0].reqId, 3);
  await flush();

  engine.stop();
  requests.length = 0;
  voice = "nova";
  await engine.load(["b0"]);
  engine.play();
  await flush();
  assert.equal(requests.length, 1, "switching voice re-fetches rather than replaying the old one");
  console.log("✓ cache key: voice changes invalidate");
}

// --- Repeated failures stop instead of burning through the article --------
{
  reset();
  const { engine, ids } = makeEngine(["一。", "二。", "三。", "四。", "五。"]);
  const errors = [];
  engine.addEventListener("error", (e) => errors.push(e.detail));
  await engine.load(ids);
  engine.play();
  await flush();

  for (let i = 0; i < 4 && requests.length > 0; i++) {
    const pending = requests.filter((r) => !cancelled.includes(r.reqId));
    if (pending.length === 0) break;
    deliverError(pending[0].reqId);
    requests.splice(requests.indexOf(pending[0]), 1);
    await flush();
  }

  assert.ok(errors.length >= 1, "each failure is reported");
  assert.ok(errors.some((e) => e.fatal), "a run of failures is escalated");
  assert.equal(engine.status, "paused", "playback stops rather than failing every paragraph");
  console.log("✓ errors: reported per paragraph, escalate to a pause");
}

// --- Deleted blocks are skipped mid-playlist ------------------------------
{
  reset();
  const { engine, blocks, ids } = makeEngine(["一つ目。", "二つ目。", "三つ目。"]);
  await engine.load(ids);
  engine.play();
  await flush();
  deliver(requests[0].reqId, 3);
  await flush();

  blocks.delete("b1"); // the reader deleted the next paragraph while it played
  now = 3;
  started[0].end();
  await flush();
  await new Promise((r) => setTimeout(r, 1100));
  await flush();

  const seg = engine.segments[engine.cursor];
  assert.equal(seg.blockId, "b2", "playback skips a paragraph that no longer exists");
  console.log("✓ deletion: a removed paragraph is skipped, not replayed");
}

console.log("\ntts-engine: all assertions passed");
