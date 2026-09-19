#!/usr/bin/env node
// #416: S26 manager/subscribe/answerPermission pattern, with a real Claude CLI and
// a deterministic local Messages API. No real model or billable usage is simulated
// as evidence: the measured surface is the actual model-bound request content.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSessionManager } from '../dist/session-manager/index.js';
import { createStore } from '../dist/store/index.js';
import { createCheckpoints } from '../dist/checkpoints/index.js';

const cli = process.argv[2];
if (!cli || !path.isAbsolute(cli)) throw new Error('usage: node harness/run-416-probes.mjs <absolute-path-to-claude-binary>');
const version = execFileSync(cli, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
const root = await mkdtemp(path.join(tmpdir(), 'skynet-416-'));
console.log(JSON.stringify({ version, evidence: root, billing: 'not measured; local API stub' }));
const json = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ndjson = async file => (await readFile(file, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return ''; throw error;
})).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const bridge = fileURLToPath(new URL('./probe-416-cli.mjs', import.meta.url));

async function run(name, tool, mode) {
  const directory = path.join(root, name);
  const cwd = path.join(directory, 'workspace');
  const configDir = path.join(directory, 'claude');
  await mkdir(cwd, { recursive: true });
  await mkdir(configDir);
  const originalFile = path.join(cwd, 'original.txt');
  const cachedFile = path.join(cwd, 'cached.txt');
  await writeFile(originalFile, 'PROBE_ORIGINAL_RESULT\n');
  await writeFile(cachedFile, 'PROBE_CACHED_RESULT\n');
  const options = { cli, mode, cachedFile,
    wireLog: path.join(directory, 'wire.ndjson'), hookLog: path.join(directory, 'hooks.ndjson'),
    stderrLog: path.join(directory, 'stderr.log') };
  const optionsPath = path.join(directory, 'options.json');
  await json(optionsPath, options);
  const input = tool === 'Read' ? { file_path: originalFile } : { file_path: path.join(cwd, 'written.txt'), content: 'PROBE_WRITE_RESULT\n' };
  const requests = [];
  let serverError;
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      if (!req.url?.split('?')[0].endsWith('/v1/messages')) {
        res.writeHead(404); res.end('Probe only implements /v1/messages'); return;
      }
      const request = JSON.parse(body);
      requests.push(request);
      await appendFile(path.join(directory, 'model-requests.ndjson'), JSON.stringify(request) + '\n');
      if (requests.length > 2) throw new Error('unexpected third model request');
      const first = requests.length === 1;
      const content = first ? { type: 'tool_use', id: 'toolu_probe416', name: tool, input } : { type: 'text', text: 'PROBE_DONE' };
      // Synthetic usage exists only to satisfy the Messages protocol. Never used
      // in a token-cost assertion or presented as vendor billing evidence.
      const message = { id: `msg_probe416_${requests.length}`, type: 'message', role: 'assistant', model: request.model,
        content: [content], stop_reason: first ? 'tool_use' : 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 } };
      if (!request.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(message)); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      send({ type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      send({ type: 'content_block_start', index: 0, content_block: first ? { ...content, input: {} } : { type: 'text', text: '' } });
      send({ type: 'content_block_delta', index: 0, delta: first ? { type: 'input_json_delta', partial_json: JSON.stringify(input) } : { type: 'text_delta', text: content.text } });
      send({ type: 'content_block_stop', index: 0 });
      send({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } });
      send({ type: 'message_stop' }); res.end();
    } catch (error) { serverError = error; res.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // Isolate user settings and auth. The only credential is a dummy for this local server.
  const overrides = { SKYNET_CLAUDE_EXECUTABLE: bridge, SKYNET_PROBE_416_OPTIONS: optionsPath,
    CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    ANTHROPIC_API_KEY: 'local-probe-not-a-credential', ANTHROPIC_AUTH_TOKEN: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CODE_USE_BEDROCK: undefined, CLAUDE_CODE_USE_VERTEX: undefined,
    CLAUDE_CODE_USE_FOUNDRY: undefined, CLAUDECODE: undefined, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    HTTP_PROXY: undefined, HTTPS_PROXY: undefined, ALL_PROXY: undefined, http_proxy: undefined,
    https_proxy: undefined, all_proxy: undefined, NO_PROXY: '127.0.0.1,localhost' };
  const saved = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  const setEnv = values => { for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } };
  setEnv(overrides);
  const config = { bind: { host: '127.0.0.1', port: 3000 },
    auth: { mode: 'shared-secret', cookieName: 'skynet', secret: 'harness' },
    workspaceRoots: [cwd], storageRoot: path.join(directory, 'store'), allowedOrigins: [], trustProxy: [],
    caps: { ringCapacity: 500, toolResultBytes: 65536, subscriberQueueHighWater: 1000, keepaliveMs: 15000,
      auditPageMax: 200, reviewBodyBytes: 1024, requisitionTextBytes: 1024 },
    includeRaw: false, sessionTokenBudget: null, checklist: [] };
  let manager;
  const events = [];
  let ended, answerError;
  try {
    const stored = await createStore(config); assert.equal(stored.ok, true, JSON.stringify(stored));
    manager = createSessionManager({ config, store: stored.value, checkpoints: createCheckpoints(config), records: undefined });
    const owner = 'harness-operator';
    const created = await manager.create(owner, { vendor: 'claude', cwd, model: 'sonnet', sandbox: null, requisitionId: null });
    assert.equal(created.ok, true, JSON.stringify(created));
    const { sessionId } = created.value;
    const subscribed = await manager.subscribe(sessionId, owner, 0, { close() {}, deliver: async envelope => {
      events.push(envelope);
      if (envelope.kind === 'permission.request') {
        const answered = await manager.answerPermission(sessionId, owner, { requestId: envelope.data.requestId,
          decision: mode === 'operator-deny' ? 'deny' : 'allow', scope: 'once', rule: null, reason: 'PROBE_AUDIT_ONLY' });
        if (!answered.ok || !answered.value.accepted) answerError = answered;
      }
      if (envelope.kind === 'turn.ended') ended = envelope.data;
    } });
    assert.equal(subscribed.ok, true, JSON.stringify(subscribed));
    const sent = await manager.message(sessionId, owner, 'Execute the requested probe tool, then reply PROBE_DONE.', []);
    assert.equal(sent.ok, true, JSON.stringify(sent));
    const waitForTurn = async () => {
      const deadline = Date.now() + 60000;
      while (!ended && !serverError && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      if (serverError) throw serverError;
      assert.ok(ended, 'timed out waiting for turn.ended');
    };
    await waitForTurn();
    if (mode === 'operator-deny') {
      // SkyNet sends interrupt:true on deny. Resume to inspect the denied tool
      // result in the next model request, rather than mistaking a stopped turn
      // for proof that denial text never reaches the model.
      assert.equal(requests.length, 1, 'deny should interrupt before continuation');
      ended = undefined;
      const resumed = await manager.message(sessionId, owner, 'Continue without retrying the denied tool.', []);
      assert.equal(resumed.ok, true, JSON.stringify(resumed));
      await waitForTurn();
    }
    assert.equal(ended.stopReason, 'completed', JSON.stringify({ ended, errors: events.filter(e => e.kind === 'error') }));
    assert.equal(answerError, undefined, JSON.stringify(answerError));
  } finally {
    await json(path.join(directory, 'events.json'), events);
    await manager?.shutdown();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    setEnv(saved);
  }
  const wire = await ndjson(options.wireLog);
  const hooks = await ndjson(options.hookLog);
  const permissions = events.filter(e => e.kind === 'permission.request');
  const results = requests.at(-1)?.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'tool_result') ?? [];
  assert.equal(requests.length, 2, 'expected a tool-call request and one continuation');
  assert.equal(results.length, 1, 'expected exactly one model-bound tool result');
  const result = results[0];
  if (tool === 'Write') {
    const written = await readFile(input.file_path, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null; throw error;
    });
    assert.equal(written, mode === 'operator-deny' ? null : input.content, 'unexpected Write side effect');
  }
  const summary = { name, modelRequests: requests.length, permissions: permissions.length, hooks: hooks.length,
    controlResponses: wire.filter(e => e.direction === 'stdin' && e.record?.type === 'control_response').length,
    toolResult: result, syntheticUsage: true,
    hookOutputs: hooks.map(hook => hook.output),
    controlWire: wire.filter(e => ['control_request', 'control_response'].includes(e.record?.type)),
    normalizedMessagesSha256: digest(JSON.stringify(requests[1].messages).split(cwd).join('<workspace>')),
    systemHashes: requests.map(request => digest(request.system)),
    toolDefinitionHashes: requests.map(request => digest(request.tools)) };
  await json(path.join(directory, 'summary.json'), summary);
  console.log(JSON.stringify({ name, modelRequests: summary.modelRequests, permissions: summary.permissions,
    hooks: summary.hooks, controlResponses: summary.controlResponses, toolResult: result }));
  return { summary, requests, wire, cwd };
}

const summaries = [];
try {
  for (const mode of ['allow', 'candidate', 'deny', 'rewrite']) {
    const runResult = await run(`hook-${mode}`, 'Read', mode);
    const { summary } = runResult;
    summaries.push(summary);
    assert.equal(summary.hooks, 1, 'hook must actually fire');
    const output = JSON.stringify(summary.toolResult.content);
    if (mode === 'deny') {
      assert.equal(summary.toolResult.is_error, true);
      assert.ok(output.includes('PROBE_DENIAL_ONLY'));
      assert.ok(!output.includes('PROBE_ORIGINAL_RESULT'));
    } else {
      assert.ok(!summary.toolResult.is_error);
      assert.ok(output.includes(mode === 'rewrite' ? 'PROBE_CACHED_RESULT' : 'PROBE_ORIGINAL_RESULT'));
      assert.ok(!output.includes('PROBE_SUBSTITUTE_RESULT'));
    }
  }
  const automatic = await run('control-automatic', 'Write', 'automatic');
  const interactive = await run('control-interactive', 'Write', 'interactive');
  summaries.push(automatic.summary, interactive.summary);
  assert.equal(automatic.summary.permissions, 0);
  assert.equal(automatic.summary.controlResponses, 0);
  assert.equal(interactive.summary.permissions, 1);
  assert.equal(interactive.summary.controlResponses, 1);
  const normalize = result => JSON.stringify(result.requests[1].messages).split(result.cwd).join('<workspace>');
  assert.equal(normalize(interactive), normalize(automatic), 'approval must leave identical model-bound message history');
  const modelBody = JSON.stringify(interactive.requests);
  assert.deepEqual(interactive.requests[1].system, interactive.requests[0].system, 'approval changed system context');
  assert.deepEqual(interactive.requests[1].tools, interactive.requests[0].tools, 'approval changed tool definitions');
  assert.ok(!modelBody.includes('PROBE_AUDIT_ONLY'), 'audit reason leaked to model');
  for (const entry of interactive.wire.filter(e => e.record?.type === 'control_response')) {
    assert.ok(!modelBody.includes(entry.record.response.request_id), 'permission request id leaked to model');
  }
  assert.ok(!modelBody.includes('control_response') && !modelBody.includes('control_request'));
  const denied = await run('control-denied-resume', 'Write', 'operator-deny');
  summaries.push(denied.summary);
  assert.equal(denied.summary.permissions, 1);
  assert.equal(denied.summary.controlResponses, 1);
  assert.equal(denied.summary.toolResult.is_error, true);
  assert.ok(!JSON.stringify(denied.requests).includes('PROBE_AUDIT_ONLY'));
  const deniedModelBody = JSON.stringify(denied.requests);
  assert.ok(!deniedModelBody.includes('control_response') && !deniedModelBody.includes('control_request'));
  for (const entry of denied.wire.filter(e => e.record?.type === 'control_response')) {
    assert.ok(!deniedModelBody.includes(entry.record.response.request_id));
  }
  await json(path.join(root, 'summary.json'), { version, platform: process.platform, node: process.version,
    billing: 'not measured', summaries,
    approvalMessagesIdentical: true, conclusion: 'PreToolUse candidate ignored; deny is an error; input rewrite executes Read; allow control envelopes absent from model requests; operator denial becomes model-visible on resume.' });
  console.log(`PASS: evidence at ${root}`);
} catch (error) {
  await json(path.join(root, 'failure.json'), { version, error: error.stack, summaries });
  console.error(`INCONCLUSIVE/FAILED: ${error.stack}\nEvidence: ${root}`);
  process.exitCode = 1;
}
