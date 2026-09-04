// Applies the saved reading preferences before first paint.
//
// chrome.storage is async, so waiting for it would flash a light, 20px page on
// every load. This mirrors the settings into localStorage (see prefs.js) and
// reads them synchronously here. It is a separate file because MV3's CSP
// forbids inline scripts.
(function () {
  var root = document.documentElement;
  var prefs = {};
  try {
    prefs = JSON.parse(localStorage.getItem("readerPrefs") || "{}");
  } catch (e) {
    /* first run, or storage unavailable */
  }

  root.dataset.theme = prefs.readerTheme || "auto";
  root.dataset.font = prefs.readerFontSize || "m";
  root.dataset.lh = prefs.readerLineHeight || "normal";

  // "auto" cannot be expressed by a media query alone once an explicit choice
  // is also possible, so resolve the system preference into a class.
  try {
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
      root.classList.add("prefers-dark");
    }
  } catch (e) {
    /* matchMedia unavailable */
  }
})();
