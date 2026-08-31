import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

// S1.10/I20 says "no module above `adapters/*`" — not just the five S1.10 happened to
// name; `edge/*` and `client/` sit above `adapters/*` too and are scanned for the same
// reason (#238, #92). `adapters/*` itself is exempt (it is the one module allowed to know
// a vendor exists). Test sources are excluded: the criterion is about the shipped modules'
// control flow, not fixtures.
//
// `client` is the one entry rooted outside `src/`: it ships as plain JS with no build step,
// at the repo-root `client/` directory — `src/client/` holds only this file's own
// cross-cutting test (`src/client/index.test.ts` reads `client/`'s sources directly), not a
// TypeScript module of its own.
const SRC_ROOT = path.join(process.cwd(), 'src');
const RESTRICTED_DIRS: ReadonlyArray<{ dir: string; extension: string }> = [
  { dir: path.join(SRC_ROOT, 'config'), extension: '.ts' },
  { dir: path.join(SRC_ROOT, 'jail'), extension: '.ts' },
  { dir: path.join(SRC_ROOT, 'store'), extension: '.ts' },
  { dir: path.join(SRC_ROOT, 'session-manager'), extension: '.ts' },
  { dir: path.join(SRC_ROOT, 'contract'), extension: '.ts' },
  { dir: path.join(SRC_ROOT, 'edge'), extension: '.ts' },
  { dir: path.join(process.cwd(), 'client'), extension: '.js' },
];

async function sourceFilesUnder(dir: string, extension: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFilesUnder(full, extension)));
    else if (entry.name.endsWith(extension) && !entry.name.endsWith(`.test${extension}`)) files.push(full);
  }
  return files;
}

test('S1.10 — the literals "claude" and "codex" appear in config, jail, store, session-manager, contract, edge and client sources only as the Vendor type declaration', async () => {
  const offendingLines: string[] = [];

  for (const { dir, extension } of RESTRICTED_DIRS) {
    const files = await sourceFilesUnder(dir, extension);
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        if (!/claude|codex/i.test(line)) continue;
        const isVendorDeclaration = /export type Vendor = 'claude' \| 'codex';/.test(line);
        if (!isVendorDeclaration) offendingLines.push(`${file}: ${line.trim()}`);
      }
    }
  }

  assert.deepEqual(offendingLines, []);
});

test('S1.10 — no conditional above adapters/* tests a `vendor` field', async () => {
  const offendingLines: string[] = [];
  for (const { dir, extension } of RESTRICTED_DIRS) {
    const files = await sourceFilesUnder(dir, extension);
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        // Looks for `.vendor ===`, `.vendor !==`, `vendor ===`, `vendor !==` compared
        // against a vendor identity — the pass-through `input.vendor` argument to
        // `createAdapter` is not a comparison and does not match this pattern. Excluded:
        // comparison against `''`, a required-field presence check (`client/app.js` reads
        // it exactly like the `cwd`/`title` checks beside it) rather than a branch on
        // which vendor it is.
        if (/\bvendor\s*[!=]==(?!\s*'')/i.test(line)) offendingLines.push(`${file}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offendingLines, []);
});
