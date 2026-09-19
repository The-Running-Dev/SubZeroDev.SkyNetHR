#!/usr/bin/env node
// S18.5's browser pass (D245): opens a really-rendered page under each theme and reads
// computed values back out of it — no pixel comparison. Runs as `npm run test:browser`, wired
// into both `verify.yml` legs. Fails by name (S19) when no browser is found, and fails when it
// does not reach every surface x theme combination, rather than reporting a partial pass as done.
import { findBrowser } from './discover.js';
import { Browser } from './cdp.js';
import { startServer } from './server.js';
import { SURFACES, THEMES } from './surfaces.js';
import {
  assertFontSizeToken,
  assertLineHeightMultiple,
  assertHitArea,
  assertHiddenIsNone,
  assertNoHorizontalScroll,
} from './assertions.js';

// Runs inside the page over CDP. Reveals `surfaceId` (if it toggles via `hidden`), reads the
// computed values the five assertions need, then restores the `hidden` state it found.
function buildSurfaceProbe(surfaceId, hasHiddenToggle) {
  return `(() => {
    const root = document.documentElement;
    const el = document.getElementById(${JSON.stringify(surfaceId)});
    if (!el) throw new Error('surface element #' + ${JSON.stringify(surfaceId)} + ' not found in the DOM');

    if (${hasHiddenToggle}) el.hidden = false;

    const rootStyle = getComputedStyle(root);
    const elStyle = getComputedStyle(el);
    // Excludes a descendant carrying its own separate \`hidden\` attribute (e.g. "Load older",
    // shown only once there is more to load) — that is a deliberate, independent toggle, not
    // the CSS-under-theme defect this pass exists to catch, and it has no rendered geometry
    // by design.
    const controls = Array.from(el.querySelectorAll('button, input, select'))
      .filter((c) => !c.hidden)
      .map((c) => {
        const rect = c.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
    const rootFontSizePx = parseFloat(rootStyle.fontSize);
    const fontSizePx = parseFloat(elStyle.fontSize);
    const lineHeightRaw = elStyle.lineHeight;
    const lineHeightPx = lineHeightRaw === 'normal' ? null : parseFloat(lineHeightRaw);

    let hiddenDisplay = null;
    if (${hasHiddenToggle}) {
      el.hidden = true;
      hiddenDisplay = getComputedStyle(el).display;
    }

    return { rootFontSizePx, fontSizePx, lineHeightPx, controls, hiddenDisplay };
  })()`;
}

const SCROLL_PROBE = `(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
}))()`;

async function checkTheme(page, theme, failures) {
  await page.goto(`${page.origin}/index.html`);
  await page.evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`);

  const scroll = await page.evaluate(SCROLL_PROBE);
  try {
    assertNoHorizontalScroll(scroll.scrollWidth, scroll.clientWidth);
  } catch (err) {
    failures.push(`theme ${theme} (document): ${err.message}`);
  }

  let covered = 0;
  for (const surface of SURFACES) {
    const label = `theme ${theme} / ${surface.id}`;
    try {
      const data = await page.evaluate(buildSurfaceProbe(surface.id, surface.hasHiddenToggle));
      assertFontSizeToken(data.fontSizePx, data.rootFontSizePx);
      assertLineHeightMultiple(data.lineHeightPx, data.fontSizePx);
      for (const control of data.controls) {
        assertHitArea(control.width, control.height);
      }
      if (surface.hasHiddenToggle) {
        assertHiddenIsNone(data.hiddenDisplay, true);
      }
      covered += 1;
    } catch (err) {
      failures.push(`${label}: ${err.message}`);
    }
  }
  return covered;
}

async function main() {
  const executablePath = findBrowser();
  const server = await startServer();
  const browser = await Browser.launch(executablePath);

  const failures = [];
  let covered = 0;

  try {
    for (const theme of THEMES) {
      const page = await browser.newPage();
      page.origin = server.origin;
      try {
        covered += await checkTheme(page, theme, failures);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await server.close();
  }

  const total = THEMES.length * SURFACES.length;
  console.log(`S18.5 browser pass: ${covered}/${total} surface x theme checks covered across ${THEMES.length} themes.`);

  if (failures.length > 0) {
    console.error(`${failures.length} failure(s):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }

  if (covered !== total) {
    console.error(`covered ${covered} of ${total} — did not reach every surface x theme combination.`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.stack ?? String(err));
  process.exitCode = 1;
});
