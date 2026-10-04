import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../../../config/index.js';
import { createStore } from '../../../store/index.js';
import { createCheckpoints } from '../../../checkpoints/index.js';
import { createRecords } from '../../../records/index.js';
import { createSessionManager } from '../../../session-manager/index.js';
import type { Envelope, OperatorId } from '../../../contract/index.js';

async function waitFor(predicate: () => boolean) {
  const until = Date.now() + 10000;
  while (!predicate()) {
    assert.ok(Date.now() < until, 'timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

for (const scenario of ['approval-request', 'approval-file']) {
  for (const decision of ['allow', 'deny'] as const) {
    test(`#80 — ${scenario}: browser session path audits ${decision} and resolves once`, async t => {
      const root = await mkdtemp(path.join(tmpdir(), 'codex-approval-host-'));
      const workspace = path.join(root, 'workspace');
      await mkdir(workspace);
      process.env['SKYNET_CODEX_EXECUTABLE'] = path.resolve('src/agent-console/providers/codex-cli/fixtures/fake-codex-cli.mjs');
      process.env['SKYNET_CODEX_SCENARIO'] = scenario;
      const configured = loadConfig({ AUTH_MODE: 'shared-secret', AUTH_COOKIE_NAME: 'test', AUTH_SECRET: 'test', WORKSPACE_ROOTS: workspace, STORAGE_ROOT: path.join(root, 'store') });
      assert.ok(configured.ok);
      const config = configured.value;
      const stored = await createStore(config);
      assert.ok(stored.ok);
      const store = stored.value;
      const manager = createSessionManager({ config, store, checkpoints: createCheckpoints(config), records: createRecords({ config, store }) });
      t.after(async () => {
        await manager.shutdown();
        await store.close();
        delete process.env['SKYNET_CODEX_EXECUTABLE'];
        delete process.env['SKYNET_CODEX_SCENARIO'];
        // turn.ended precedes Windows releasing the child's cwd handle.
        await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      });
      const owner = 'operator' as OperatorId;
      const created = await manager.create(owner, { vendor: 'codex', cwd: workspace, sandbox: 'read-only', model: null, requisitionId: null });
      assert.ok(created.ok);
      const id = created.value.sessionId;
      const events: Envelope[] = [];
      await manager.subscribe(id, owner, 0, { deliver: e => { if ('seq' in e) events.push(e); }, close() {} });
      assert.ok((await manager.message(id, owner, 'approval test', [])).ok);
      await waitFor(() => events.some(e => e.kind === 'permission.request'));
      const request = events.find(e => e.kind === 'permission.request')!;
      assert.equal(request.kind, 'permission.request');
      if (request.kind !== 'permission.request') return;
      const answer = await manager.answerPermission(id, owner, { requestId: request.data.requestId, decision, scope: 'once', rule: null, reason: decision === 'deny' ? 'operator denied' : null });
      assert.ok(answer.ok && answer.value.accepted);
      await waitFor(() => events.some(e => e.kind === 'turn.ended'));
      const resolutions = events.filter(e => e.kind === 'permission.resolved');
      assert.equal(resolutions.length, 1);
      assert.equal(resolutions[0]!.data.decision, decision);
      const audit = (await readFile(path.join(config.storageRoot, 'audit.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(audit.length, 1);
      assert.equal(audit[0].decision, decision);
      assert.deepEqual(audit[0].input, request.data.input);
    });
  }
}
