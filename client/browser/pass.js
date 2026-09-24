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
  assertWithinViewport,
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

// S35.1: reveals the console (bypassing the login gate, which the masthead sits outside of
// anyway), fills the transcript with enough synthetic rows to force its own scrollbar, scrolls
// it to the end, then reads the masthead's real bounding box back out of the rendered page.
const MASTHEAD_SCROLL_PROBE = `(() => {
  const consoleEl = document.getElementById('console');
  consoleEl.hidden = false;

  const transcript = document.getElementById('transcript');
  for (let i = 0; i < 200; i += 1) {
    const row = document.createElement('p');
    row.textContent = 'synthetic transcript row ' + i + ' — enough text to occupy a real line.';
    transcript.appendChild(row);
  }
  transcript.scrollTop = transcript.scrollHeight;

  const masthead = document.querySelector('.masthead');
  const rect = masthead.getBoundingClientRect();
  return { top: rect.top, bottom: rect.bottom, viewportHeight: window.innerHeight };
})()`;

async function checkMastheadStaysVisible(page, failures) {
  await page.goto(`${page.origin}/index.html`);
  const { top, bottom, viewportHeight } = await page.evaluate(MASTHEAD_SCROLL_PROBE);
  try {
    assertWithinViewport({ top, bottom }, viewportHeight);
    return 1;
  } catch (err) {
    failures.push(`masthead visibility (S35.1): ${err.message}`);
    return 0;
  }
}

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

  let mastheadCovered = 0;

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

    const mastheadPage = await browser.newPage();
    mastheadPage.origin = server.origin;
    try {
      mastheadCovered = await checkMastheadStaysVisible(mastheadPage, failures);
    } finally {
      await mastheadPage.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }

  const total = THEMES.length * SURFACES.length;
  console.log(`S18.5 browser pass: ${covered}/${total} surface x theme checks covered across ${THEMES.length} themes.`);
  console.log(`S35.1 masthead-visibility check: ${mastheadCovered}/1 covered.`);

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
