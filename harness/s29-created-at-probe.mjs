// Temporary measurement for S29.1 (design/30-slices.md § S29). Not part of the shipped tree.
// Spawns a long-lived child, reads this platform's own process-creation-time twice for the
// same live pid, and reports whether the two reads are byte-identical.

import { spawn, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';

async function linuxClkTck() {
  const { stdout } = await execFileAsync('getconf', ['CLK_TCK']);
  return Number(stdout.trim());
}

async function linuxBtime() {
  const stat = await readFile('/proc/stat', 'utf8');
  const line = stat.split('\n').find((l) => l.startsWith('btime '));
  return Number(line.split(/\s+/)[1]);
}

async function linuxCreatedAt(pid, clkTck, btime) {
  const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
  // comm is the parenthesised field and may itself contain spaces/parens; split on the
  // last ')' to get past it reliably, per `man proc`.
  const afterComm = raw.slice(raw.lastIndexOf(')') + 2);
  const fields = afterComm.split(' ');
  // fields[0] is state (field 3); starttime is field 22, i.e. index 22 - 3 = 19 here.
  const startTicks = Number(fields[19]);
  const epochMs = (btime + startTicks / clkTck) * 1000;
  return new Date(epochMs).toISOString();
}

async function windowsCreatedAt(pid) {
  const { stdout } = await execFileAsync('powershell', [
    '-NoProfile',
    '-Command',
    `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
  ]);
  return stdout.trim();
}

async function main() {
  const child = isWindows
    ? spawn('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 5'])
    : spawn('sleep', ['5']);
  await new Promise((resolve) => setTimeout(resolve, 300));

  let clkTck, btime;
  if (!isWindows) {
    [clkTck, btime] = await Promise.all([linuxClkTck(), linuxBtime()]);
  }

  const read = () => (isWindows ? windowsCreatedAt(child.pid) : linuxCreatedAt(child.pid, clkTck, btime));

  const first = await read();
  await new Promise((resolve) => setTimeout(resolve, 250));
  const second = await read();

  const result = {
    platform: process.platform,
    release: os.release(),
    nodeVersion: process.version,
    pid: child.pid,
    first,
    second,
    identical: first === second,
  };
  console.log(JSON.stringify(result, null, 2));

  child.kill();
}

main().catch((err) => {
  console.error('S29.1 probe failed:', err);
  process.exit(1);
});
