import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

// #382: a bare `rename` over an existing file fails on Windows whenever another rename or open
// on the target is in flight, and each such site was one more test failing at random under
// full-suite load. Every production rename goes through `renameOver`, which retries that
// refusal; this pins it, so a new temp-file-then-rename site cannot quietly reintroduce the
// bare call. The one allowed importer is `renameOver`'s own module.
const ROOT = path.resolve('src');
const ALLOWED = path.join('agent-console', 'process', 'rename-over.ts');
const FS_MODULES = new Set(['fs', 'fs/promises', 'node:fs', 'node:fs/promises']);
const RENAMES = new Set(['rename', 'renameSync']);

function bareRenames(source: string, filename: string): string[] {
  const found: string[] = [];
  const fsNamespaces = new Set<string>();
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && FS_MODULES.has(node.moduleSpecifier.text)) {
      const bindings = node.importClause?.namedBindings;
      const fsDefault = node.importClause?.name;
      if (fsDefault) fsNamespaces.add(fsDefault.text);
      if (bindings && ts.isNamespaceImport(bindings)) fsNamespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          const imported = (el.propertyName ?? el.name).text;
          if (RENAMES.has(imported)) found.push(`import { ${imported} } from '${node.moduleSpecifier.text}'`);
        }
      }
    } else if (ts.isPropertyAccessExpression(node) && RENAMES.has(node.name.text)) {
      const target = node.expression;
      const base = ts.isPropertyAccessExpression(target) ? target.expression : target;
      if (ts.isIdentifier(base) && fsNamespaces.has(base.text)) found.push(node.getText());
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}

async function productionSources(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const filename = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await productionSources(filename));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(filename);
  }
  return files;
}

test('#382 — no production source renames a file except through renameOver', async () => {
  const files = await productionSources(ROOT);
  assert.ok(files.some((f) => path.relative(ROOT, f) === ALLOWED), 'renameOver\u2019s own module must be found by the scan');
  const violations: string[] = [];
  for (const file of files) {
    if (path.relative(ROOT, file) === ALLOWED) continue;
    violations.push(...bareRenames(await readFile(file, 'utf8'), file).map((hit) => `${path.relative(ROOT, file)}: ${hit}`));
  }
  assert.deepEqual(violations, []);
});

const planted = [
  { source: "import { rename } from 'node:fs/promises';", hits: 1 },
  { source: "import { readFile, rename as mv } from 'fs/promises';", hits: 1 },
  { source: "import { renameSync } from 'node:fs';", hits: 1 },
  { source: "import * as fs from 'node:fs/promises'; await fs.rename('a', 'b');", hits: 1 },
  { source: "import fs from 'node:fs'; fs.promises.rename('a', 'b');", hits: 1 },
  { source: "import { renameOver } from './agent-console/process/rename-over.js'; await renameOver('a', 'b');", hits: 0 },
  { source: "const manager = { rename() {} }; manager.rename();", hits: 0 },
];
for (const [index, fixture] of planted.entries()) {
  test(`#382 — the rename scan ${fixture.hits ? 'rejects' : 'accepts'} planted source ${index + 1}`, () => {
    assert.equal(bareRenames(fixture.source, 'planted.ts').length, fixture.hits);
  });
}
