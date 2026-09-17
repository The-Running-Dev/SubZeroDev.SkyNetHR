import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import ts from 'typescript';
import type { Request, Response, Operations } from './wire.js';
import { browserMethods } from './wire.js';

const schema = JSON.parse(await readFile('src/agent-console/protocol/schemas/wire.schema.json', 'utf8'));
const fixtures = JSON.parse(await readFile('src/agent-console/protocol/wire-fixtures/operations.json', 'utf8')) as { method: keyof Operations; request: unknown; response: {result: unknown} }[];
const ajv = new Ajv2020({ strict: true, allErrors: true }); addFormats.default(ajv); ajv.addSchema(schema);
const validate = (ref: string, value: unknown) => { const check = ajv.getSchema(schema.$id + '#/$defs/' + ref)!; assert.ok(check(value), JSON.stringify(check.errors)); };

test('Phase 4 schemas — all 33 operations have request and result fixtures in both directions', () => {
  const methods = Object.keys(schema.$defs).filter(name => name.endsWith('.request')).map(name => name.slice(0, -8)).sort();
  assert.equal(methods.length, 33); assert.deepEqual(fixtures.map(f => f.method).sort(), methods);
  for (const f of fixtures) { validate(f.method + '.request', f.request); validate(f.method + '.result', f.response.result); }
  const typedRequest: Request<'events.credit'> = { jsonrpc: '2.0', id: 1, method: 'events.credit', params: { principal: 'p', subscriptionId: 's', count: 1 } };
  const typedResponse: Response<'sessions.list'> = { jsonrpc: '2.0', id: 1, result: { items: [], next: null } };
  validate('events.credit.request', typedRequest); validate('sessions.list.result', typedResponse.result);
});

test('Phase 4 schemas — optional null equals absent; unknown outcomes remain opaque strings', () => {
  const base = { jsonrpc: '2.0', id: 1, method: 'sessions.list', params: { principal: 'p' } };
  validate('sessions.list.request', base); validate('sessions.list.request', { ...base, params: { ...base.params, cursor: null, limit: null } });
  validate('host.create.status.result', { state: 'future-state' });
  validate('event', { sessionId: 's', ts: '2026-09-17T00:00:00Z', kind: 'future.kind', data: {}, seq: 1 });
  validate('event', { sessionId: 's', ts: '2026-09-17T00:00:00Z', kind: 'message.delta', data: {}, seq: null });
});

test('Phase 4 admin — browser routing whitelist excludes every privileged and host operation', () => {
  assert.ok(browserMethods.every(method => !method.startsWith('admin.') && !method.startsWith('host.') && !method.startsWith('runtime.')));
  for (const f of fixtures.filter(f => f.method.startsWith('admin.'))) assert.ok(!(browserMethods as readonly string[]).includes(f.method));
});

test('Phase 4 schemas — reject missing required fields, unsafe integers, oversized chunks and wrong id spaces', () => {
  const wrong = [
    ['events.credit.request', { jsonrpc: '2.0', id: 1, method: 'events.credit', params: { subscriptionId: 's', count: 1 } }],
    ['events.credit.request', { jsonrpc: '2.0', id: 1, method: 'events.credit', params: { principal: 'p', subscriptionId: 's', count: 2 ** 53 } }],
    ['toolOutput.read.params', { sessionId: 's', principal: 'p', turnId: 't', callId: 'c', offset: 0, length: 262145 }],
    ['host.create.status.request', { jsonrpc: '2.0', id: 1, method: 'host.create.status', params: { createAttemptId: 's' } }],
    ['event', { sessionId: 's', ts: 'not-time', kind: 'message', data: {} }],
    ['event', { sessionId: 's', ts: '2026-09-17T00:00:00Z', kind: 'message', data: {}, raw: 'not-object' }],
  ] as const;
  for (const [ref, value] of wrong) assert.equal(ajv.getSchema(schema.$id + '#/$defs/' + ref)!(value), false, ref);
});

test('Phase 4 schemas — every JSON request/result fixture typechecks; missing required fields fail the compiler', () => {
  const filename = path.resolve('src/agent-console/protocol/wire-fixture-typecheck.ts');
  const source = "import type { Request, Response } from './wire.js';\n" + fixtures.map((f, i) =>
    `const request${i}: Request<'${f.method}'> = ${JSON.stringify(f.request)};\nconst response${i}: Response<'${f.method}'> = ${JSON.stringify(f.response)};`).join('\n') +
    "\n// @ts-expect-error principal is required\nconst invalid: Request<'sessions.get'> = {jsonrpc:'2.0',id:1,method:'sessions.get',params:{sessionId:'s'}};";
  const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile), parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const options = { ...parsed.options, noEmit: true }, host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
  host.getSourceFile = (file, version, onError, fresh) => path.resolve(file) === filename ? ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true) : original(file, version, onError, fresh);
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([filename], options, host));
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: f => f, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' }));
});
