import { escapeHtml, tokensToHtml } from "../lib/api.js";
import { t, applyI18n } from "../lib/i18n.js";
import { DEFAULTS, getSync, setSync } from "../lib/storage.js";
import { TtsEngine } from "./tts-engine.js";
import {
  makeBlock,
  makeSession,
  createSession,
  getSession,
  saveSession,
  listSessions,
  deleteSession,
  touchSession,
} from "../lib/reader-store.js";

// Shared DOM selection helpers (loaded via lib/shared.js before this module — see reader.html).
// getTextWithoutRuby stays local (reader keeps <code>, unlike the content script).
const {
  formatDate,
  hasKana,
  makeJapaneseDetector,
  applyLangDir,
  renderMarkdown,
  ICONS,
  makeActionButton,
  showVocabPopup,
  extractFromSelection,
  getWordFromRuby,
  extractSentence,
} = globalThis.KanaShared;

applyI18n();

// Read once and kept live, so rendering a restored session does not cost one
// storage round-trip per block.
let debugMode = false;

function showDebugTokens(view) {
  view.wrapper.querySelector(".kana-debug")?.remove();
  const tokens = view.record.rawTokens || view.record.tokens;
  if (!debugMode || !tokens) return;

  const json = JSON.stringify(tokens, null, 2);
  const debugDiv = document.createElement("div");
  debugDiv.className = "kana-debug";
  debugDiv.textContent = json;
  const copyBtn = document.createElement("button");
  copyBtn.className = "kana-debug-copy";
  copyBtn.textContent = t("copy");
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(json).then(() => {
      copyBtn.textContent = t("copied");
      setTimeout(() => (copyBtn.textContent = t("copy")), 1500);
    });
  });
  debugDiv.appendChild(copyBtn);
  view.el.after(debugDiv);
}

function refreshDebug() {
  for (const view of views.values()) showDebugTokens(view);
}

const annotateBtn = document.getElementById("annotateBtn");
const translateBtn = document.getElementById("translateBtn");
const cancelBtn = document.getElementById("cancelBtn");
const quizBtn = document.getElementById("quizBtn");
const deleteSelBtn = document.getElementById("deleteSelBtn");
const progress = document.getElementById("progress");
const toolbarProgress = document.getElementById("toolbarProgress");
const toolbarProgressFill = document.getElementById("toolbarProgressFill");
const readerTitle = document.getElementById("reader-title");
const readerBody = document.getElementById("reader-body");
const originalLink = document.getElementById("originalLink");
const sessionHome = document.getElementById("sessionHome");
const sessionList = document.getElementById("sessionList");
const sessionEmpty = document.getElementById("sessionEmpty");
const addBlockBtn = document.getElementById("addBlockBtn");
const hideFuriganaToggle = document.getElementById("hideFuriganaToggle");
const hideTranslationToggle = document.getElementById("hideTranslationToggle");
let originalUrl = "";

// --- Session state ---
// `session` is the persisted document; `views` holds the transient half of each
// block (DOM nodes, in-flight run, error) keyed by block id. A view's `record`
// is the very object that gets written back to storage.
let session = null;
let isDraft = false;
const views = new Map();
let activeBatch = null;

// --- Selection state ---
let lastClickedBlock = null;

function getAllBlocks() {
  return Array.from(readerBody.querySelectorAll(".reader-block"));
}

function viewOf(block) {
  return block ? views.get(block.dataset.blockId) : undefined;
}

function getAllViews() {
  return getAllBlocks().map(viewOf).filter(Boolean);
}

// --- Selection ---
// The checkbox in the gutter is the only way to select a block, so clicking the
// text does nothing but place a caret. `.block-selected` stays the source of
// truth; the checkbox mirrors it.

function setBlockSelected(block, on) {
  block.classList.toggle("block-selected", on);
  const box = block.querySelector(".block-select-input");
  if (box) box.checked = on;
}

function clearSelection() {
  for (const b of getAllBlocks()) setBlockSelected(b, false);
  lastClickedBlock = null;
  updateSelectionUi();
}

function getSelectedBlocks() {
  return getAllBlocks().filter((b) => b.classList.contains("block-selected"));
}

// Selection now scopes annotate/translate/quiz/read-aloud, not just delete, so
// the batch buttons say how many blocks they are about to act on.
function updateSelectionUi() {
  const count = getSelectedBlocks().length;
  deleteSelBtn.hidden = count === 0;
  deleteSelBtn.textContent = t("deleteCount", { n: count });
  readerBody.classList.toggle("has-selection", count > 0);

  const suffix = count > 0 ? ` (${count})` : "";
  annotateBtn.querySelector("span").textContent = t("annotate") + suffix;
  translateBtn.querySelector("span").textContent = t("translate") + suffix;
  quizBtn.textContent = t("quiz") + suffix;
}

function deleteSelected() {
  for (const b of getSelectedBlocks()) removeBlockView(viewOf(b));
  lastClickedBlock = null;
  updateSelectionUi();
}

readerBody.addEventListener("click", (e) => {
  const box = e.target.closest(".block-select-input");
  if (!box) return;
  const block = box.closest(".reader-block");

  if (e.shiftKey && lastClickedBlock?.isConnected && lastClickedBlock !== block) {
    const all = getAllBlocks();
    const [from, to] = [all.indexOf(lastClickedBlock), all.indexOf(block)].sort((a, b) => a - b);
    for (let i = from; i <= to; i++) setBlockSelected(all[i], true);
  } else {
    setBlockSelected(block, box.checked); // the native toggle already happened
    lastClickedBlock = box.checked ? block : null;
  }
  updateSelectionUi();
});

deleteSelBtn.addEventListener("click", deleteSelected);

// Escape unwinds one layer at a time: menu, then popup, then the editor, then
// the block selection.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (openMenu) return closeBlockMenu({ refocus: true });
    const popup = document.querySelector(".reader-vocab-popup");
    if (popup) return popup.remove();
    if (e.target.isContentEditable) return e.target.blur();
    return clearSelection();
  }

  if (e.target.isContentEditable) return;
  if ((e.key === "Delete" || e.key === "Backspace") && getSelectedBlocks().length > 0) {
    e.preventDefault();
    deleteSelected();
  }
});

// A click anywhere else closes the block menu.
document.addEventListener("mousedown", (e) => {
  if (openMenu && !e.target.closest(".block-menu, .block-handle-btn")) closeBlockMenu();
});
window.addEventListener("blur", () => closeBlockMenu());

// Blocks a batch action applies to: the selection if there is one, else everything.
function getActionTargets() {
  const selected = getSelectedBlocks();
  return (selected.length ? selected : getAllBlocks()).map(viewOf).filter(Boolean);
}

// --- Block views ---
// A view owns one paragraph: its DOM, its persisted record, and its state.
// `data-state` on the wrapper is the single hook every CSS rule keys off.

function deriveStatus(view) {
  if (view.run) return "loading";
  if (view.error) return "error";
  if (view.record.stale) return "stale";
  if (view.record.tokens || view.record.translation || view.record.grammar) return "done";
  return "idle";
}

function getContentEl(block) {
  return block.querySelector(":scope > .block-main > .block-content");
}

// Results keep a fixed order inside .block-main: text, translation, grammar,
// status. Deleting a block therefore takes its results with it.
function ensureResultDiv(view, kind) {
  const prop = kind === "grammar" ? "grammarDiv" : "transDiv";
  if (view[prop]) return view[prop];
  const div = document.createElement("div");
  div.className = kind === "grammar" ? "reader-grammar" : "reader-translation";
  const before = kind === "grammar" ? view.statusRow : view.grammarDiv || view.statusRow;
  view.main.insertBefore(div, before || null);
  view[prop] = div;
  return div;
}

function dropResultDiv(view, kind) {
  const prop = kind === "grammar" ? "grammarDiv" : "transDiv";
  view[prop]?.remove();
  view[prop] = null;
}

function ensureStatusRow(view) {
  if (view.statusRow) return view.statusRow;
  const row = document.createElement("div");
  row.className = "block-status";

  const msg = document.createElement("span");
  msg.className = "block-status-msg";

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "block-status-retry";
  retry.textContent = t("retry");
  retry.addEventListener("click", (e) => {
    e.stopPropagation();
    retryBlock(view);
  });

  row.append(msg, retry);
  view.main.appendChild(row);
  view.statusRow = row;
  return row;
}

// `content: false` leaves the text element untouched — used while the caret is in it.
function renderBlock(view, { content = true } = {}) {
  const r = view.record;
  view.status = deriveStatus(view);
  view.wrapper.dataset.state = view.status;
  view.wrapper.dataset.hasFurigana = String(!!(r.tokens && r.tokens.length));
  view.wrapper.dataset.hasTranslation = String(!!r.translation);
  // The only thing keeping a streamed innerHTML rewrite from clobbering typing.
  view.el.contentEditable = view.status === "loading" ? "false" : "plaintext-only";

  if (content && view.status !== "loading") {
    if (r.tokens && r.tokens.length && !r.stale) {
      view.el.innerHTML = tokensToHtml(r.tokens);
      view.el.classList.add("kana-annotated");
    } else {
      view.el.textContent = r.text;
      view.el.classList.remove("kana-annotated");
    }
  }

  if (r.translation || view.pendingTranslation !== null) {
    const div = ensureResultDiv(view, "translation");
    if (view.status !== "loading") div.textContent = r.translation || "";
    applyLangDir(div, r.translationLang);
  } else {
    dropResultDiv(view, "translation");
  }

  if (r.grammar || view.pendingGrammar !== null) {
    const div = ensureResultDiv(view, "grammar");
    if (view.status !== "loading") div.innerHTML = renderMarkdown(r.grammar || "");
    applyLangDir(div, r.translationLang);
  } else {
    dropResultDiv(view, "grammar");
  }

  if (view.status === "error") {
    ensureStatusRow(view).querySelector(".block-status-msg").textContent = t("blockError", {
      message: view.error,
    });
  } else if (view.statusRow) {
    view.statusRow.remove();
    view.statusRow = null;
  }
}

function createBlockView(record) {
  const wrapper = document.createElement("div");
  wrapper.className = "reader-block";
  wrapper.dataset.blockId = record.id;
  wrapper.dataset.tag = record.tag;

  // Gutter: selection checkbox and the 読 menu button, two independent controls
  // that only share a fade-in.
  const gutter = document.createElement("div");
  gutter.className = "block-gutter";

  const selectLabel = document.createElement("label");
  selectLabel.className = "block-select";
  selectLabel.title = t("selectParagraph");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "block-select-input";
  checkbox.setAttribute("aria-label", t("selectParagraph"));
  selectLabel.appendChild(checkbox);

  const handle = document.createElement("div");
  handle.className = "block-handle";
  const handleBtn = document.createElement("button");
  handleBtn.type = "button";
  handleBtn.className = "block-handle-btn";
  handleBtn.textContent = "読";
  handleBtn.title = t("paragraphActions");
  handleBtn.setAttribute("aria-haspopup", "menu");
  handleBtn.setAttribute("aria-expanded", "false");
  handle.appendChild(handleBtn);

  gutter.append(selectLabel, handle);

  const main = document.createElement("div");
  main.className = "block-main";
  const el = document.createElement(record.tag);
  el.className = "block-content";
  el.setAttribute("contenteditable", "plaintext-only");
  el.setAttribute("spellcheck", "false");
  main.appendChild(el);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "block-delete";
  deleteBtn.textContent = "×";
  deleteBtn.title = t("removeParagraph");

  wrapper.append(gutter, main, deleteBtn);

  const view = {
    record,
    wrapper,
    main,
    el,
    handle,
    handleBtn,
    transDiv: null,
    grammarDiv: null,
    statusRow: null,
    status: "idle",
    error: null,
    run: null,
    pendingTranslation: null,
    pendingGrammar: null,
    lastRun: null,
    got: null,
  };
  views.set(record.id, view);

  // Editing invalidates results, so catch the intent before the text changes:
  // beforeinput fires ahead of the mutation, compositionstart ahead of any IME
  // composition (which must never begin inside a <ruby>).
  el.addEventListener("beforeinput", () => invalidateBlock(view));
  el.addEventListener("compositionstart", () => invalidateBlock(view));
  el.addEventListener("input", () => {
    record.text = getTextWithoutRuby(el);
    scheduleSave();
  });

  handleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (openMenu?.view === view) closeBlockMenu();
    else openBlockMenu(view);
  });
  handleBtn.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown") return;
    e.preventDefault();
    openBlockMenu(view);
  });
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    removeBlockView(view);
  });

  renderBlock(view);
  if (record.grammar) ensureResultDiv(view, "grammar").innerHTML = renderMarkdown(record.grammar);
  return view;
}

function addBlockView(record, beforeWrapper = null) {
  const view = createBlockView(record);
  if (beforeWrapper) readerBody.insertBefore(view.wrapper, beforeWrapper);
  else readerBody.appendChild(view.wrapper);
  return view;
}

function removeBlockView(view) {
  if (!view) return;
  if (openMenu?.view === view) closeBlockMenu();
  views.delete(view.record.id);
  view.wrapper.remove();
  if (lastClickedBlock === view.wrapper) lastClickedBlock = null;
  updateSelectionUi();
  scheduleSave();
}

// --- Paragraph handle ---

const HANDLE_HIDE_DELAY = 300;
let hoverBlock = null;
let hoverTimer = null;
let openMenu = null;

function setHoverBlock(block) {
  cancelHoverClear();
  if (block === hoverBlock) return;
  hoverBlock?.classList.remove("block-hover");
  hoverBlock = block;
  block.classList.add("block-hover");
}

function cancelHoverClear() {
  if (!hoverTimer) return;
  clearTimeout(hoverTimer);
  hoverTimer = null;
}

// Grace delay so crossing the gap between two blocks does not flicker the gutter.
function scheduleHoverClear() {
  cancelHoverClear();
  hoverTimer = setTimeout(() => {
    hoverBlock?.classList.remove("block-hover");
    hoverBlock = null;
    hoverTimer = null;
  }, HANDLE_HIDE_DELAY);
}

readerBody.addEventListener("mouseover", (e) => {
  if (openMenu) return; // an open menu owns the gutter until it closes
  const block = e.target.closest(".reader-block");
  if (block) setHoverBlock(block);
  else scheduleHoverClear();
});
readerBody.addEventListener("mouseleave", scheduleHoverClear);

function buildBlockMenu(view) {
  refreshJapaneseDetector();
  let menu = view.handle.querySelector(".block-menu");
  if (!menu) {
    menu = document.createElement("div");
    menu.className = "block-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", t("paragraphActions"));
    menu.addEventListener("keydown", onMenuKeydown);
    view.handle.appendChild(menu);
  }
  menu.replaceChildren(); // labels depend on the block's current state

  const text = view.record.text.trim();
  const japanese = hasJapanese(text);
  const loading = view.status === "loading";
  const annotated = !!(view.record.tokens && view.record.tokens.length);

  const item = (icon, label, extraClass, action, opts) => {
    const btn = makeActionButton(
      icon,
      label,
      `block-menu-item${extraClass ? ` ${extraClass}` : ""}`,
      () => runBlockAction(view, action, opts),
      label
    );
    btn.setAttribute("role", "menuitem");
    btn.dataset.action = action;
    btn.disabled = loading;
    menu.appendChild(btn);
  };

  if (japanese) {
    item(
      ICONS.annotate,
      annotated ? t("reAnnotateTooltip") : t("annotateTooltip"),
      "",
      "annotate",
      annotated ? { upgrade: true } : {}
    );
  }
  item(ICONS.translate, t("translateTooltip"), "", "translate");
  if (japanese) item(ICONS.grammar, t("grammarTooltip"), "grammar", "grammar");
  item(ICONS.tts, t("readFromHere"), "tts", "tts");

  return menu;
}

function openBlockMenu(view) {
  if (openMenu) closeBlockMenu();
  if (!view.record.text.trim()) return; // nothing to act on

  const menu = buildBlockMenu(view);
  menu.classList.remove("block-menu-up");
  view.wrapper.classList.add("menu-open");
  view.handleBtn.setAttribute("aria-expanded", "true");
  setHoverBlock(view.wrapper);
  openMenu = { view, menu };

  // Flip above the button when there is no room below.
  if (menu.getBoundingClientRect().bottom > window.innerHeight - 8) {
    menu.classList.add("block-menu-up");
  }
  menu.querySelector(".block-menu-item:not([disabled])")?.focus();
}

function closeBlockMenu({ refocus = false } = {}) {
  if (!openMenu) return;
  const { view, menu } = openMenu;
  menu.remove();
  view.wrapper.classList.remove("menu-open");
  view.handleBtn.setAttribute("aria-expanded", "false");
  openMenu = null;
  if (refocus) view.handleBtn.focus();
  else scheduleHoverClear();
}

function onMenuKeydown(e) {
  if (!openMenu) return;
  const items = [...openMenu.menu.querySelectorAll(".block-menu-item:not([disabled])")];
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement);

  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const step = e.key === "ArrowDown" ? 1 : -1;
    items[(current + step + items.length) % items.length].focus();
  } else if (e.key === "Home") {
    e.preventDefault();
    items[0].focus();
  } else if (e.key === "End") {
    e.preventDefault();
    items[items.length - 1].focus();
  } else if (e.key === "Tab") {
    closeBlockMenu();
  }
}

// --- Single-block actions ---

// Phase 3 replaces the `tts` entry with the playbar queue; everything else runs
// through the same streaming controller the toolbar uses.
const BLOCK_ACTIONS = {
  annotate: (view, opts) => runStream([view], "annotate", opts),
  translate: (view) => runStream([view], "translate"),
  grammar: (view) => runStream([view], "grammar"),
  // Handed to the playbar via the DOM so the menu needs no engine reference.
  tts: (view) =>
    readerBody.dispatchEvent(
      new CustomEvent("reader:tts", {
        bubbles: true,
        detail: { mode: "from", blockId: view.record.id },
      })
    ),
};

function runBlockAction(view, action, opts = {}) {
  closeBlockMenu();
  if (!view.record.text.trim()) return;
  BLOCK_ACTIONS[action]?.(view, opts);
}

function stripRuby(el) {
  el.querySelectorAll("ruby").forEach((ruby) => {
    const clone = ruby.cloneNode(true);
    clone.querySelectorAll("rt, rp").forEach((n) => n.remove());
    ruby.replaceWith(...clone.childNodes);
  });
  el.classList.remove("kana-annotated");
}

// Caret offsets are measured in the plain (ruby-free) text, so they stay valid
// across unwrapping and match the offsets used for splitting and merging.
function plainLength(fragment) {
  const box = document.createElement("div");
  box.appendChild(fragment);
  box.querySelectorAll("rt, rp").forEach((n) => n.remove());
  return box.textContent.length;
}

function getCaretOffsets(el) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.startContainer) || !el.contains(range.endContainer)) return null;
  const probe = document.createRange();
  probe.selectNodeContents(el);
  probe.setEnd(range.startContainer, range.startOffset);
  const start = plainLength(probe.cloneContents());
  probe.setEnd(range.endContainer, range.endOffset);
  return { start, end: plainLength(probe.cloneContents()) };
}

function getCaretOffset(el) {
  return getCaretOffsets(el)?.start ?? null;
}

function setCaretOffset(el, offset) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest("rt, rp") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  let node = null;
  let last = null;
  let remaining = offset;
  while ((node = walker.nextNode())) {
    last = node;
    if (remaining <= node.length) break;
    remaining -= node.length;
  }
  const range = document.createRange();
  if (node) range.setStart(node, remaining);
  else if (last) range.setStart(last, last.length);
  else range.setStart(el, 0);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

// Editing text that carries furigana: drop the ruby (it no longer lines up) but
// keep the record's results so the redo action knows what to regenerate, and
// mark the block stale so the mismatch is visible.
function invalidateBlock(view) {
  if (view.status === "loading") return;
  let changed = false;

  if (view.error) {
    view.error = null;
    changed = true;
  }

  const r = view.record;
  if ((r.tokens || r.translation || r.grammar) && !r.stale) {
    if (view.el.querySelector("ruby")) {
      const offset = getCaretOffset(view.el);
      stripRuby(view.el);
      if (offset !== null) setCaretOffset(view.el, offset);
    }
    r.stale = true;
    changed = true;
  }

  if (changed) {
    renderBlock(view, { content: false });
    scheduleSave();
  }
}

function redoBlock(view) {
  const r = view.record;
  const mode =
    r.tokens && r.translation ? "both" : r.translation && !r.tokens ? "translate" : "annotate";
  runStream([view], mode, { upgrade: !!(r.tokens && r.tokens.length) });
}

function retryBlock(view) {
  const last = view.lastRun || { mode: "annotate", upgrade: false };
  runStream([view], last.mode, { upgrade: last.upgrade });
}


// --- Editing ---
// Paragraphs are blocks, so Enter splits one and Backspace at the start merges
// it back. Everything routes through setBlockText so the record, the staleness
// flag and the save debounce stay in step.

function placeCaret(el, offset) {
  el.focus();
  setCaretOffset(el, offset);
}

// A split inherits list/pre semantics; anything else becomes a paragraph, the
// way every editor treats Enter at the end of a heading.
function splitTag(tag) {
  return tag === "li" || tag === "pre" ? tag : "p";
}

function setBlockText(view, text) {
  const r = view.record;
  if (r.text === text) return; // unchanged: keep the ruby that is already rendered
  if ((r.tokens || r.translation || r.grammar) && !r.stale) r.stale = true;
  r.text = text;
  view.error = null;
  view.el.textContent = text;
  view.el.classList.remove("kana-annotated");
  renderBlock(view, { content: false });
  scheduleSave();
}

function splitBlockAtCaret(view) {
  const offsets = getCaretOffsets(view.el);
  if (!offsets) return;
  const full = getTextWithoutRuby(view.el);
  const before = full.slice(0, offsets.start);
  const after = full.slice(offsets.end); // a non-collapsed selection is consumed

  setBlockText(view, before);
  const next = addBlockView(
    makeBlock(splitTag(view.record.tag), after),
    view.wrapper.nextElementSibling
  );
  placeCaret(next.el, 0);
  scheduleSave();
}

function mergeBlocks(prev, cur) {
  const prevText = getTextWithoutRuby(prev.el);
  const curText = getTextWithoutRuby(cur.el);
  if (curText) setBlockText(prev, prevText + curText);
  removeBlockView(cur);
  placeCaret(prev.el, prevText.length);
}

function appendBlock(tag = "p", text = "") {
  const view = addBlockView(makeBlock(tag, text));
  scheduleSave();
  return view;
}

function editableViewFor(target) {
  const el = target.closest?.(".block-content");
  if (!el) return null;
  return viewOf(el.closest(".reader-block")) || null;
}

readerBody.addEventListener("keydown", (e) => {
  const view = editableViewFor(e.target);
  if (!view) return;
  // While an IME is composing, Enter confirms the conversion — it must not split.
  if (e.isComposing || e.keyCode === 229) return;

  if (view.status === "loading") {
    if (e.key.length === 1 || ["Enter", "Backspace", "Delete"].includes(e.key)) e.preventDefault();
    return;
  }

  if (e.key === "Enter") {
    e.preventDefault();
    // Shift+Enter would need a line break the record and tokensToHtml cannot
    // round-trip, so it does nothing rather than something lossy.
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) splitBlockAtCaret(view);
    return;
  }

  if (e.key !== "Backspace" && e.key !== "Delete") return;
  const offsets = getCaretOffsets(view.el);
  if (!offsets || offsets.start !== offsets.end) return; // a real selection: let it delete

  if (e.key === "Backspace" && offsets.start === 0) {
    const prev = viewOf(view.wrapper.previousElementSibling);
    if (prev) {
      e.preventDefault();
      mergeBlocks(prev, view);
    }
  } else if (e.key === "Delete" && offsets.start === getTextWithoutRuby(view.el).length) {
    const next = viewOf(view.wrapper.nextElementSibling);
    if (next) {
      e.preventDefault();
      mergeBlocks(view, next);
    }
  }
});

// Streaming blocks are not editable, but guard the input path too in case focus
// was already inside one when the run started.
readerBody.addEventListener("beforeinput", (e) => {
  const view = editableViewFor(e.target);
  if (view?.status === "loading") e.preventDefault();
});

// Paste is always plain text; multiple lines become multiple blocks.
readerBody.addEventListener("paste", (e) => {
  const view = editableViewFor(e.target);
  if (!view) return;
  e.preventDefault();
  if (view.status === "loading") return;

  const raw = (e.clipboardData || window.clipboardData)?.getData("text/plain") || "";
  const lines = raw
    .replace(/\r\n?/g, "\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return;

  const offsets = getCaretOffsets(view.el) || { start: 0, end: 0 };
  const full = getTextWithoutRuby(view.el);
  const before = full.slice(0, offsets.start);
  const after = full.slice(offsets.end);

  if (lines.length === 1) {
    setBlockText(view, before + lines[0] + after);
    placeCaret(view.el, before.length + lines[0].length);
    return;
  }

  setBlockText(view, before + lines[0]);
  let cursor = view;
  for (let i = 1; i < lines.length - 1; i++) {
    cursor = addBlockView(makeBlock("p", lines[i]), cursor.wrapper.nextElementSibling);
  }
  const last = lines[lines.length - 1];
  const tail = addBlockView(makeBlock("p", last + after), cursor.wrapper.nextElementSibling);
  placeCaret(tail.el, last.length);
  scheduleSave();
});

addBlockBtn.addEventListener("click", () => {
  placeCaret(appendBlock().el, 0);
});

// --- Session load / save ---

function renderSession(loaded) {
  session = loaded;
  isDraft = false;
  sessionHome.hidden = true;
  document.title = loaded.title ? `${loaded.title} - 読める` : "読める Reader";
  readerTitle.textContent = loaded.title || "読める";
  originalUrl = loaded.url || "";
  if (originalUrl) {
    originalLink.href = originalUrl;
    originalLink.hidden = false;
  }
  readerBody.replaceChildren();
  views.clear();
  for (const record of loaded.blocks) addBlockView(record);
  refreshDebug();
}

// The blank reader: one paste target plus the recent-sessions list. Nothing is
// written to storage until there is actual text (see flushSave).
async function showHome(notice) {
  session = makeSession({});
  isDraft = true;
  document.title = "読める Reader";
  readerTitle.textContent = "読める";
  readerBody.replaceChildren();
  views.clear();

  const view = addBlockView(makeBlock("p", ""));
  view.el.setAttribute("placeholder", t("pasteHint"));
  view.el.classList.add("reader-empty-hint");
  sessionHome.hidden = false;
  if (notice) {
    progress.textContent = notice;
    progress.classList.add("error");
  }
  await renderSessionList();
}

async function renderSessionList() {
  const sessions = await listSessions();
  sessionList.replaceChildren();
  sessionEmpty.hidden = sessions.length > 0;

  for (const summary of sessions) {
    const item = document.createElement("li");
    item.className = "session-item";

    const main = document.createElement("div");
    main.className = "session-item-main";
    const title = document.createElement("div");
    title.className = "session-item-title";
    title.textContent = summary.title || summary.preview || t("untitledSession");
    const meta = document.createElement("div");
    meta.className = "session-item-meta";
    const count = document.createElement("span");
    count.textContent = t("nParagraphs", { n: summary.blockCount });
    const when = document.createElement("span");
    when.textContent = formatDate(summary.updatedAt);
    meta.append(count, when);
    main.append(title, meta);

    const del = document.createElement("button");
    del.className = "session-delete";
    del.textContent = "×";
    del.title = t("deleteSession");
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteSession(summary.id);
      await renderSessionList();
    });

    item.append(main, del);
    item.addEventListener("click", () => {
      location.href = `reader.html?id=${summary.id}`;
    });
    sessionList.appendChild(item);
  }
}

let saveTimer = null;
let saveDirty = false;

function scheduleSave() {
  saveDirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
}

function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!saveDirty || !session) return;

  session.blocks = getAllViews().map((v) => v.record);
  // An untouched blank reader should not litter the session list.
  if (isDraft && !session.blocks.some((b) => b.text.trim())) return;

  saveDirty = false;
  if (isDraft) {
    isDraft = false;
    history.replaceState(null, "", `?id=${session.id}`);
    sessionHome.hidden = true;
  }
  saveSession(session).catch((err) => {
    progress.textContent = err.message;
    progress.classList.add("error");
  });
}

window.addEventListener("pagehide", flushSave);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) flushSave();
});

async function loadContent() {
  const id = new URLSearchParams(location.search).get("id");

  if (id) {
    const loaded = await getSession(id);
    if (loaded) {
      renderSession(loaded);
      touchSession(id).catch(() => {});
      return;
    }
    await deleteSession(id); // the index claimed it existed; prune the stale entry
    await showHome(t("sessionNotFound"));
    return;
  }

  // One-time migration of the pre-session handoff key.
  const { readerData } = await chrome.storage.local.get("readerData");
  if (readerData?.content?.length) {
    const blocks = readerData.content
      .filter((item) => item.tag !== "img")
      .map((item) => makeBlock(item.tag, item.text));
    const created = await createSession({ title: readerData.title, url: readerData.url, blocks });
    await chrome.storage.local.remove("readerData");
    history.replaceState(null, "", `?id=${created.id}`);
    renderSession(created);
    return;
  }

  await showHome();
}

// --- Streaming annotation/translation via port ---

// Kanji alone does not distinguish Japanese from Chinese, so let the rest of
// the document decide. Recomputed per run because content can be pasted in.
let hasJapanese = makeJapaneseDetector(false);

function refreshJapaneseDetector() {
  hasJapanese = makeJapaneseDetector(hasKana(readerBody.textContent || ""));
}

// Pull any un-debounced edits out of the DOM before a run reads block texts.
function syncTexts() {
  for (const view of getAllViews()) {
    if (view.status === "loading") continue;
    view.record.text = getTextWithoutRuby(view.el);
  }
}

function hasFresh(view, mode) {
  const r = view.record;
  if (r.stale) return false;
  return mode === "annotate" ? !!(r.tokens && r.tokens.length) : !!r.translation;
}

// With a selection, act on exactly those blocks (an explicit redo). Without one,
// act on every eligible block that lacks a fresh result of this kind. Furigana
// needs Japanese; translation works on any language.
function collectTargets(mode) {
  refreshJapaneseDetector();
  const forced = getSelectedBlocks().length > 0;
  const eligible = getActionTargets().filter(
    (v) =>
      v.status !== "loading" &&
      v.record.text.trim() &&
      (mode !== "annotate" || hasJapanese(v.record.text))
  );
  if (eligible.length === 0) return { targets: [], reason: "noJapanese" };
  const targets = forced ? eligible : eligible.filter((v) => !hasFresh(v, mode));
  return { targets, reason: targets.length ? null : "nothingToDo" };
}

function setToolbarProgress(done, total) {
  progress.textContent = t("progressFormat", { done, total });
  toolbarProgressFill.style.width = `${Math.round((done / total) * 100)}%`;
}

function setToolbarRunning(running, total, reason, failed) {
  annotateBtn.disabled = running;
  translateBtn.disabled = running;
  cancelBtn.hidden = !running;

  if (running) {
    progress.classList.remove("error");
    toolbarProgress.hidden = false;
    setToolbarProgress(0, total);
    return;
  }

  toolbarProgressFill.style.width = "100%";
  setTimeout(() => {
    toolbarProgress.hidden = true;
  }, 800);

  if (reason === "cancelled") {
    progress.textContent = t("cancelled");
  } else if (reason === "disconnected") {
    progress.textContent = t("connectionLost");
    progress.classList.add("error");
  } else if (failed > 0) {
    progress.textContent = t("doneWithErrors", { n: failed });
    progress.classList.add("error");
  } else {
    progress.textContent = t("doneParagraphs", { n: total });
  }
}

// One streaming run over a set of blocks. Batch runs drive the toolbar; the
// per-block redo and retry buttons open their own port and touch only their own
// block, so they can overlap a batch.
function runStream(targetViews, mode, { upgrade = false, batch = false } = {}) {
  const targets = targetViews.filter(Boolean);
  if (targets.length === 0) return null;

  syncTexts();
  const total = targets.length;
  const run = { mode, upgrade, batch, finished: false, failed: 0, targetLang: null, cancel: null };

  const wantsTranslation = mode === "translate" || mode === "both";
  const wantsGrammar = mode === "grammar";

  for (const view of targets) {
    view.run = run;
    view.error = null;
    view.lastRun = { mode, upgrade };
    view.pendingTranslation = wantsTranslation ? "" : null;
    view.pendingGrammar = wantsGrammar ? "" : null;
    view.got = { furigana: false, translation: false, grammar: false };
    view.el.blur();
    renderBlock(view);
    if (wantsTranslation) ensureResultDiv(view, "translation").textContent = "";
    if (wantsGrammar) ensureResultDiv(view, "grammar").replaceChildren();
  }

  // The service worker needs "translateAny" for text that is not Japanese; with
  // a mixed batch it takes a per-paragraph override list.
  const modes = targets.map((v) =>
    mode === "translate" && !hasJapanese(v.record.text) ? "translateAny" : mode
  );

  if (batch) {
    activeBatch = run;
    setToolbarRunning(true, total);
  }

  const byIndex = (i) => {
    const view = targets[i];
    return view && view.run === run && view.wrapper.isConnected ? view : null;
  };

  const finish = (reason) => {
    if (run.finished) return;
    run.finished = true;

    // A block the run never reported on would otherwise stay "loading" — and so
    // uneditable — for the life of the page.
    for (const view of targets) {
      if (view.run !== run) continue;
      run.failed++;
      view.run = null;
      view.pendingTranslation = null;
      view.pendingGrammar = null;
      view.error = t("noResultForBlock");
      renderBlock(view);
    }

    try {
      port.disconnect();
    } catch {
      /* already gone */
    }
    if (batch) {
      activeBatch = null;
      setToolbarRunning(false, total, reason, run.failed);
    }
    scheduleSave();
  };

  // A block is done once every result this mode promised has arrived. Staleness
  // only clears when everything the block already had got refreshed.
  const maybeComplete = (view) => {
    const need =
      mode === "annotate"
        ? view.got.furigana
        : mode === "translate"
          ? view.got.translation
          : mode === "grammar"
            ? view.got.grammar
            : view.got.furigana && view.got.translation;
    if (!need) return;

    // Only lift staleness once every result the block already carried has been
    // refreshed — a translate-only run must not re-bless outdated furigana.
    const r = view.record;
    const fresh = (existing, produced) => !existing || produced;
    if (
      fresh(r.tokens, mode !== "translate" && mode !== "grammar" && view.got.furigana) &&
      fresh(r.translation, wantsTranslation && view.got.translation) &&
      fresh(r.grammar, wantsGrammar && view.got.grammar)
    ) {
      r.stale = false;
    }

    view.run = null;
    view.pendingTranslation = null;
    view.pendingGrammar = null;
    renderBlock(view);
    showDebugTokens(view);
    scheduleSave();
  };

  let port;
  try {
    port = chrome.runtime.connect({ name: "kana-stream" });
  } catch (err) {
    for (const view of targets) {
      view.run = null;
      view.pendingTranslation = null;
      view.pendingGrammar = null;
      view.error = err.message;
      renderBlock(view);
    }
    if (batch) {
      activeBatch = null;
      setToolbarRunning(false, total, "disconnected", total);
    }
    return null;
  }

  port.onMessage.addListener((msg) => {
    if (run.finished) return;

    if (msg.type === "langInfo") {
      run.targetLang = msg.targetLang;
      for (const view of targets) {
        if (view.transDiv) applyLangDir(view.transDiv, msg.targetLang);
        if (view.grammarDiv) applyLangDir(view.grammarDiv, msg.targetLang);
      }
      return;
    }

    const view = byIndex(msg.index);

    switch (msg.type) {
      case "furiganaPartial":
        if (view && msg.tokens?.length) view.el.innerHTML = tokensToHtml(msg.tokens);
        break;

      case "furigana":
        if (!view) break;
        if (msg.tokens?.length) {
          view.record.tokens = msg.tokens;
          view.record.rawTokens = msg.rawTokens || null;
        }
        view.got.furigana = true;
        maybeComplete(view);
        break;

      case "translationChunk":
        if (!view || view.pendingTranslation === null) break;
        view.pendingTranslation += msg.text;
        ensureResultDiv(view, "translation").textContent = view.pendingTranslation;
        break;

      case "grammarChunk":
        if (!view || view.pendingGrammar === null) break;
        view.pendingGrammar += msg.text;
        ensureResultDiv(view, "grammar").innerHTML = renderMarkdown(view.pendingGrammar);
        break;

      case "grammarDone":
        if (!view) break;
        view.record.grammar = view.pendingGrammar || null;
        view.record.translationLang = view.record.translationLang || run.targetLang;
        view.got.grammar = true;
        maybeComplete(view);
        break;

      case "translationDone":
        if (!view) break;
        view.record.translation = view.pendingTranslation || null;
        view.record.translationLang = run.targetLang;
        view.got.translation = true;
        maybeComplete(view);
        break;

      case "error":
        if (!view) break;
        run.failed++;
        view.run = null;
        view.pendingTranslation = null;
        view.pendingGrammar = null;
        view.error = msg.message;
        renderBlock(view);
        scheduleSave();
        break;

      case "progress":
        if (batch) setToolbarProgress(msg.done, total);
        break;

      case "allDone":
        finish("done");
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    if (run.finished) return; // we disconnected on purpose
    for (const view of targets) {
      if (view.run !== run) continue;
      view.run = null;
      view.pendingTranslation = null;
      view.pendingGrammar = null;
      view.error = t("connectionLost");
      renderBlock(view);
    }
    finish("disconnected");
  });

  run.cancel = () => {
    if (run.finished) return;
    // Records only ever change on a terminal message, so re-rendering from the
    // record is all it takes to undo a half-streamed block.
    for (const view of targets) {
      if (view.run !== run) continue;
      view.run = null;
      view.pendingTranslation = null;
      view.pendingGrammar = null;
      renderBlock(view);
    }
    finish("cancelled");
  };

  port.postMessage({
    type: "streamTranslate",
    paragraphs: targets.map((v) => v.record.text),
    mode,
    modes,
    upgrade,
  });
  return run;
}

function runBatch(mode) {
  if (activeBatch) return;
  syncTexts();
  const { targets, reason } = collectTargets(mode);
  if (targets.length === 0) {
    progress.classList.remove("error");
    progress.textContent = reason === "noJapanese" ? t("noJapaneseText") : t("nothingToProcess");
    return;
  }
  runStream(targets, mode, { batch: true });
}

annotateBtn.addEventListener("click", () => runBatch("annotate"));
translateBtn.addEventListener("click", () => runBatch("translate"));
cancelBtn.addEventListener("click", () => activeBatch?.cancel());

// --- TTS bottom playbar ---
// All the sequencing lives in TtsEngine; this is the UI around it.

const ttsLoadingText = document.getElementById("ttsLoadingText");
const ttsProgressTrack = document.getElementById("ttsProgressTrack");
const ttsProgressLoaded = document.getElementById("ttsProgressLoaded");
const ttsProgressFill = document.getElementById("ttsProgressFill");
const ttsProgressThumb = document.getElementById("ttsProgressThumb");
const ttsCurrentTime = document.getElementById("ttsCurrentTime");
const ttsTotalTime = document.getElementById("ttsTotalTime");
const ttsPrevBtn = document.getElementById("ttsPrevBtn");
const ttsPlayBtn = document.getElementById("ttsPlayBtn");
const ttsNextBtn = document.getElementById("ttsNextBtn");
const ttsSpeedSelect = document.getElementById("ttsSpeedSelect");
const ttsCloseBtn = document.getElementById("ttsCloseBtn");

let ttsDragging = false;
let ttsDragWasPlaying = false;
let ttsRafId = null;
let ttsErrorTimer = null;

const engine = new TtsEngine({
  getBlockText: (blockId) => views.get(blockId)?.record.text ?? "",
  blockExists: (blockId) => views.has(blockId),
  getVoiceSettings: async () => {
    const settings = await getSync(["ttsModel", "ttsVoice"]);
    return {
      ttsModel: settings.ttsModel || "",
      ttsVoice: settings.ttsVoice || DEFAULTS.ttsVoice,
    };
  },
});

function ttsFormatTime(secs) {
  if (!isFinite(secs) || secs < 0) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Which blocks a play request covers: the selection when there is one, else the
// whole article. Starting from a block inside the selection keeps that scope.
function ttsScopeIds(startBlockId) {
  const selected = getSelectedBlocks().map((b) => b.dataset.blockId);
  const useSelection =
    selected.length > 0 && (!startBlockId || selected.includes(startBlockId));
  const ids = useSelection ? selected : getAllBlocks().map((b) => b.dataset.blockId);
  return ids.filter((id) => (views.get(id)?.record.text ?? "").trim());
}

async function playFrom(blockId) {
  if (await engine.load(ttsScopeIds(blockId), { startBlockId: blockId })) engine.play();
}

async function playBlocks(blockIds) {
  if (await engine.load(blockIds)) engine.play();
}

// Phase 2's block menu asks for playback through the DOM, so it needs no direct
// reference to the engine.
readerBody.addEventListener("reader:tts", (e) => {
  const { mode, blockId, blockIds } = e.detail || {};
  if (mode === "from") playFrom(blockId);
  else if (mode === "blocks") playBlocks(blockIds);
});

function setTtsStatusText(text, isError = false) {
  clearTimeout(ttsErrorTimer);
  ttsLoadingText.textContent = text || "";
  ttsLoadingText.hidden = !text;
  ttsLoadingText.classList.toggle("error", isError);
  if (isError) ttsErrorTimer = setTimeout(() => setTtsStatusText(""), 4000);
}

function renderTtsStatus() {
  const running = ["playing", "gap"].includes(engine.status);
  const buffering = engine.status === "buffering";
  ttsPlayBtn.textContent = running || buffering ? "⏸" : "▶";
  ttsPlayBtn.classList.toggle("buffering", buffering);
  if (buffering) setTtsStatusText(t("ttsBuffering"));
  else if (!ttsLoadingText.classList.contains("error")) setTtsStatusText("");

  if (engine.isActive && !ttsRafId) ttsRafId = requestAnimationFrame(ttsRafUpdate);
}

// Segments whose real length is known are drawn solid over the hatched estimate,
// so the listener can see how far ahead the audio is fetched.
function renderTtsTimeline() {
  const { total, estimatedTotal, ranges } = engine.getTimeline();
  ttsProgressLoaded.replaceChildren();
  if (total <= 0) return;

  for (const range of ranges) {
    if (!range.ready) continue;
    const span = document.createElement("span");
    span.style.left = `${(range.start / total) * 100}%`;
    span.style.width = `${(range.dur / total) * 100}%`;
    ttsProgressLoaded.appendChild(span);
  }

  ttsTotalTime.textContent = (estimatedTotal > 0 ? "~" : "") + ttsFormatTime(total);
  ttsTotalTime.classList.toggle("estimated", estimatedTotal > 0);
  ttsTotalTime.title = estimatedTotal > 0 ? t("ttsEstimated") : "";
}

function ttsRafUpdate() {
  if (!engine.isActive) {
    ttsRafId = null;
    return;
  }
  ttsRafId = requestAnimationFrame(ttsRafUpdate);
  if (ttsDragging) return;

  const total = engine.getTimeline().total;
  const pos = engine.getPosition();
  const pct = total > 0 ? Math.min(100, (pos / total) * 100) : 0;
  ttsProgressFill.style.width = `${pct}%`;
  ttsProgressThumb.style.left = `${pct}%`;
  ttsCurrentTime.textContent = ttsFormatTime(pos);
}

engine.addEventListener("status", renderTtsStatus);
engine.addEventListener("timeline", renderTtsTimeline);

engine.addEventListener("segment", (e) => {
  const { blockId } = e.detail;
  for (const block of readerBody.querySelectorAll(".tts-playing")) {
    block.classList.remove("tts-playing");
  }
  if (!blockId) return;
  const view = views.get(blockId);
  if (!view) return;
  view.wrapper.classList.add("tts-playing");
  view.el.scrollIntoView({ behavior: "smooth", block: "nearest" });
});

engine.addEventListener("error", (e) => {
  const { blockId, message, fatal } = e.detail;
  const view = views.get(blockId);
  if (view) {
    view.wrapper.classList.add("tts-error");
    view.wrapper.title = t("ttsParagraphFailed");
  }
  setTtsStatusText(message, true);
  if (fatal) renderTtsStatus();
});

function resetTtsUi() {
  cancelAnimationFrame(ttsRafId);
  ttsRafId = null;
  for (const block of readerBody.querySelectorAll(".tts-playing")) {
    block.classList.remove("tts-playing");
  }
  ttsPlayBtn.textContent = "▶";
  ttsPlayBtn.classList.remove("buffering");
  setTtsStatusText("");
  ttsProgressLoaded.replaceChildren();
  ttsProgressFill.style.width = "0%";
  ttsProgressThumb.style.left = "0%";
  ttsCurrentTime.textContent = "0:00";
  ttsTotalTime.textContent = "--:--";
  ttsTotalTime.classList.remove("estimated");
}

ttsPlayBtn.addEventListener("click", async () => {
  if (!engine.isActive) {
    if (await engine.load(ttsScopeIds(null))) engine.play();
    return;
  }
  engine.toggle();
});

ttsPrevBtn.addEventListener("click", () => engine.skip(-1));
ttsNextBtn.addEventListener("click", () => engine.skip(1));
ttsSpeedSelect.addEventListener("change", () => engine.setSpeed(parseFloat(ttsSpeedSelect.value)));
ttsCloseBtn.addEventListener("click", () => {
  engine.stop();
  resetTtsUi();
});

function ttsGetTrackFrac(e) {
  const rect = ttsProgressTrack.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
}

function ttsDragUpdatePos(e) {
  const total = engine.getTimeline().total;
  if (total <= 0) return;
  const frac = ttsGetTrackFrac(e);
  ttsProgressFill.style.width = `${frac * 100}%`;
  ttsProgressThumb.style.left = `${frac * 100}%`;
  ttsCurrentTime.textContent = ttsFormatTime(frac * total);
}

ttsProgressTrack.addEventListener("mousedown", (e) => {
  if (!engine.isActive) return;
  ttsDragging = true;
  ttsDragWasPlaying = ["playing", "gap", "buffering"].includes(engine.status);
  ttsProgressTrack.classList.add("dragging");
  if (ttsDragWasPlaying) engine.pause();
  ttsDragUpdatePos(e);
});

document.addEventListener("mousemove", (e) => {
  if (ttsDragging) ttsDragUpdatePos(e);
});

document.addEventListener("mouseup", (e) => {
  if (!ttsDragging) return;
  ttsDragging = false;
  ttsProgressTrack.classList.remove("dragging");
  if (!engine.isActive) return;
  engine.seekRatio(ttsGetTrackFrac(e));
  if (ttsDragWasPlaying) engine.play();
});

// --- Vocabulary popup (select text or click ruby in annotated blocks) ---

// extractFromSelection / getWordFromRuby / extractSentence provided by KanaShared (see top of file).

function getTextWithoutRuby(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll("rt, rp").forEach((n) => n.remove());
  return clone.textContent;
}

function findReaderContext(node) {
  const el = node.nodeType === 3 ? node.parentElement : node;
  // Translations and the error row are not study material.
  if (el.closest(".reader-translation, .block-status, .block-actions, .kana-debug")) return null;
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
  showVocabPopup({
    rootClass: "reader-vocab-popup",
    word,
    reading,
    context,
    sourceUrl: originalUrl || location.href,
    rect,
    labels: { save: t("addToVocab"), added: t("added"), failed: t("failed") },
  });
}

// --- Quiz panel ---

const quizPanel = document.getElementById("quiz-panel");
const quizBody = document.getElementById("quiz-body");
const quizScopeNote = document.getElementById("quizScopeNote");
const quizCloseBtn = document.getElementById("quizCloseBtn");
const readerLayout = document.getElementById("readerLayout");
let quizStartTime = null;
let quizData = null;
let answeredCount = 0;
let correctCount = 0;

// The quiz model gets a bounded amount of text. Cutting at a block boundary
// here (rather than mid-sentence inside lib/api.js) means we can also say which
// paragraphs the questions actually came from.
const QUIZ_CHAR_LIMIT = 4000;
let quizScope = null;

function buildQuizSource(targetViews) {
  const usable = targetViews.filter((v) => v.record.text.trim());
  const parts = [];
  const usedIds = [];
  let length = 0;

  for (const view of usable) {
    const text = view.record.text.trim();
    if (length + text.length + 2 > QUIZ_CHAR_LIMIT && parts.length > 0) break;
    parts.push(text.slice(0, QUIZ_CHAR_LIMIT));
    usedIds.push(view.record.id);
    length += text.length + 2;
  }

  return { text: parts.join("\n\n"), usedIds, total: usable.length };
}

function markQuizScope(usedIds) {
  clearQuizScope();
  for (const id of usedIds) views.get(id)?.wrapper.classList.add("quiz-scope");
}

function clearQuizScope() {
  for (const block of readerBody.querySelectorAll(".quiz-scope")) {
    block.classList.remove("quiz-scope");
  }
}

function describeQuizScope({ scope, usedIds, total }) {
  const notes = [];
  if (scope === "selection") notes.push(t("quizScopeSelected", { n: usedIds.length }));
  if (usedIds.length < total) {
    notes.push(t("quizScopeTruncated", { used: usedIds.length, total }));
  }
  return notes.join(" · ");
}

// Bottom-sheet layout stacks above the playbar rather than under it.
function positionQuizSheet() {
  if (quizPanel.hidden) return;
  const bar = document.getElementById("ttsBar");
  const offset = window.innerWidth <= 900 && bar ? bar.offsetHeight : 0;
  quizPanel.style.setProperty("--quiz-sheet-bottom", `${offset}px`);
}

window.addEventListener("resize", positionQuizSheet);

async function startQuiz() {
  const selected = getSelectedBlocks();
  const scope = selected.length > 0 ? "selection" : "all";
  const source = buildQuizSource(getActionTargets());
  if (!source.text.trim()) return;

  quizScope = { ...source, scope };
  markQuizScope(source.usedIds);

  quizPanel.hidden = false;
  readerLayout.classList.add("quiz-open");
  positionQuizSheet();
  quizScopeNote.textContent = describeQuizScope(quizScope);
  quizScopeNote.hidden = !quizScopeNote.textContent;
  quizBody.innerHTML = `<div class="quiz-loading">${t("quizGenerating")}</div>`;
  quizBtn.disabled = true;

  const { jlptLevel = DEFAULTS.jlptLevel, targetLang = DEFAULTS.targetLang } = await chrome.storage.sync.get(["jlptLevel", "targetLang"]);

  try {
    const response = await chrome.runtime.sendMessage({
      type: "generateQuiz",
      text: source.text,
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
    scope: quizScope?.scope || "all",
    blockCount: quizScope?.usedIds.length || 0,
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
  clearQuizScope();
}

quizBtn.addEventListener("click", startQuiz);
quizCloseBtn.addEventListener("click", closeQuiz);

// --- Study aids ---
// Hiding readings or translations turns the reader into a self-test; both are
// per-user preferences rather than per-article, so they live in sync storage.

const LEARNING_PREFS = {
  readerHideFurigana: { toggle: () => hideFuriganaToggle, cls: "hide-furigana" },
  readerHideTranslation: { toggle: () => hideTranslationToggle, cls: "hide-translation" },
};

function applyLearningPrefs(values) {
  for (const [key, { toggle, cls }] of Object.entries(LEARNING_PREFS)) {
    const on = !!values[key];
    toggle().checked = on;
    readerBody.classList.toggle(cls, on);
  }
  // Anything the reader had revealed goes back under cover.
  readerBody.querySelectorAll(".revealed").forEach((el) => el.classList.remove("revealed"));
}

for (const [key, { toggle }] of Object.entries(LEARNING_PREFS)) {
  toggle().addEventListener("change", (e) => {
    applyLearningPrefs({ ...currentLearningPrefs(), [key]: e.target.checked });
    setSync({ [key]: e.target.checked }).catch(() => {});
  });
}

function currentLearningPrefs() {
  return {
    readerHideFurigana: hideFuriganaToggle.checked,
    readerHideTranslation: hideTranslationToggle.checked,
  };
}

// Click a blurred result to reveal just that one.
readerBody.addEventListener("click", (e) => {
  if (!readerBody.classList.contains("hide-translation")) return;
  const result = e.target.closest(".reader-translation, .reader-grammar");
  if (result) result.classList.toggle("revealed");
});

// --- Boot ---

getSync(["debugMode", ...Object.keys(LEARNING_PREFS)])
  .then((settings) => {
    debugMode = !!settings.debugMode;
    refreshDebug();
    applyLearningPrefs({ ...DEFAULTS, ...settings });
  })
  .catch(() => {});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.debugMode) {
    debugMode = !!changes.debugMode.newValue;
    refreshDebug();
  }
  if (Object.keys(LEARNING_PREFS).some((key) => changes[key])) {
    applyLearningPrefs({ ...currentLearningPrefs(), ...mapNewValues(changes) });
  }
});

function mapNewValues(changes) {
  const out = {};
  for (const key of Object.keys(LEARNING_PREFS)) {
    if (changes[key]) out[key] = changes[key].newValue;
  }
  return out;
}

loadContent();
