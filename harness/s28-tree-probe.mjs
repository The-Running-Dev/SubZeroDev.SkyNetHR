// S28.1 finding probe: can a process tree still be reached from the pid of a process
// that has already exited?
//
// child.mjs (spawned detached, group leader) spawns grandchild.mjs NOT detached -- the
// same way a shell backgrounds a job with `&` without an explicit setsid, which is what
// a tool call like `npm run dev &` produces under the real CLI. It loops writing a
// heartbeat file every 100ms. The parent waits for child.mjs to exit on its own (it
// exits immediately after spawning the grandchild), then issues the platform kill
// against the recorded pid/pgid, waits, and reports whether the grandchild's heartbeat
// has stopped (i.e., it died) or kept going (it survived).
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';
const dir = mkdtempSync(join(tmpdir(), 's28-probe-'));
const heartbeat = join(dir, 'heartbeat.txt');

const grandchildScript = join(dir, 'grandchild.mjs');
writeFileSync(
  grandchildScript,
  `
import { writeFileSync } from 'node:fs';
let i = 0;
setInterval(() => { writeFileSync(${JSON.stringify(heartbeat)}, String(i++)); }, 100);
`,
);

const childScript = join(dir, 'child.mjs');
writeFileSync(
  childScript,
  `
import { spawn } from 'node:child_process';
// NOT detached: this mimics a shell '&' background job, which stays in the
// spawning process's process group unless it explicitly calls setsid() itself.
const gc = spawn(process.execPath, [${JSON.stringify(grandchildScript)}], {
  detached: false,
  stdio: 'ignore',
});
gc.unref();
// report grandchild pid on stdout, then exit immediately -- the parent process (this
// script) is gone well before the probe issues its kill.
console.log('GRANDCHILD_PID=' + gc.pid);
process.exit(0);
`,
);

console.log(`platform=${process.platform} release=${process.env.PROBE_OS_LABEL ?? ''}`);
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

// Give the grandchild a moment to write its first heartbeat.
await new Promise((r) => setTimeout(r, 300));
const before = existsSync(heartbeat) ? readFileSync(heartbeat, 'utf8') : null;
console.log(`heartbeat before kill: ${before}`);

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
await new Promise((r) => setTimeout(r, 500));
const after2 = existsSync(heartbeat) ? readFileSync(heartbeat, 'utf8') : null;

console.log(`heartbeat immediately after kill: ${after1}`);
console.log(`heartbeat 500ms later: ${after2}`);
const stillAdvancing = after1 !== null && after2 !== null && after1 !== after2;
console.log(`RESULT: grandchild ${stillAdvancing ? 'SURVIVED (tree reachable/kill FAILED)' : 'DIED (tree reachable/kill SUCCEEDED)'}`);

try { unlinkSync(heartbeat); } catch {}
