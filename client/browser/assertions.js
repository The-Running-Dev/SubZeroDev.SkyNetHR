// D245/S18.5 — the five computed-value assertions the browser pass reads back out of a
// really-rendered page. Each function here is pure: it takes values already extracted by
// `pass.js` via CDP (never a DOM node, since this module has no DOM of its own) and throws
// when the condition it checks is violated. `assertions.test.js` is this file's self-test,
// proving each one fails when it should — that file runs under the ordinary `client/**/*.test.js`
// glob in `npm test` and needs no browser, since these functions take already-read numbers.

// The four font-size tokens defined once per theme in `client/app.css` (`--text-xs/sm/md/lg`),
// as a rem multiple of the root element's own font-size. Kept here rather than parsed from the
// stylesheet — per AGENTS.md's "a document states only what the tree cannot", this is the one
// place duplicating the four numbers is unavoidable: `assertFontSizeToken` needs a fixed set of
// valid values to check *against*, since the whole point of the check is that the stylesheet's
// own claim cannot be trusted to still be true.
export const FONT_SIZE_TOKENS_REM = [0.75, 0.875, 1, 1.25];

// `--line-height` in `client/app.css`, the one value every theme sets it to.
export const LINE_HEIGHT_MULTIPLE = 1.5;

/**
 * Font size in rem: the element's computed `font-size` in px, divided by the root element's
 * own computed `font-size` in px, must land on one of the theme's declared tokens.
 */
export function assertFontSizeToken(fontSizePx, rootFontSizePx, { tokens = FONT_SIZE_TOKENS_REM, tolerance = 0.01 } = {}) {
  if (!(rootFontSizePx > 0)) {
    throw new Error(`root font-size ${rootFontSizePx}px is not usable as a rem base`);
  }
  const rem = fontSizePx / rootFontSizePx;
  const matches = tokens.some((token) => Math.abs(token - rem) <= tolerance);
  if (!matches) {
    throw new Error(`font-size ${rem.toFixed(3)}rem is not one of [${tokens.join(', ')}]rem`);
  }
  return rem;
}

/**
 * Line height as a multiple of font size: `lineHeightPx / fontSizePx` must match the theme's
 * declared multiple. A computed `line-height` of `"normal"` carries no px value — callers pass
 * `null` for `lineHeightPx` in that case, and there is nothing to compare, since the element is
 * inheriting the UA default rather than the token.
 */
export function assertLineHeightMultiple(lineHeightPx, fontSizePx, { expected = LINE_HEIGHT_MULTIPLE, tolerance = 0.02 } = {}) {
  if (lineHeightPx == null) return null;
  if (!(fontSizePx > 0)) {
    throw new Error(`font-size ${fontSizePx}px is not usable to derive a line-height multiple`);
  }
  const multiple = lineHeightPx / fontSizePx;
  if (Math.abs(multiple - expected) > tolerance) {
    throw new Error(`line-height ${multiple.toFixed(3)}x does not match the expected ${expected}x`);
  }
  return multiple;
}

/**
 * Hit area from the element's own bounding box: a real (non-collapsed) width and height.
 * This does not assert a minimum size beyond zero — no minimum hit-area figure is recorded
 * anywhere in `design/`, and inventing one here would be a policy decision this file has no
 * authority to make. What it catches is a theme collapsing a control to zero width or height,
 * the same class of defect `.panel--audit`'s `[hidden]` bug was.
 */
export function assertHitArea(rectWidth, rectHeight) {
  if (!(rectWidth > 0) || !(rectHeight > 0)) {
    throw new Error(`hit area collapsed to ${rectWidth}x${rectHeight}`);
  }
  return { width: rectWidth, height: rectHeight };
}

/**
 * Effective `display` under `[hidden]`: an element carrying the `hidden` attribute must
 * compute to `display: none`. This is exactly the `.panel--audit` regression D245 cites —
 * an author `display` on the hidden element itself beats the UA `[hidden] { display: none }`
 * rule at equal specificity, so a component styled with an unconditional `display` and no
 * `:not([hidden])` qualifier renders even while hidden.
 */
export function assertHiddenIsNone(display, hiddenAttr) {
  if (hiddenAttr && display !== 'none') {
    throw new Error(`element carries [hidden] but computed display is "${display}", not "none"`);
  }
}

/**
 * Whether the document scrolls horizontally: `scrollWidth` must not exceed `clientWidth` on
 * the root element. Read at whatever viewport `pass.js` set for the check in question.
 */
export function assertNoHorizontalScroll(scrollWidth, clientWidth) {
  if (scrollWidth > clientWidth) {
    throw new Error(`document scrolls horizontally: scrollWidth ${scrollWidth}px > clientWidth ${clientWidth}px`);
  }
}
