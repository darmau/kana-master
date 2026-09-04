// reader/prefs.js — reading preferences (type size, line height, theme).
//
// Stored in chrome.storage.sync so they follow the reader between articles and
// devices, and mirrored into localStorage so prefs-boot.js can apply them
// synchronously on the next load without a flash of the default theme.

import { DEFAULTS, getSync, setSync } from "../lib/storage.js";
import { t } from "../lib/i18n.js";

export const PREF_KEYS = ["readerFontSize", "readerLineHeight", "readerTheme"];

const ATTRS = {
  readerTheme: "theme",
  readerFontSize: "font",
  readerLineHeight: "lh",
};

const OPTIONS = {
  readerFontSize: [
    { value: "s", label: () => "S" },
    { value: "m", label: () => "M" },
    { value: "l", label: () => "L" },
    { value: "xl", label: () => "XL" },
  ],
  readerLineHeight: [
    { value: "compact", label: () => t("lineHeightCompact") },
    { value: "normal", label: () => t("lineHeightNormal") },
    { value: "relaxed", label: () => t("lineHeightRelaxed") },
  ],
  readerTheme: [
    { value: "auto", label: () => t("themeAuto") },
    { value: "light", label: () => t("themeLight") },
    { value: "sepia", label: () => t("themeSepia") },
    { value: "dark", label: () => t("themeDark") },
  ],
};

const LABELS = {
  readerFontSize: () => t("fontSize"),
  readerLineHeight: () => t("lineHeight"),
  readerTheme: () => t("theme"),
};

let current = {
  readerFontSize: DEFAULTS.readerFontSize,
  readerLineHeight: DEFAULTS.readerLineHeight,
  readerTheme: DEFAULTS.readerTheme,
};

function applyPrefs(prefs) {
  current = { ...current, ...prefs };
  const root = document.documentElement;
  for (const key of PREF_KEYS) root.dataset[ATTRS[key]] = current[key];
  try {
    localStorage.setItem("readerPrefs", JSON.stringify(current));
  } catch {
    /* private mode: the boot script simply falls back to defaults */
  }
  syncPopoverState();
}

function syncPopoverState() {
  for (const btn of document.querySelectorAll(".prefs-popover [data-v]")) {
    const key = btn.closest("[data-pref]").dataset.pref;
    btn.setAttribute("aria-pressed", String(current[key] === btn.dataset.v));
  }
}

function buildPopover(popover) {
  popover.replaceChildren();
  for (const key of PREF_KEYS) {
    const row = document.createElement("div");
    row.className = "prefs-row";

    const label = document.createElement("span");
    label.textContent = LABELS[key]();

    const group = document.createElement("div");
    group.className = "prefs-seg";
    group.dataset.pref = key;
    for (const option of OPTIONS[key]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.v = option.value;
      btn.textContent = option.label();
      group.appendChild(btn);
    }

    row.append(label, group);
    popover.appendChild(row);
  }
  syncPopoverState();
}

export function initPrefs() {
  const button = document.getElementById("prefsBtn");
  const popover = document.getElementById("prefsPopover");
  if (!button || !popover) return;

  buildPopover(popover);

  popover.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-v]");
    if (!btn) return;
    const key = btn.closest("[data-pref]").dataset.pref;
    applyPrefs({ [key]: btn.dataset.v });
    setSync({ [key]: btn.dataset.v }).catch(() => {});
  });

  const close = () => {
    popover.hidden = true;
    button.setAttribute("aria-expanded", "false");
  };

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    popover.hidden = !popover.hidden;
    button.setAttribute("aria-expanded", String(!popover.hidden));
  });
  document.addEventListener("mousedown", (e) => {
    if (!popover.hidden && !e.target.closest("#prefsPopover, #prefsBtn")) close();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !popover.hidden) {
      close();
      // Handled here, so the reader's own Escape chain does not also fire.
      e.stopImmediatePropagation();
    }
  });

  // Track the system setting for "auto". Guarded because a failure here must
  // not stop the rest of the reader from booting.
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (media) {
    const syncSystemTheme = () =>
      document.documentElement.classList.toggle("prefers-dark", media.matches);
    media.addEventListener("change", syncSystemTheme);
    syncSystemTheme();
  }

  getSync(PREF_KEYS)
    .then((stored) => {
      const prefs = {};
      for (const key of PREF_KEYS) prefs[key] = stored[key] ?? DEFAULTS[key];
      applyPrefs(prefs);
    })
    .catch(() => {});

  // Keep several open reader tabs in step.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    const prefs = {};
    for (const key of PREF_KEYS) {
      if (changes[key]) prefs[key] = changes[key].newValue;
    }
    if (Object.keys(prefs).length) applyPrefs(prefs);
  });
}
