import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const ROOT = path.resolve('src/agent-console');

// Pure source check: resolution is lexical because this tree has no path aliases.
// Test sources are exempt by the owner's Phase 1a clarification; production is not.
function outsideImports(source: string, filename: string, root: string): string[] {
  const violations: string[] = [];
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  function check(specifier: ts.Node | undefined): void {
    if (!specifier || !ts.isStringLiteralLike(specifier)) {
      violations.push('<non-literal import>');
      return;
    }
    const name = specifier.text;
    if (name.startsWith('node:')) return;
    if (!name.startsWith('./') && !name.startsWith('../')) {
      violations.push(name);
      return;
    }
    const relative = path.relative(root, path.resolve(path.dirname(filename), name));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      violations.push(name);
    }
  }
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) check(node.moduleSpecifier);
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) check(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      check(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      check(node.argument.literal);
    } else if (ts.isCallExpression(node) && (
      node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require')
    )) check(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return violations;
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

test('Phase 1a — production AgentConsole imports stay inside its boundary', async () => {
  const files = await productionSources(ROOT);
  assert.ok(files.length > 0, 'the extracted production contract must exist');
  const violations: string[] = [];
  for (const file of files) {
    violations.push(...outsideImports(await readFile(file, 'utf8'), file, ROOT)
      .map(specifier => `${path.relative(ROOT, file)}: ${specifier}`));
  }
  assert.deepEqual(violations, []);
});

const planted = [
  { file: 'index.ts', source: "import type { SessionId } from '../contract/index.js';", specifier: '../contract/index.js' },
  { file: 'core/index.ts', source: "import { manager } from '../../session-manager/index.js';", specifier: '../../session-manager/index.js' },
  { file: 'index.ts', source: "export { SessionId } from '../contract/index.js';", specifier: '../contract/index.js' },
  { file: 'index.ts', source: "const host = import('../contract/index.js');", specifier: '../contract/index.js' },
];
for (const [index, fixture] of planted.entries()) {
  test(`Phase 1a — boundary rejects planted external import ${index + 1}`, () => {
    assert.deepEqual(outsideImports(fixture.source, path.join(ROOT, fixture.file), ROOT), [fixture.specifier]);
  });
}
