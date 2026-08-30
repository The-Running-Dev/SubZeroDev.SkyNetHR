import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

// S1.10/I20 says "no module above `adapters/*`" — not just the five S1.10 happened to
// name; `edge/*` sits above `adapters/*` too and is scanned for the same reason (#238).
// `adapters/*` itself is exempt (it is the one module allowed to know a vendor exists).
// Test sources are excluded: the criterion is about the shipped modules' control flow,
// not fixtures.
const RESTRICTED_DIRS = ['config', 'jail', 'store', 'session-manager', 'contract', 'edge'];

async function tsFilesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await tsFilesUnder(full)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(full);
  }
  return files;
}

test('S1.10 — the literals "claude" and "codex" appear in config, jail, store, session-manager and contract sources only as the Vendor type declaration', async () => {
  const root = path.join(process.cwd(), 'src');
  const offendingLines: string[] = [];

  for (const dirName of RESTRICTED_DIRS) {
    const files = await tsFilesUnder(path.join(root, dirName));
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
  const root = path.join(process.cwd(), 'src');
  const offendingLines: string[] = [];
  for (const dirName of RESTRICTED_DIRS) {
    const files = await tsFilesUnder(path.join(root, dirName));
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        // Looks for `.vendor ===`, `.vendor !==`, `vendor ===`, `vendor !==` used as a
        // branch condition — the pass-through `input.vendor` argument to `createAdapter`
        // is not a comparison and does not match this pattern.
        if (/\bvendor\s*[!=]==/i.test(line)) offendingLines.push(`${file}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offendingLines, []);
});
