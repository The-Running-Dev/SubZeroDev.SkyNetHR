import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

// Concrete provider directories and host composition own vendor identity. Shared
// provider modules, the host core, edges and renderer remain neutral (I20).
// Tests are excluded; production imports and comments are scanned too.
const SRC_ROOT = path.join(process.cwd(), 'src');
const RESTRICTED_DIRS: ReadonlyArray<{ dir: string; extension: string }> = [
  { dir: path.join(SRC_ROOT, 'config'), extension: '.ts' },
  { dir: path.join(SRC_ROOT, 'jail'), extension: '.ts' },
  { dir: path.join(SRC_ROOT, 'store'), extension: '.ts' },
  { dir: path.join(SRC_ROOT, 'session-manager'), extension: '.ts' },
  { dir: path.join(SRC_ROOT, 'contract'), extension: '.ts' },
  { dir: path.join(SRC_ROOT, 'agent-console'), extension: '.ts' },
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

function vendorNames(source: string): string[] {
  return source.split('\n').filter(line => /claude|codex/i.test(line));
}
function vendorBranches(source: string): string[] {
  return source.split('\n').filter(line => /\bvendor\s*[!=]==(?!\s*'')/i.test(line));
}

test('S1.10 — vendor names are confined to concrete providers and host registration', async () => {
  const offendingLines: string[] = [];

  for (const { dir, extension } of RESTRICTED_DIRS) {
    const files = (await sourceFilesUnder(dir, extension)).filter(file => {
      const relative = path.relative(SRC_ROOT, file).split(path.sep).join('/');
      return relative !== 'config/providers.ts' && !/^agent-console\/providers\/[^/]+\//.test(relative);
    });
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      for (const line of vendorNames(content)) offendingLines.push(`${file}: ${line.trim()}`);
    }
  }

  assert.deepEqual(offendingLines, []);
});

test('S1.10 — no conditional above adapters/* tests a `vendor` field', async () => {
  const offendingLines: string[] = [];
  for (const { dir, extension } of RESTRICTED_DIRS) {
    const files = (await sourceFilesUnder(dir, extension)).filter(file => {
      const relative = path.relative(SRC_ROOT, file).split(path.sep).join('/');
      return relative !== 'config/providers.ts' && !/^agent-console\/providers\/[^/]+\//.test(relative);
    });
    for (const file of files) {
      const content = await readFile(file, 'utf8');
      for (const line of vendorBranches(content)) offendingLines.push(`${file}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offendingLines, []);
});

// These are intentionally outside every provider leaf, so the exemptions cannot mask them.
test('Phase 2 — vendor neutrality rejects planted names in shared provider and core code', () => {
  const sources = [
    "export const vendor = 'claude';",
    "import { codexProvider } from './codex-cli/provider.js';",
    "if (input.vendor === providerId) choose();",
  ];
  assert.equal(vendorNames(sources[0]!).length, 1);
  assert.equal(vendorNames(sources[1]!).length, 1);
  assert.equal(vendorBranches(sources[2]!).length, 1);
});
