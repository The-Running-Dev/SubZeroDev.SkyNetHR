// Self-test for `assertions.js`, per D245: "each backed by a self-test proving it fails when
// the condition it checks is violated." No browser involved — these are pure functions over
// already-extracted numbers, so this file runs in the ordinary `npm test` (`client/**/*.test.js`)
// with no dependency on a Chromium-family browser being present.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FONT_SIZE_TOKENS_REM,
  LINE_HEIGHT_MULTIPLE,
  assertFontSizeToken,
  assertLineHeightMultiple,
  assertHitArea,
  assertHiddenIsNone,
  assertNoHorizontalScroll,
} from './assertions.js';

test('assertFontSizeToken passes on each declared token and fails off it', () => {
  const root = 16; // typical browser default, in px
  for (const token of FONT_SIZE_TOKENS_REM) {
    assert.doesNotThrow(() => assertFontSizeToken(token * root, root));
  }
  assert.throws(() => assertFontSizeToken(17, root), /is not one of/);
});

test('assertLineHeightMultiple passes at the declared multiple and fails off it', () => {
  const fontSize = 16;
  assert.doesNotThrow(() => assertLineHeightMultiple(fontSize * LINE_HEIGHT_MULTIPLE, fontSize));
  assert.throws(() => assertLineHeightMultiple(fontSize * 1.0, fontSize), /does not match/);
});

test('assertLineHeightMultiple has nothing to compare for a "normal" computed value', () => {
  assert.equal(assertLineHeightMultiple(null, 16), null);
});

test('assertHitArea passes on a real hit area and fails on a collapsed one', () => {
  assert.doesNotThrow(() => assertHitArea(44, 32));
  assert.throws(() => assertHitArea(0, 32), /collapsed/);
  assert.throws(() => assertHitArea(44, 0), /collapsed/);
});

test('assertHiddenIsNone passes when [hidden] computes to none and fails when it does not', () => {
  assert.doesNotThrow(() => assertHiddenIsNone('none', true));
  // Not hidden at all — nothing to check, regardless of display.
  assert.doesNotThrow(() => assertHiddenIsNone('flex', false));
  // The exact `.panel--audit` regression: hidden, but an author `display` still renders it.
  assert.throws(() => assertHiddenIsNone('flex', true), /computed display is "flex"/);
});

test('assertNoHorizontalScroll passes when scrollWidth fits and fails when it overflows', () => {
  assert.doesNotThrow(() => assertNoHorizontalScroll(390, 390));
  assert.doesNotThrow(() => assertNoHorizontalScroll(380, 390));
  assert.throws(() => assertNoHorizontalScroll(420, 390), /scrolls horizontally/);
});
