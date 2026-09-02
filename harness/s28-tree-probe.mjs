// S28.1 finding probe: can a process tree still be reached from the pid of a process
// that has already exited?
//
// child.mjs (spawned as the group leader on POSIX / as the process this script tracks
// on Windows) spawns grandchild.mjs NOT detached -- the same way a shell backgrounds a
// job with `&` without an explicit setsid/CREATE_NEW_PROCESS_GROUP, which is what a tool
// call like `npm run dev &` produces under the real CLI. The grandchild loops writing a
// heartbeat file every 50ms. The parent waits for child.mjs to exit on its own (it exits
// immediately after spawning the grandchild, before the grandchild's first write is
// guaranteed to have landed), polls the heartbeat to see whether the grandchild is alive
// and advancing on its own before any kill is issued, then issues the platform kill
// against the recorded pid/pgid and reports whether the grandchild died as a result of
// that kill, had already died on its own, or survived it.
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const isWindows = process.platform === 'win32';
const dir = mkdtempSync(join(tmpdir(), 's28-probe-'));
const heartbeat = join(dir, 'heartbeat.txt');
const startedMarker = join(dir, 'started.txt');

const grandchildScript = join(dir, 'grandchild.mjs');
writeFileSync(
  grandchildScript,
  `
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(startedMarker)}, String(process.pid));
let i = 0;
setInterval(() => { writeFileSync(${JSON.stringify(heartbeat)}, String(i++)); }, 50);
`,
);

const childScript = join(dir, 'child.mjs');
writeFileSync(
  childScript,
  `
import { spawn } from 'node:child_process';
// NOT detached: this mimics a shell '&' background job, which on POSIX stays in the
// spawning process's process group unless it explicitly calls setsid() itself, and on
// Windows stays associated with the spawning process's console/job unless explicitly
// broken away (Node's detached:true sets CREATE_NEW_PROCESS_GROUP for that purpose).
const gc = spawn(process.execPath, [${JSON.stringify(grandchildScript)}], {
  detached: false,
  stdio: 'ignore',
});
gc.unref();
// report grandchild pid on stdout, then exit immediately -- the parent process (this
// script) is gone well before the probe issues its kill, and quite possibly before the
// grandchild's own first heartbeat write has landed.
console.log('GRANDCHILD_PID=' + gc.pid);
process.exit(0);
`,
);

async function getProcessImage(pid) {
  if (isWindows) {
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
      const firstLine = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
      if (!firstLine) return null;
      const match = /^"([^"]*)"/.exec(firstLine);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }
  try {
    const { readFileSync: rfs } = await import('node:fs');
    return rfs(`/proc/${pid}/comm`, 'utf8').trim();
  } catch {
    return null;
  }
}

console.log(`platform=${process.platform}`);
console.log(`node=${process.version}`);

const child = spawn(process.execPath, [childScript], {
  detached: !isWindows,
  stdio: ['ignore', 'pipe', 'inherit'],
});

let out = '';
child.stdout.on('data', (d) => (out += d.toString()));

const childPid = child.pid;
console.log(`command: spawn(${JSON.stringify(process.execPath)}, [child.mjs], { detached: ${!isWindows} }) -> pid ${childPid}`);

await new Promise((resolve) => child.once('exit', (code, signal) => {
  console.log(`child exited: code=${code} signal=${signal}`);
  resolve();
}));

const m = /GRANDCHILD_PID=(\d+)/.exec(out);
const grandchildPid = m ? Number(m[1]) : null;
console.log(`grandchild pid reported by child (before child exit): ${grandchildPid}`);

// Poll rapidly, before issuing any kill, to see whether the grandchild is alive and
// actually advancing on its own once its immediate parent (child.mjs) is gone.
const preKillSamples = [];
for (let i = 0; i < 10; i++) {
  await new Promise((r) => setTimeout(r, 50));
  const hb = existsSync(heartbeat) ? readFileSync(heartbeat, 'utf8') : null;
  const started = existsSync(startedMarker);
  const image = grandchildPid !== null ? await getProcessImage(grandchildPid) : null;
  preKillSamples.push({ t: (i + 1) * 50, hb, started, image });
}
console.log(`pre-kill samples (grandchild ${grandchildPid}, every 50ms after child exit):`);
for (const s of preKillSamples) console.log(`  t+${s.t}ms: heartbeat=${JSON.stringify(s.hb)} started-marker=${s.started} live-image=${JSON.stringify(s.image)}`);

const aliveBeforeKill = preKillSamples[preKillSamples.length - 1].image !== null;
const advancingBeforeKill = new Set(preKillSamples.map((s) => s.hb)).size > 1;
console.log(`grandchild alive just before kill: ${aliveBeforeKill}; heartbeat advancing on its own: ${advancingBeforeKill}`);

// Now issue the platform kill against the CHILD's pid (the group leader / tree root),
// which has already exited.
if (isWindows) {
  console.log(`command: taskkill /PID ${childPid} /T /F`);
  const tk = spawn('taskkill', ['/PID', String(childPid), '/T', '/F'], { stdio: 'inherit' });
  await new Promise((r) => tk.once('exit', (code) => { console.log(`taskkill exit code: ${code}`); r(); }));
} else {
  console.log(`command: process.kill(-${childPid}, 'SIGKILL')`);
  try {
    process.kill(-childPid, 'SIGKILL');
    console.log('process.kill did not throw');
  } catch (err) {
    console.log(`process.kill threw: ${err.message}`);
  }
}

await new Promise((r) => setTimeout(r, 500));
const after1 = existsSync(heartbeat) ? readFileSync(heartbeat, 'utf8') : null;
const imageAfter1 = grandchildPid !== null ? await getProcessImage(grandchildPid) : null;
await new Promise((r) => setTimeout(r, 500));
const after2 = existsSync(heartbeat) ? readFileSync(heartbeat, 'utf8') : null;
const imageAfter2 = grandchildPid !== null ? await getProcessImage(grandchildPid) : null;

console.log(`heartbeat immediately after kill: ${JSON.stringify(after1)} (live-image=${JSON.stringify(imageAfter1)})`);
console.log(`heartbeat 500ms later: ${JSON.stringify(after2)} (live-image=${JSON.stringify(imageAfter2)})`);

if (!aliveBeforeKill) {
  console.log('RESULT: grandchild was already gone before any kill was issued (died on its own once child.mjs exited) -- INCONCLUSIVE for reachability, see pre-kill samples');
} else {
  // A live-image check alone cannot tell a running process from a not-yet-reaped
  // zombie (a killed child stays visible in the process table, comm intact, until its
  // reparented parent collects it) -- the heartbeat file's own advancement is the
  // ground truth for "still doing work", not whether the pid still resolves.
  const stillAdvancing = after1 !== after2;
  console.log(`RESULT: grandchild was alive going into the kill, and ${stillAdvancing ? 'SURVIVED it (tree reachable but kill FAILED)' : 'was killed by it (tree reachable, kill SUCCEEDED)'}`);
}

try { unlinkSync(heartbeat); } catch {}
