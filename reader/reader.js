import { escapeHtml, tokensToHtml } from "../lib/api.js";
import { t, applyI18n } from "../lib/i18n.js";

applyI18n();

const JP_REGEX = /[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/;

async function showDebugTokens(el, tokens) {
  const { debugMode } = await chrome.storage.sync.get("debugMode");
  if (!debugMode) return;
  let debugDiv = el.nextElementSibling;
  if (debugDiv && debugDiv.classList.contains("kana-debug")) {
    debugDiv.remove();
  }
  const json = JSON.stringify(tokens, null, 2);
  debugDiv = document.createElement("div");
  debugDiv.className = "kana-debug";
  debugDiv.textContent = json;
  const copyBtn = document.createElement("button");
  copyBtn.className = "kana-debug-copy";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(json).then(() => {
      copyBtn.textContent = "Copied";
      setTimeout(() => (copyBtn.textContent = "Copy"), 1500);
    });
  });
  debugDiv.appendChild(copyBtn);
  el.after(debugDiv);
}

const annotateBtn = document.getElementById("annotateBtn");
const translateBtn = document.getElementById("translateBtn");
const deleteSelBtn = document.getElementById("deleteSelBtn");
const progress = document.getElementById("progress");
const hint = document.getElementById("hint");
const readerTitle = document.getElementById("reader-title");
const readerBody = document.getElementById("reader-body");
let originalUrl = "";

// --- Selection state ---
let lastClickedBlock = null;

function getAllBlocks() {
  return Array.from(readerBody.querySelectorAll(".reader-block"));
}

function clearSelection() {
  for (const b of getAllBlocks()) b.classList.remove("block-selected");
  lastClickedBlock = null;
  updateDeleteBtn();
}

function getSelectedBlocks() {
  return getAllBlocks().filter((b) => b.classList.contains("block-selected"));
}

function updateDeleteBtn() {
  const count = getSelectedBlocks().length;
  deleteSelBtn.hidden = count === 0;
  deleteSelBtn.textContent = t("deleteCount", { n: count });
}

function deleteSelected() {
  for (const b of getSelectedBlocks()) b.remove();
  lastClickedBlock = null;
  updateDeleteBtn();
}

function handleBlockClick(e) {
  const block = e.target.closest(".reader-block");
  if (!block || readerBody.classList.contains("reader-locked")) return;

  if (e.target.closest(".block-delete")) return;
  if (e.target.isContentEditable && !e.shiftKey) return;

  if (e.shiftKey && lastClickedBlock) {
    e.preventDefault();
    const blocks = getAllBlocks();
    const from = blocks.indexOf(lastClickedBlock);
    const to = blocks.indexOf(block);
    if (from === -1 || to === -1) return;
    const [start, end] = from < to ? [from, to] : [to, from];
    for (let i = start; i <= end; i++) {
      blocks[i].classList.add("block-selected");
    }
  } else {
    block.classList.toggle("block-selected");
    lastClickedBlock = block.classList.contains("block-selected") ? block : null;
  }

  updateDeleteBtn();
  if (e.shiftKey) window.getSelection()?.removeAllRanges();
}

readerBody.addEventListener("click", handleBlockClick);
deleteSelBtn.addEventListener("click", deleteSelected);

document.addEventListener("keydown", (e) => {
  if (readerBody.classList.contains("reader-locked")) return;
  if (e.target.isContentEditable) return;

  if ((e.key === "Delete" || e.key === "Backspace") && getSelectedBlocks().length > 0) {
    e.preventDefault();
    deleteSelected();
  }
  if (e.key === "Escape") {
    clearSelection();
  }
});

function createBlock(tag, text) {
  const wrapper = document.createElement("div");
  wrapper.className = "reader-block";

  const el = document.createElement(tag);
  el.textContent = text;
  el.setAttribute("contenteditable", "true");
  el.setAttribute("spellcheck", "false");

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "block-delete";
  deleteBtn.textContent = "\u00d7";
  deleteBtn.title = t("removeParagraph");
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    wrapper.remove();
    updateDeleteBtn();
  });

  wrapper.appendChild(el);
  wrapper.appendChild(deleteBtn);
  return wrapper;
}

async function loadContent() {
  const { readerData } = await chrome.storage.local.get("readerData");
  if (!readerData) {
    readerBody.innerHTML = `<p>${t("noContentDisplay")}</p>`;
    return;
  }

  document.title = `${readerData.title} - 読める`;
  readerTitle.textContent = readerData.title;
  originalUrl = readerData.url;

  for (const item of readerData.content) {
    if (item.tag === "img") continue;
    readerBody.appendChild(createBlock(item.tag, item.text));
  }

  chrome.storage.local.remove("readerData");
}

// --- Streaming annotation/translation via port ---

let annotated = false;
let translated = false;

function lockReader() {
  if (readerBody.classList.contains("reader-locked")) return;
  clearSelection();
  readerBody.classList.add("reader-locked");
  readerBody.querySelectorAll("[contenteditable]").forEach((el) => {
    el.removeAttribute("contenteditable");
  });
  if (hint) hint.remove();
  deleteSelBtn.hidden = true;
}

function processAll(mode) {
  lockReader();

  const elements = Array.from(
    readerBody.querySelectorAll("p, li, h2, h3, h4, h5, h6, blockquote, figcaption, pre")
  ).filter((el) => JP_REGEX.test(el.textContent) && el.textContent.trim().length > 0);

  if (elements.length === 0) {
    progress.textContent = t("noJapaneseText");
    return;
  }

  annotateBtn.disabled = true;
  translateBtn.disabled = true;
  const total = elements.length;
  progress.textContent = t("progressFormat", { done: 0, total });

  // Mark all as loading
  elements.forEach((el) => el.classList.add("kana-loading"));

  // Prepare translation divs only for translate mode
  let transDivs = null;
  if (mode === "translate") {
    transDivs = elements.map((el) => {
      const block = el.closest(".reader-block");
      // Don't create duplicate translation divs
      const existing = block.nextElementSibling;
      if (existing && existing.classList.contains("reader-translation")) {
        return existing;
      }
      const transDiv = document.createElement("div");
      transDiv.className = "reader-translation";
      block.after(transDiv);
      return transDiv;
    });
  }

  const texts = elements.map((el) => getTextWithoutRuby(el));

  const port = chrome.runtime.connect({ name: "kana-stream" });

  port.onMessage.addListener((msg) => {
    if (msg.type === "langInfo" && transDivs) {
      transDivs.forEach((div) => {
        div.lang = msg.targetLang;
        if (msg.targetLang === "ar") {
          div.dir = "rtl";
          div.style.textAlign = "right";
        }
      });
    }

    if (msg.type === "furiganaPartial") {
      if (msg.index < 0 || msg.index >= elements.length) return;
      const el = elements[msg.index];
      if (msg.tokens && msg.tokens.length > 0) {
        el.innerHTML = tokensToHtml(msg.tokens);
      }
    }

    if (msg.type === "furigana") {
      if (msg.index < 0 || msg.index >= elements.length) return;
      const el = elements[msg.index];
      el.classList.remove("kana-loading");
      if (msg.tokens && msg.tokens.length > 0) {
        el.innerHTML = tokensToHtml(msg.tokens);
        el.classList.add("kana-annotated");
        showDebugTokens(el, msg.rawTokens || msg.tokens);
      }
    }

    if (msg.type === "translationChunk" && transDivs) {
      if (msg.index < 0 || msg.index >= transDivs.length) return;
      transDivs[msg.index].textContent += msg.text;
    }

    if (msg.type === "translation" && transDivs) {
      if (msg.index < 0 || msg.index >= transDivs.length) return;
      transDivs[msg.index].textContent = msg.text;
    }

    if (msg.type === "progress") {
      progress.textContent = t("progressFormat", { done: msg.done, total });
    }

    if (msg.type === "error") {
      if (msg.index < 0 || msg.index >= elements.length) return;
      const el = elements[msg.index];
      el.classList.remove("kana-loading");
      if (transDivs && msg.index < transDivs.length) {
        transDivs[msg.index].textContent = `Error: ${msg.message}`;
        transDivs[msg.index].classList.add("error");
      }
    }

    if (msg.type === "allDone") {
      progress.textContent = t("doneParagraphs", { n: total });
      if (mode === "annotate") {
        annotated = true;
        annotateBtn.textContent = t("complete");
        elements.forEach((el) => el.classList.remove("kana-loading"));
      } else {
        translated = true;
        translateBtn.textContent = t("complete");
        elements.forEach((el) => el.classList.remove("kana-loading"));
      }
      // Re-enable the other button if it hasn't been used yet
      if (!annotated) annotateBtn.disabled = false;
      if (!translated) translateBtn.disabled = false;
      port.disconnect();
    }
  });

  port.postMessage({ type: "streamTranslate", paragraphs: texts, mode });
}

annotateBtn.addEventListener("click", () => processAll("annotate"));
translateBtn.addEventListener("click", () => processAll("translate"));

// --- TTS bottom playbar ---

const ttsLoadingText = document.getElementById("ttsLoadingText");
const ttsProgressTrack = document.getElementById("ttsProgressTrack");
const ttsProgressFill = document.getElementById("ttsProgressFill");
const ttsProgressThumb = document.getElementById("ttsProgressThumb");
const ttsCurrentTime = document.getElementById("ttsCurrentTime");
const ttsTotalTime = document.getElementById("ttsTotalTime");
const ttsPrevBtn = document.getElementById("ttsPrevBtn");
const ttsPlayBtn = document.getElementById("ttsPlayBtn");
const ttsNextBtn = document.getElementById("ttsNextBtn");
const ttsSpeedSelect = document.getElementById("ttsSpeedSelect");
const ttsCloseBtn = document.getElementById("ttsCloseBtn");

let ttsState = null;
let ttsDragging = false;
let ttsDragWasPlaying = false;

function ttsFormatTime(secs) {
  if (!isFinite(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function ttsDataUrlToArrayBuffer(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const buf = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return buf;
}

function ttsGetCurrentPos() {
  if (!ttsState) return 0;
  if (ttsState.playing) {
    return ttsState.playStartOffset +
      (ttsState.audioCtx.currentTime - ttsState.playStartWallTime) * ttsState.speed;
  }
  return ttsState.pausedOffset;
}

function ttsHighlightAt(pos) {
  const { segmentOffsets, segmentIndexMap, elements, currentParaIdx } = ttsState;
  if (segmentOffsets.length === 0) return;

  let newIdx = segmentIndexMap[0];
  for (let i = segmentOffsets.length - 1; i >= 0; i--) {
    if (pos >= segmentOffsets[i]) { newIdx = segmentIndexMap[i]; break; }
  }
  if (newIdx === currentParaIdx) return;

  if (currentParaIdx >= 0) {
    const oldEl = elements[currentParaIdx];
    const oldBlock = oldEl?.closest(".reader-block") || oldEl?.parentElement;
    if (oldBlock) oldBlock.classList.remove("tts-playing");
  }
  const newEl = elements[newIdx];
  const newBlock = newEl?.closest(".reader-block") || newEl?.parentElement;
  if (newBlock) newBlock.classList.add("tts-playing");
  newEl?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  ttsState.currentParaIdx = newIdx;
}

function ttsRafUpdate() {
  if (!ttsState) return;
  ttsState.rafId = requestAnimationFrame(ttsRafUpdate);

  const pos = ttsGetCurrentPos();
  const { concatBuffer } = ttsState;

  if (concatBuffer && !ttsDragging) {
    const pct = Math.min(100, (pos / concatBuffer.duration) * 100);
    ttsProgressFill.style.width = pct + "%";
    ttsProgressThumb.style.left = pct + "%";
    ttsCurrentTime.textContent = ttsFormatTime(pos);
  }

  if (concatBuffer && ttsState.segmentOffsets.length > 0) {
    ttsHighlightAt(pos);
  }
}

function ttsRebuildBuffer() {
  const { audioCtx, decodedBuffers, errors } = ttsState;
  const validIdxs = [...decodedBuffers.keys()].filter(i => !errors.has(i)).sort((a, b) => a - b);
  if (validIdxs.length === 0) return;

  const first = decodedBuffers.get(validIdxs[0]);
  const sr = first.sampleRate;
  const ch = first.numberOfChannels;

  const offsets = [];
  const indexMap = [];
  let totalSamples = 0;
  let offsetSec = 0;

  for (const idx of validIdxs) {
    offsets.push(offsetSec);
    indexMap.push(idx);
    const b = decodedBuffers.get(idx);
    offsetSec += b.duration;
    totalSamples += b.length;
  }

  const concat = audioCtx.createBuffer(ch, totalSamples, sr);
  let samplePos = 0;
  for (const idx of validIdxs) {
    const b = decodedBuffers.get(idx);
    for (let c = 0; c < ch; c++) concat.getChannelData(c).set(b.getChannelData(c), samplePos);
    samplePos += b.length;
  }

  ttsState.concatBuffer = concat;
  ttsState.segmentOffsets = offsets;
  ttsState.segmentIndexMap = indexMap;
  ttsTotalTime.textContent = ttsFormatTime(concat.duration);
}

function ttsCheckAllReceived() {
  if (!ttsState) return;
  if (ttsState.received.size + ttsState.errors.size < ttsState.totalSegments) return;
  ttsState.loadingDone = true;
  try { ttsState.port.disconnect(); } catch {}
  ttsPlayBtn.classList.remove("loading");
  ttsLoadingText.hidden = true;
  if (ttsState.concatBuffer) playTTS(0);
}

function ttsUpdateLoadingText() {
  if (!ttsState) return;
  const done = ttsState.received.size + ttsState.errors.size;
  ttsLoadingText.textContent = `${done} / ${ttsState.totalSegments}`;
}

async function handleTTSMessage(msg) {
  const state = ttsState;
  if (!state) return;

  if (msg.type === "ttsAudio") {
    let audioBuf;
    try {
      const arrayBuf = ttsDataUrlToArrayBuffer(msg.audioDataUrl);
      audioBuf = await state.audioCtx.decodeAudioData(arrayBuf);
    } catch (err) {
      console.warn("Yomeru: TTS decode error for segment", msg.index, err);
      if (ttsState !== state) return;
      state.errors.add(msg.index);
      ttsUpdateLoadingText();
      ttsCheckAllReceived();
      return;
    }
    if (ttsState !== state) return;
    state.decodedBuffers.set(msg.index, audioBuf);
    state.received.add(msg.index);
    ttsRebuildBuffer();
    ttsUpdateLoadingText();
    ttsCheckAllReceived();
  } else if (msg.type === "ttsError") {
    console.warn("Yomeru: TTS error for segment", msg.index, msg.message);
    state.errors.add(msg.index);
    ttsUpdateLoadingText();
    ttsCheckAllReceived();
  }
}

function playTTS(offsetSeconds) {
  if (!ttsState || !ttsState.concatBuffer) return;
  if (ttsState.sourceNode) {
    ttsState.sourceNode.onended = null;
    ttsState.sourceNode.stop();
    ttsState.sourceNode = null;
  }
  if (ttsState.audioCtx.state === "suspended") ttsState.audioCtx.resume();

  const offset = Math.max(0, Math.min(offsetSeconds, ttsState.concatBuffer.duration - 0.001));
  const node = ttsState.audioCtx.createBufferSource();
  node.buffer = ttsState.concatBuffer;
  node.playbackRate.value = ttsState.speed;
  node.connect(ttsState.audioCtx.destination);
  node.onended = () => { if (ttsState && ttsState.playing) onTTSEnded(); };
  node.start(0, offset);

  ttsState.sourceNode = node;
  ttsState.playStartWallTime = ttsState.audioCtx.currentTime;
  ttsState.playStartOffset = offset;
  ttsState.playing = true;
  ttsPlayBtn.textContent = "⏸";
}

function pauseTTS() {
  if (!ttsState || !ttsState.playing) return;
  ttsState.pausedOffset = ttsGetCurrentPos();
  if (ttsState.sourceNode) {
    ttsState.sourceNode.onended = null;
    ttsState.sourceNode.stop();
    ttsState.sourceNode = null;
  }
  ttsState.playing = false;
  ttsPlayBtn.textContent = "▶";
}

function seekTTS(offsetSeconds) {
  if (!ttsState || !ttsState.concatBuffer) return;
  const offset = Math.max(0, Math.min(offsetSeconds, ttsState.concatBuffer.duration));
  if (ttsState.playing) {
    playTTS(offset);
  } else {
    ttsState.pausedOffset = offset;
    const pct = (offset / ttsState.concatBuffer.duration) * 100;
    ttsProgressFill.style.width = pct + "%";
    ttsProgressThumb.style.left = pct + "%";
    ttsCurrentTime.textContent = ttsFormatTime(offset);
  }
}

function skipParagraph(dir) {
  if (!ttsState || !ttsState.concatBuffer || ttsState.segmentOffsets.length === 0) return;
  const pos = ttsGetCurrentPos();
  let curIdx = 0;
  for (let i = ttsState.segmentOffsets.length - 1; i >= 0; i--) {
    if (pos >= ttsState.segmentOffsets[i]) { curIdx = i; break; }
  }
  const target = Math.max(0, Math.min(curIdx + dir, ttsState.segmentOffsets.length - 1));
  seekTTS(ttsState.segmentOffsets[target]);
}

function setTTSSpeed(value) {
  if (!ttsState) return;
  const wasPlaying = ttsState.playing;
  const pos = ttsGetCurrentPos();
  ttsState.speed = value;
  if (ttsState.sourceNode) {
    ttsState.sourceNode.onended = null;
    ttsState.sourceNode.stop();
    ttsState.sourceNode = null;
    ttsState.playing = false;
  }
  if (wasPlaying && ttsState.concatBuffer) {
    playTTS(pos);
  } else {
    ttsState.pausedOffset = pos;
  }
}

function onTTSEnded() {
  if (!ttsState) return;
  ttsState.playing = false;
  ttsState.sourceNode = null;
  ttsState.pausedOffset = 0;
  ttsPlayBtn.textContent = "▶";
  ttsState.elements.forEach(el => {
    const block = el.closest(".reader-block") || el.parentElement;
    if (block) block.classList.remove("tts-playing");
  });
  ttsState.currentParaIdx = -1;
  ttsProgressFill.style.width = "0%";
  ttsProgressThumb.style.left = "0%";
  ttsCurrentTime.textContent = "0:00";
}

function stopTTS() {
  if (!ttsState) return;
  cancelAnimationFrame(ttsState.rafId);
  if (ttsState.sourceNode) {
    ttsState.sourceNode.onended = null;
    ttsState.sourceNode.stop();
  }
  try { ttsState.audioCtx.close(); } catch {}
  try { ttsState.port.disconnect(); } catch {}
  ttsState.elements.forEach(el => {
    const block = el.closest(".reader-block") || el.parentElement;
    if (block) block.classList.remove("tts-playing");
  });
  ttsState = null;
  ttsPlayBtn.classList.remove("loading");
  ttsPlayBtn.textContent = "▶";
  ttsLoadingText.hidden = true;
  ttsProgressFill.style.width = "0%";
  ttsProgressThumb.style.left = "0%";
  ttsCurrentTime.textContent = "0:00";
  ttsTotalTime.textContent = "--:--";
  ttsSpeedSelect.value = "1";
}

function startTTS() {
  if (ttsState) return;

  const selected = getSelectedBlocks();
  let elements;
  if (selected.length > 0) {
    elements = selected
      .map(b => b.querySelector("p, li, h2, h3, h4, h5, h6, blockquote, figcaption, pre"))
      .filter(el => el && el.textContent.trim().length > 0);
  } else {
    elements = Array.from(
      readerBody.querySelectorAll("p, li, h2, h3, h4, h5, h6, blockquote, figcaption, pre")
    ).filter(el => el.textContent.trim().length > 0);
  }

  if (elements.length === 0) return;

  const texts = elements.map(el => getTextWithoutRuby(el));
  const audioCtx = new AudioContext();
  const port = chrome.runtime.connect({ name: "kana-tts" });

  ttsState = {
    port,
    elements,
    texts,
    totalSegments: texts.length,
    audioCtx,
    decodedBuffers: new Map(),
    received: new Set(),
    errors: new Set(),
    concatBuffer: null,
    segmentOffsets: [],
    segmentIndexMap: [],
    sourceNode: null,
    playStartWallTime: 0,
    playStartOffset: 0,
    pausedOffset: 0,
    playing: false,
    speed: parseFloat(ttsSpeedSelect.value) || 1,
    loadingDone: false,
    currentParaIdx: -1,
    rafId: null,
  };

  ttsPlayBtn.classList.add("loading");
  ttsLoadingText.hidden = false;
  ttsLoadingText.textContent = `0 / ${texts.length}`;

  port.onMessage.addListener(handleTTSMessage);

  for (let i = 0; i < texts.length; i++) {
    port.postMessage({ type: "ttsRequest", index: i, text: texts[i] });
  }

  ttsRafUpdate();
}

ttsCloseBtn.addEventListener("click", stopTTS);

ttsPlayBtn.addEventListener("click", () => {
  if (ttsPlayBtn.classList.contains("loading")) return;
  if (!ttsState) {
    startTTS();
    return;
  }
  if (ttsState.playing) {
    pauseTTS();
  } else if (ttsState.concatBuffer) {
    playTTS(ttsState.pausedOffset);
  }
});

ttsPrevBtn.addEventListener("click", () => skipParagraph(-1));
ttsNextBtn.addEventListener("click", () => skipParagraph(1));
ttsSpeedSelect.addEventListener("change", () => setTTSSpeed(parseFloat(ttsSpeedSelect.value)));

ttsProgressTrack.addEventListener("mousedown", e => {
  if (!ttsState || !ttsState.concatBuffer) return;
  ttsDragging = true;
  ttsDragWasPlaying = ttsState.playing;
  ttsProgressTrack.classList.add("dragging");
  if (ttsDragWasPlaying) pauseTTS();
  ttsDragUpdatePos(e);
});

document.addEventListener("mousemove", e => {
  if (!ttsDragging) return;
  ttsDragUpdatePos(e);
});

document.addEventListener("mouseup", e => {
  if (!ttsDragging) return;
  ttsDragging = false;
  ttsProgressTrack.classList.remove("dragging");
  if (!ttsState || !ttsState.concatBuffer) return;
  const frac = ttsGetTrackFrac(e);
  const offset = frac * ttsState.concatBuffer.duration;
  if (ttsDragWasPlaying) {
    playTTS(offset);
  } else {
    seekTTS(offset);
  }
});

function ttsGetTrackFrac(e) {
  const rect = ttsProgressTrack.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
}

function ttsDragUpdatePos(e) {
  if (!ttsState || !ttsState.concatBuffer) return;
  const frac = ttsGetTrackFrac(e);
  const secs = frac * ttsState.concatBuffer.duration;
  ttsProgressFill.style.width = (frac * 100) + "%";
  ttsProgressThumb.style.left = (frac * 100) + "%";
  ttsCurrentTime.textContent = ttsFormatTime(secs);
}

// --- Vocabulary popup (select text or click ruby in annotated blocks) ---

function extractFromSelection(range) {
  const fragment = range.cloneContents();

  const wordClone = fragment.cloneNode(true);
  wordClone.querySelectorAll("rt, rp").forEach((n) => n.remove());
  const word = wordClone.textContent.trim();

  const readingClone = fragment.cloneNode(true);
  readingClone.querySelectorAll("ruby").forEach((ruby) => {
    const rt = ruby.querySelector("rt");
    if (rt) ruby.replaceWith(rt.textContent);
  });
  readingClone.querySelectorAll("rt, rp").forEach((n) => n.remove());
  const reading = readingClone.textContent.trim();

  return { word, reading };
}

function getWordFromRuby(ruby) {
  const clone = ruby.cloneNode(true);
  clone.querySelectorAll("rt, rp").forEach((n) => n.remove());
  return clone.textContent.trim();
}

function getTextWithoutRuby(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll("rt, rp").forEach((n) => n.remove());
  return clone.textContent;
}

function extractSentence(fullText, word) {
  const sentences = fullText.split(/(?<=。)/);
  const match = sentences.find((s) => s.includes(word));
  return match ? match.trim() : fullText;
}

function findReaderContext(node) {
  const el = node.nodeType === 3 ? node.parentElement : node;
  return el.closest(".kana-annotated") || el.closest(".reader-block");
}

document.addEventListener("mouseup", (e) => {
  if (e.target.closest(".reader-vocab-popup")) return;

  setTimeout(() => {
    const existingPopup = document.querySelector(".reader-vocab-popup");
    if (existingPopup) existingPopup.remove();

    const sel = window.getSelection();

    if (sel && !sel.isCollapsed && sel.toString().trim()) {
      // Text selection mode
      const range = sel.getRangeAt(0);
      const ancestor = range.commonAncestorContainer;
      const contextEl = findReaderContext(ancestor);
      if (!contextEl) return;

      const { word, reading } = extractFromSelection(range);
      if (!word) return;

      const annotatedEl = contextEl.closest(".reader-block")?.querySelector(".kana-annotated") || contextEl;
      const context = extractSentence(getTextWithoutRuby(annotatedEl), word);

      const rect = range.getBoundingClientRect();
      showReaderVocabPopupAt(word, reading, context, rect);
    } else {
      // Click on ruby
      const ruby = e.target.closest("ruby");
      if (!ruby || !ruby.closest(".kana-annotated")) return;

      const word = getWordFromRuby(ruby);
      const reading = ruby.querySelector("rt")?.textContent || "";
      const annotatedEl = ruby.closest(".kana-annotated");
      const context = extractSentence(getTextWithoutRuby(annotatedEl), word);

      const rect = ruby.getBoundingClientRect();
      showReaderVocabPopupAt(word, reading, context, rect);
    }
  }, 10);
});

document.addEventListener("mousedown", (e) => {
  if (e.target.closest(".reader-vocab-popup")) return;
  const popup = document.querySelector(".reader-vocab-popup");
  if (popup) popup.remove();
});

function showReaderVocabPopupAt(word, reading, context, rect) {
  const popup = document.createElement("div");
  popup.className = "reader-vocab-popup";

  const showReading = reading && reading !== word;
  popup.innerHTML =
    `<div class="kana-vocab-word">${escapeHtml(word)}</div>` +
    (showReading ? `<div class="kana-vocab-reading">${escapeHtml(reading)}</div>` : "") +
    `<button class="kana-vocab-save">${t("addToVocab")}</button>`;

  const saveBtn = popup.querySelector(".kana-vocab-save");
  saveBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    saveBtn.disabled = true;
    saveBtn.textContent = "...";

    try {
      const response = await chrome.runtime.sendMessage({
        type: "generateVocabEntry",
        word,
        sentence: context,
      });

      const { vocabulary = [] } = await chrome.storage.local.get("vocabulary");
      const sourceUrl = location.href;

      if (response?.error || !response?.entry) {
        const entry = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          word,
          dictionaryForm: word,
          reading: reading || "",
          partOfSpeech: "",
          definition: "",
          contexts: [{ text: context, translation: response?.sentenceTranslation || "", sourceUrl, addedAt: Date.now() }],
          createdAt: Date.now(),
        };
        vocabulary.unshift(entry);
      } else {
        const data = response.entry;
        const dictForm = data.dictionaryForm || word;

        const existing = vocabulary.find((e) => e.dictionaryForm === dictForm);
        if (existing) {
          existing.contexts = existing.contexts || [];
          existing.contexts.push({ text: context, translation: response?.sentenceTranslation || "", sourceUrl, addedAt: Date.now() });
        } else {
          const entry = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
            word: data.originalText || word,
            dictionaryForm: dictForm,
            reading: data.reading || reading || "",
            partOfSpeech: data.partOfSpeech || "",
            definition: data.definition || "",
            contexts: [{ text: context, translation: response?.sentenceTranslation || "", sourceUrl, addedAt: Date.now() }],
            createdAt: Date.now(),
          };
          if (data.verbType) entry.verbType = data.verbType;
          if (data.conjugations) entry.conjugations = data.conjugations;
          if (data.adjectiveType) entry.adjectiveType = data.adjectiveType;
          if (data.adjectiveConjugations) entry.adjectiveConjugations = data.adjectiveConjugations;
          vocabulary.unshift(entry);
        }
      }

      await chrome.storage.local.set({ vocabulary });

      saveBtn.textContent = t("added");
      saveBtn.classList.add("saved");
      setTimeout(() => popup.remove(), 800);
    } catch {
      saveBtn.textContent = t("failed");
      saveBtn.disabled = false;
    }
  });

  document.body.appendChild(popup);
  const popupLeft = Math.min(rect.left + window.scrollX, window.innerWidth - 180);
  popup.style.top = (window.scrollY + rect.bottom + 8) + "px";
  popup.style.left = Math.max(0, popupLeft) + "px";
}

// --- Quiz panel ---

const quizBtn = document.getElementById("quizBtn");
const quizPanel = document.getElementById("quiz-panel");
const quizBody = document.getElementById("quiz-body");
const quizCloseBtn = document.getElementById("quizCloseBtn");
const readerLayout = document.getElementById("readerLayout");
let quizStartTime = null;
let quizData = null;
let answeredCount = 0;
let correctCount = 0;

function getPlainText() {
  const elements = Array.from(
    readerBody.querySelectorAll("p, li, h2, h3, h4, h5, h6, blockquote, figcaption, pre")
  ).filter((el) => el.textContent.trim().length > 0);
  return elements.map((el) => getTextWithoutRuby(el)).join("\n\n");
}

async function startQuiz() {
  const text = getPlainText();
  if (!text.trim()) return;

  quizPanel.hidden = false;
  readerLayout.classList.add("quiz-open");
  quizBody.innerHTML = `<div class="quiz-loading">${t("quizGenerating")}</div>`;
  quizBtn.disabled = true;

  const { jlptLevel = "N3", targetLang = "zh-CN" } = await chrome.storage.sync.get(["jlptLevel", "targetLang"]);

  try {
    const response = await chrome.runtime.sendMessage({
      type: "generateQuiz",
      text,
      jlptLevel,
    });

    if (response?.error) throw new Error(response.error);

    quizData = response.quiz;
    answeredCount = 0;
    correctCount = 0;
    quizStartTime = Date.now();
    renderQuiz(quizData, targetLang);
  } catch (err) {
    quizBody.innerHTML = `<div class="quiz-error">${escapeHtml(err.message)}</div>`;
    quizBtn.disabled = false;
  }
}

// Shuffle array in place (Fisher-Yates) and return index mapping
function shuffleOptions(options) {
  const indices = options.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return {
    shuffled: indices.map((i) => options[i]),
    correctIndex: indices.indexOf(0), // original index 0 is always the correct answer
  };
}

// Store the correct index per question after shuffling
let quizCorrectIndices = [];

function renderQuiz(data, targetLang) {
  quizCorrectIndices = [];
  const langAttr = targetLang ? ` lang="${targetLang}"` : "";
  const dirAttr = targetLang === "ar" ? ' dir="rtl" style="text-align:right"' : "";

  let html = `<div class="quiz-difficulty">${t("quizDifficulty", { n: data.difficulty })}</div>`;

  data.questions.forEach((q, i) => {
    const { shuffled, correctIndex } = shuffleOptions(q.options);
    quizCorrectIndices.push(correctIndex);

    html += `<div class="quiz-question" data-index="${i}">`;
    html += `<div class="quiz-question-text"><span class="quiz-question-num">${t("questionNum", { n: i + 1 })}</span>${escapeHtml(q.question)}</div>`;
    html += `<div class="quiz-options">`;
    shuffled.forEach((opt, j) => {
      html += `<button class="quiz-option" data-question="${i}" data-option="${j}">${escapeHtml(opt)}</button>`;
    });
    html += `</div>`;
    html += `<div class="quiz-explanation" hidden${langAttr}${dirAttr}><span class="quiz-explanation-label">${t("quizExplanation")}:</span> ${escapeHtml(q.explanation)}</div>`;
    html += `</div>`;
  });

  quizBody.innerHTML = html;

  quizBody.querySelectorAll(".quiz-option").forEach((btn) => {
    btn.addEventListener("click", handleOptionClick);
  });
}

function handleOptionClick(e) {
  const btn = e.currentTarget;
  const qi = parseInt(btn.dataset.question);
  const oi = parseInt(btn.dataset.option);
  const questionEl = quizBody.querySelector(`.quiz-question[data-index="${qi}"]`);

  if (questionEl.classList.contains("answered")) return;
  questionEl.classList.add("answered");

  const correct = quizCorrectIndices[qi];
  const isCorrect = oi === correct;

  btn.classList.add(isCorrect ? "correct" : "incorrect");
  questionEl.querySelectorAll(".quiz-option")[correct].classList.add("correct");
  questionEl.querySelectorAll(".quiz-option").forEach((b) => b.classList.add("disabled"));

  questionEl.querySelector(".quiz-explanation").hidden = false;

  answeredCount++;
  if (isCorrect) correctCount++;

  if (answeredCount === quizData.questions.length) {
    showQuizResults();
  }
}

async function showQuizResults() {
  const timeTaken = Math.round((Date.now() - quizStartTime) / 1000);
  const total = quizData.questions.length;
  const difficulty = quizData.difficulty;
  const progressScore = Math.round((correctCount / total) * difficulty * 10);

  const resultsHtml = `<div class="quiz-results">
    <h3>${t("quizResults")}</h3>
    <div class="quiz-results-grid">
      <div class="quiz-result-item">
        <div class="quiz-result-value">${correctCount}/${total}</div>
        <div class="quiz-result-label">${t("quizScore", { correct: correctCount, total })}</div>
      </div>
      <div class="quiz-result-item">
        <div class="quiz-result-value">${timeTaken}s</div>
        <div class="quiz-result-label">${t("quizTimeTaken", { time: timeTaken })}</div>
      </div>
      <div class="quiz-result-item">
        <div class="quiz-result-value">${progressScore}</div>
        <div class="quiz-result-label">${t("progressScore")}</div>
      </div>
    </div>
    <button class="toolbar-btn primary quiz-retry">${t("quizRetry")}</button>
  </div>`;
  quizBody.insertAdjacentHTML("beforeend", resultsHtml);
  quizBody.querySelector(".quiz-retry").addEventListener("click", startQuiz);

  // Scroll results into view
  quizBody.querySelector(".quiz-results").scrollIntoView({ behavior: "smooth" });

  // Save to history
  const { quizHistory = [] } = await chrome.storage.local.get("quizHistory");
  quizHistory.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    url: originalUrl,
    title: readerTitle.textContent,
    difficulty,
    correct: correctCount,
    total,
    progressScore,
    timeTaken,
    timestamp: Date.now(),
  });
  // Cap at 200 entries
  if (quizHistory.length > 200) quizHistory.splice(0, quizHistory.length - 200);
  await chrome.storage.local.set({ quizHistory });
}

function closeQuiz() {
  quizPanel.hidden = true;
  readerLayout.classList.remove("quiz-open");
  quizBtn.disabled = false;
}

quizBtn.addEventListener("click", startQuiz);
quizCloseBtn.addEventListener("click", closeQuiz);

loadContent();
