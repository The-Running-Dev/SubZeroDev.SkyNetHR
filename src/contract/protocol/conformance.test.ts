import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import ts from 'typescript';

const GENERIC = path.resolve('src/agent-console/protocol');
const HOST = path.resolve('src/contract/protocol');
const DIALECT = 'https://json-schema.org/draft/2020-12/schema';

interface Schema {
  $schema: string;
  $id: string;
  properties?: { kind?: { const?: string } };
  [key: string]: unknown;
}

async function jsonFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await jsonFiles(file));
    else if (entry.name.endsWith('.json')) files.push(file);
  }
  return files.sort();
}

const roots = [GENERIC, HOST];
const schemas: { file: string; schema: Schema }[] = [];
for (const root of roots) {
  for (const file of await jsonFiles(path.join(root, 'schemas'))) {
    schemas.push({ file, schema: JSON.parse(await readFile(file, 'utf8')) as Schema });
  }
}
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats.default(ajv, { mode: 'full', formats: ['date-time'] });
for (const { schema } of schemas) ajv.addSchema(schema);

for (const { file, schema } of schemas) {
  test(`Phase 1b — load schema ${path.relative(process.cwd(), file)}`, () => {
    assert.equal(schema.$schema, DIALECT);
    assert.ok(ajv.getSchema(schema.$id), `could not compile ${file} (${schema.$id})`);
  });
}

interface Fixture {
  file: string;
  root: string;
  valid: boolean;
  family: 'envelopes' | 'frames';
  data: Record<string, unknown>;
}

const fixtures: Fixture[] = [];
for (const root of roots) {
  for (const validity of ['valid', 'invalid'] as const) {
    const dir = path.join(root, 'fixtures', validity);
    for (const file of await jsonFiles(dir)) {
      // Select from the corpus path, not the data: a malformed kind or a frame
      // with an illicit seq must still reach the schema it is meant to exercise.
      const family = path.relative(dir, file).split(path.sep)[0];
      assert.ok(family === 'envelopes' || family === 'frames', `unclassified fixture: ${file}`);
      fixtures.push({ file, root, valid: validity === 'valid', family,
        data: JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown> });
    }
  }
}

for (const fixture of fixtures) {
  const filename = fixture.family === 'envelopes' ? 'envelope.schema.json' : 'frame.schema.json';
  // SkyNetHR uses the exact generic frame; it augments only the envelope vocabulary.
  const root = fixture.family === 'frames' ? GENERIC : fixture.root;
  const entry = schemas.find(s => s.file === path.join(root, 'schemas', filename));
  assert.ok(entry, `missing entry schema for ${fixture.file}`);
  const label = `${path.relative(process.cwd(), fixture.file)} — ${entry.schema.$id} / ${String(fixture.data.kind)}`;
  test(`Phase 1b — ${fixture.valid ? 'accept' : 'reject'} ${label}`, () => {
    const validate = ajv.getSchema(entry.schema.$id);
    assert.ok(validate, label);
    const before = structuredClone(fixture.data);
    assert.equal(validate(fixture.data), fixture.valid, `${label}\n${ajv.errorsText(validate.errors)}`);
    if (fixture.root === GENERIC && fixture.family === 'envelopes') {
      const hostEntry = schemas.find(s => s.file === path.join(HOST, 'schemas/envelope.schema.json'));
      assert.ok(hostEntry);
      const hostValidate = ajv.getSchema(hostEntry.schema.$id);
      assert.ok(hostValidate);
      assert.equal(hostValidate(fixture.data), fixture.valid,
        `${fixture.file} — ${hostEntry.schema.$id}\n${ajv.errorsText(hostValidate.errors)}`);
    }
    assert.deepEqual(fixture.data, before, 'validation must not normalise the fixture');
  });
}

// Read the actual declarations, including the host's module augmentation. There
// is no hand-maintained event list whose omission could make this test green.
async function declaredKinds(file: string): Promise<string[]> {
  const tree = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const kinds: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'EventPayloadMap') {
      for (const member of node.members) {
        assert.ok(ts.isPropertySignature(member) && member.name);
        assert.ok(ts.isIdentifier(member.name) || ts.isStringLiteral(member.name));
        kinds.push(member.name.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return kinds.sort();
}

test('Phase 1b — every declared event has a schema and a valid fixture; report corpus counts', async t => {
  const genericKinds = await declaredKinds(path.resolve('src/agent-console/contract/index.ts'));
  const hostKinds = await declaredKinds(path.resolve('src/contract/index.ts'));
  for (const [root, kinds] of [[GENERIC, genericKinds], [HOST, hostKinds]] as const) {
    const eventSchemas = schemas.filter(s => path.dirname(s.file) === path.join(root, 'schemas/events'));
    assert.deepEqual(eventSchemas.map(s => s.schema.properties?.kind?.const).sort(), kinds);
    const validKinds = new Set(fixtures.filter(f => f.root === root && f.valid).map(f => f.data.kind));
    assert.deepEqual([...validKinds].sort(), kinds);
  }
  const frames = fixtures.filter(f => f.valid && f.family === 'frames');
  const source = await readFile(path.resolve('src/agent-console/contract/index.ts'), 'utf8');
  const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const frameKind = tree.statements.find(n => ts.isTypeAliasDeclaration(n) && n.name.text === 'FrameKind');
  assert.ok(frameKind && ts.isTypeAliasDeclaration(frameKind));
  assert.ok(ts.isLiteralTypeNode(frameKind.type) && ts.isStringLiteral(frameKind.type.literal));
  assert.equal(frameKind.type.literal.text, 'message.delta');
  assert.ok(frames.length > 0);
  assert.deepEqual([...new Set(frames.map(f => f.data.kind))], ['message.delta']);
  assert.ok(frames.every(f => !Object.hasOwn(f.data, 'seq')));
  assert.ok(fixtures.filter(f => f.valid && f.family === 'envelopes')
    .every(f => f.data.kind !== 'message.delta' && Object.hasOwn(f.data, 'seq')));
  const valid = fixtures.filter(f => f.valid).length;
  const invalid = fixtures.length - valid;
  assert.ok(valid > 0 && invalid > 0);
  t.diagnostic(`Schemas: ${schemas.length}; valid fixtures: ${valid}; invalid fixtures: ${invalid}; ` +
    `event kinds: ${genericKinds.length + hostKinds.length}; frame kinds: 1`);
});

function vendorLiterals(text: string): string[] {
  return text.match(/claude|codex|copilot|openai|anthropic/gi) ?? [];
}

test('Phase 1b — generic schemas and fixtures contain no vendor literals or outward schema references', async () => {
  const ids = new Set(schemas.filter(s => s.file.startsWith(GENERIC + path.sep)).map(s => s.schema.$id));
  for (const file of await jsonFiles(GENERIC)) {
    const text = await readFile(file, 'utf8');
    assert.deepEqual(vendorLiterals(text), [], file);
    if (!file.endsWith('.schema.json')) continue;
    const schema = JSON.parse(text) as Schema;
    function visit(value: unknown): void {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key === '$ref' || key === '$dynamicRef') {
          assert.equal(typeof child, 'string', file);
          const target = new URL(child as string, schema.$id);
          target.hash = '';
          assert.ok(ids.has(target.href), `${file}: outward reference ${String(child)}`);
        } else visit(child);
      }
    }
    visit(schema);
  }
});

test('Phase 1b — neutrality detects planted vendor literals in JSON', () => {
  for (const vendor of ['claude', 'codex', 'copilot', 'openai', 'anthropic']) {
    assert.equal(vendorLiterals(JSON.stringify({ enum: [vendor] })).length, 1);
  }
});

test('Phase 1b — every valid JSON fixture also typechecks against the unchanged host contract', () => {
  const filename = path.resolve('src/contract/protocol/fixture-typecheck.ts');
  const source = `import type { Envelope, Frame } from '../index.js';
type JsonShape<T> = T extends { readonly __brand: string }
  ? T extends string ? string : number
  : T extends readonly (infer U)[] ? readonly JsonShape<U>[]
  : T extends object ? { [K in keyof T]: JsonShape<T[K]> } : T;
` + fixtures.filter(f => f.valid).map((fixture, i) =>
    `// ${path.relative(process.cwd(), fixture.file)}\n` +
    `const value${i} = ${JSON.stringify(fixture.data)} as const;\n` +
    `const check${i}: JsonShape<${fixture.family === 'frames' ? 'Frame' : 'Envelope'}> = value${i};`
  ).join('\n');
  const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const options = { ...parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) =>
    path.resolve(file) === filename
      ? ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
      : readSource(file, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([filename], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: file => file,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => '\n',
  }));
});
