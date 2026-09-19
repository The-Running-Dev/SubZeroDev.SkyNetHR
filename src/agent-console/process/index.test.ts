import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import { test } from 'node:test';
import { closeStdin, spawnProcess, resolveSpawn, reportableImage, protectStdin, createProcessSupervisor, terminateProcess, killProbe } from './index.js';
import { createProcessMetadata } from './metadata.js';
import { createTermination } from './termination.js';
import type { ProcessLedger, ProcessRecord } from './ledger.js';
import type { IsoTimestamp } from '../contract/index.js';

test('Phase 3 spawn — direct command, cwd, pipes, environment, stdin EOF, exit then close', { timeout: 10000 }, async () => {
  const program = `let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{
    process.stdout.write(JSON.stringify({text,cwd:process.cwd(),color:process.env.FORCE_COLOR,noColor:process.env.NO_COLOR}));
    process.stderr.write('stderr observed');});`;
  const child = spawnProcess(resolveSpawn(process.execPath, ['-e', program], false), {
    cwd: process.cwd(), overrides: { FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const order: string[] = [];
  let stdout = '', stderr = '';
  child.on('spawn', () => order.push('spawn'));
  child.on('exit', () => order.push('exit'));
  child.on('close', () => order.push('close'));
  child.stdout!.on('data', chunk => { stdout += chunk; });
  child.stderr!.on('data', chunk => { stderr += chunk; });
  protectStdin(child);
  const closed = once(child, 'close');
  closeStdin(child, 'prompt with spaces and & shell characters');
  assert.deepEqual(await closed, [0, null]);
  assert.deepEqual(order, ['spawn', 'exit', 'close']);
  assert.deepEqual(JSON.parse(stdout), { text: 'prompt with spaces and & shell characters', cwd: process.cwd(), color: '0', noColor: '1' });
  assert.equal(stderr, 'stderr observed');
});

test('Phase 3 spawn — Windows shims, spaced paths and script fixtures keep their resolution', () => {
  assert.deepEqual(resolveSpawn('agent', ['--help'], true, 'win32'), { command: 'agent', args: ['--help'], shell: true });
  for (const ext of ['cmd', 'BAT']) {
    const executable = `C:\\Program Files\\agent.${ext}`;
    assert.deepEqual(resolveSpawn(executable, ['arg'], false, 'win32'), { command: `"${executable}"`, args: ['arg'], shell: true });
    assert.equal(resolveSpawn(executable, [], false, 'linux').shell, false);
  }
  for (const executable of ['fixture.mjs', 'fixture.js']) {
    for (const platform of ['win32', 'linux'] as const) {
      assert.deepEqual(resolveSpawn(executable, ['arg'], true, platform), { command: process.execPath, args: [executable, 'arg'], shell: false });
    }
  }
  assert.deepEqual(resolveSpawn('agent.exe', [], false, 'win32'), { command: 'agent.exe', args: [], shell: false });
});

test('Phase 3 metadata — reportable shell image and direct executable are preserved', () => {
  assert.equal(reportableImage('agent', false), 'agent');
  assert.equal(reportableImage('fixture.mjs', false), 'fixture.mjs');
  const comspec = process.env.ComSpec ?? process.env.COMSPEC ?? 'cmd.exe';
  assert.equal(reportableImage('agent.cmd', true), comspec.replace(/^.*[\\/]/, '').replace(/\.exe$/i, ''));
});

// Reports any single probe that took more than two seconds, because the timeout below cannot.
// A cancelled test prints no assertion, so a recurrence is otherwise a bare `test timed out`
// naming none of the five probes; the ones that did finish are in the log, and the hung one is
// then the next in sequence by elimination.
async function timedProbe<T>(label: string, probe: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const value = await probe();
  const elapsed = Date.now() - startedAt;
  if (elapsed > 2000) console.log(`[metadata probe] ${label} took ${elapsed}ms`);
  return value;
}

// The budget is a hang detector, not a latency assertion. Five serial child processes are
// unavoidable here: Windows reads the image with `tasklist` and the creation time by starting
// `powershell` (`metadata.ts`), and the two same-pid reads are the stability claim itself
// (S29.1), so neither can be dropped or cached. Measured on an idle Windows dev machine the
// five cost about 1.1s in total; a contended four-vCPU windows-latest runner exceeded 20s
// while the rest of the suite ran in parallel, which is what the old budget tripped on. 120s
// keeps a genuinely hung probe failing rather than hanging CI, without policing contention.
test('Phase 3 metadata — live process identity is stable and missing processes fail closed', { timeout: 120000 }, async () => {
  const metadata = createProcessMetadata();
  assert.ok(await timedProbe('live image', () => metadata.getProcessImage(process.pid)));
  const first = await timedProbe('live createdAt', () => metadata.getOsCreatedAt(process.pid));
  if (process.platform === 'win32' || process.platform === 'linux') assert.ok(first);
  else assert.equal(first, null);
  assert.equal(await timedProbe('live createdAt again', () => metadata.getOsCreatedAt(process.pid)), first);
  assert.equal(await timedProbe('absent image', () => metadata.getProcessImage(2147483647)), null);
  assert.equal(await timedProbe('absent createdAt', () => metadata.getOsCreatedAt(2147483647)), null);
  assert.equal(metadata.imagesMatch('node.exe', 'node'), true);
  assert.equal(metadata.imagesMatch('NODE.EXE', 'node'), process.platform === 'win32');
  assert.equal(metadata.imagesMatch('other', 'node'), false);
});

function fakeChild(pid: number | undefined, signals: unknown[] = []): ChildProcess {
  return Object.assign(new EventEmitter(), { pid, kill: (signal: unknown) => { signals.push(signal); return true; } }) as ChildProcess;
}

function timerSeam() {
  const callbacks: (() => void)[] = [];
  const delays: number[] = [];
  let unrefs = 0;
  const schedule = ((callback: () => void, delay: number) => {
    callbacks.push(callback); delays.push(delay);
    return { unref() { unrefs++; } };
  }) as unknown as typeof setTimeout;
  return { callbacks, delays, schedule, unrefs: () => unrefs };
}

test('Phase 3 termination — POSIX group TERM is synchronous, KILL follows the unchanged unref grace', () => {
  const calls: unknown[] = [];
  const timer = timerSeam();
  const termination = createTermination({ platform: 'linux', schedule: timer.schedule,
    signal: (pid, signal) => { calls.push([pid, signal]); return true; } });
  const child = fakeChild(123);
  termination.terminate(child, candidate => candidate === child);
  assert.deepEqual(calls, [[-123, 'SIGTERM']]);
  assert.deepEqual(timer.delays, [2000]);
  assert.equal(timer.unrefs(), 1);
  timer.callbacks[0]!();
  assert.deepEqual(calls, [[-123, 'SIGTERM'], [-123, 'SIGKILL']]);
});

test('Phase 3 termination — POSIX group failure falls back to the child for both stages', () => {
  const signals: unknown[] = [];
  const timer = timerSeam();
  const termination = createTermination({ platform: 'linux', schedule: timer.schedule, signal: () => { throw new Error('no group'); } });
  const child = fakeChild(123, signals);
  termination.terminate(child, () => true);
  timer.callbacks[0]!();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  child.kill = () => { throw new Error('already gone'); };
  assert.doesNotThrow(() => termination.terminate(child, () => true));
  assert.doesNotThrow(() => timer.callbacks[1]!());
});

test('Phase 3 termination — close or supersession prevents delayed escalation against the old child', () => {
  for (const next of [null, fakeChild(456)]) {
    const signals: unknown[] = [];
    const timer = timerSeam();
    const termination = createTermination({ platform: 'linux', schedule: timer.schedule,
      signal: (pid, signal) => { signals.push([pid, signal]); return true; } });
    const child = fakeChild(123);
    let current: ChildProcess | null = child;
    termination.terminate(child, candidate => candidate === current);
    current = next;
    timer.callbacks[0]!();
    assert.deepEqual(signals, [[-123, 'SIGTERM']]);
    termination.terminate(fakeChild(undefined), () => true);
    assert.equal(timer.callbacks.length, 1);
  }
});

test('Phase 3 termination — Windows live kill dispatches taskkill immediately; orphan kill awaits exit', async () => {
  const calls: unknown[][] = [];
  const killers: ChildProcess[] = [];
  const timer = timerSeam();
  const spawnKill = ((...args: unknown[]) => {
    calls.push(args); const child = fakeChild(99); killers.push(child); return child;
  }) as typeof spawn;
  const termination = createTermination({ platform: 'win32', spawn: spawnKill, schedule: timer.schedule });
  assert.equal(termination.terminate(fakeChild(123), () => true), undefined);
  assert.deepEqual(calls[0], ['taskkill', ['/PID', '123', '/T', '/F']]);
  assert.equal(timer.callbacks.length, 0);
  killers[0]!.emit('error', new Error('gone')); // ignored for the live-child path
  let finished = false;
  const killing = termination.killProcessTree(456, 789).then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.deepEqual(calls[1], ['taskkill', ['/PID', '456', '/T', '/F']]);
  killers[1]!.emit('exit', 0);
  await killing;
  assert.equal(finished, true);
  termination.killProbe(fakeChild(321));
  assert.deepEqual(calls[2], ['taskkill', ['/PID', '321', '/T', '/F'], { stdio: 'ignore' }]);
});

test('Phase 3 termination — orphan and probe paths preserve immediate force and distinct fallback rules', async () => {
  const calls: unknown[] = [];
  const timer = timerSeam();
  const termination = createTermination({ platform: 'linux', schedule: timer.schedule,
    signal: (pid, signal) => { calls.push([pid, signal]); return true; } });
  await termination.killProcessTree(123, 456);
  await termination.killProcessTree(123, null);
  termination.killProbe(fakeChild(789));
  assert.deepEqual(calls, [[-456, 'SIGKILL'], [-123, 'SIGKILL'], [-789, 'SIGKILL']]);
  assert.equal(timer.callbacks.length, 0);
  const fallback: unknown[] = [];
  const failed = createTermination({ platform: 'linux', signal: () => { throw new Error('gone'); } });
  await failed.killProcessTree(123, null);
  failed.killProbe(fakeChild(789, fallback));
  assert.deepEqual(fallback, ['SIGKILL']);
});

test('Phase 3 termination — real POSIX detached group accepts TERM and reports exit', {
  skip: process.platform === 'win32', timeout: 10000,
}, async () => {
  const child = spawnProcess(resolveSpawn(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], false), { cwd: process.cwd() });
  let current: ChildProcess | null = child;
  child.on('close', () => { current = null; });
  const closed = once(child, 'close');
  try {
    await once(child.stdout!, 'data');
    terminateProcess(child, candidate => candidate === current);
    assert.deepEqual(await closed, [null, 'SIGTERM']);
  } finally {
    if (current) killProbe(child);
  }
});

test('Phase 3 supervisor — injected ledger receives host facts verbatim and keeps typed failures', async () => {
  const calls: unknown[] = [];
  const record = { pid: 7 } as ProcessRecord;
  const error = { reason: 'unavailable' };
  const ledger: ProcessLedger<typeof error> = {
    async appendPid(value) { calls.push(value); return { ok: false, error }; },
    async tombstonePid(pid, exitedAt) { calls.push([pid, exitedAt]); return { ok: true, value: undefined }; },
    async readOpenPids() { return [record]; },
  };
  const supervisor = createProcessSupervisor(ledger);
  assert.equal(supervisor.ledger, ledger);
  const appended = await supervisor.ledger.appendPid(record);
  assert.deepEqual(appended, { ok: false, error });
  assert.equal(calls[0], record);
  const timestamp = '2026-09-17T00:00:00.000Z' as IsoTimestamp;
  await supervisor.ledger.tombstonePid(7, timestamp);
  assert.deepEqual(calls[1], [7, timestamp]);
  assert.deepEqual(await supervisor.ledger.readOpenPids(), [record]);
});
