// S18.1/S18.4/D78 — sets `data-theme` on the root element before the document paints.
//
// A classic script (no `type="module"`), loaded before the stylesheet, blocks HTML parsing
// until it runs — so the attribute lands on `documentElement` before the browser has
// anything to paint, and there is no flash of an unthemed document. It cannot be a module:
// module scripts defer to after parsing, which is too late for this. D60: read from browser
// storage only — this value never reaches the server. `app.js` duplicates the four-letter
// theme list for its switcher rather than importing it from here, since this file must stay
// a classic script and app.js is a module.
(function () {
  var KEY = 'skynet-hr-theme';
  var THEMES = ['A', 'B', 'C', 'D'];
  var DEFAULT = 'B';
  var chosen = DEFAULT;
  try {
    var stored = localStorage.getItem(KEY);
    if (THEMES.indexOf(stored) !== -1) chosen = stored;
  } catch {
    // A storage failure (private browsing, quota) is not a reason to leave the document
    // unthemed — fall back to the default the same as an unset value.
  }
  document.documentElement.setAttribute('data-theme', chosen);
})();
