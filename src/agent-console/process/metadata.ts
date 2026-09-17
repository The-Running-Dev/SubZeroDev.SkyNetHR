import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { IsoTimestamp } from '../contract/index.js';

const execFileAsync = promisify(execFile);

// The CLK_TCK cache retains its previous per-manager lifetime.
export function createProcessMetadata() {
  const isWindows = process.platform === 'win32';
  const isDarwin = process.platform === 'darwin';
  // The OS-reported image name for a live pid, or `null` when nothing is running there
  // (already exited, or never existed). Windows has no `/proc`; neither does macOS —
  // both read the live process table instead, each with the tool the platform gives.
  async function getProcessImage(pid: number): Promise<string | null> {
    if (isWindows) {
      try {
        const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
        const firstLine = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
        if (!firstLine) return null;
        const match = /^"([^"]*)"/.exec(firstLine);
        return match ? match[1]! : null;
      } catch {
        return null;
      }
    }
    if (isDarwin) {
      try {
        // `comm=` reports the full invoked path on macOS (unlike Linux's `/proc/pid/comm`,
        // which is always the bare name); `ucomm=` is the field that stays a bare name here.
        const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'ucomm=']);
        const line = stdout.trim();
        return line.length > 0 ? line : null;
      } catch {
        return null;
      }
    }
    try {
      const comm = await readFile(`/proc/${pid}/comm`, 'utf8');
      return comm.trim();
    } catch {
      return null;
    }
  }

  function imagesMatch(recorded: string, actual: string): boolean {
    const strip = (s: string) => s.replace(/\.exe$/i, '');
    return isWindows ? strip(recorded).toLowerCase() === strip(actual).toLowerCase() : strip(recorded) === strip(actual);
  }

  // S29.1 (`design/findings/S29-created-at-stability.md`): both supported platforms give
  // a reading that is byte-identical across two reads of the same live process, so exact
  // equality (I19's fourth limb) is safe. Linux computes wall-clock creation time from
  // `/proc/[pid]/stat`'s `starttime` (ticks since boot) plus `/proc/stat`'s `btime`
  // (seconds since the epoch) — both read fresh, never cached, so a reading taken now and
  // one taken at reap time are the same computation over the same immutable inputs.
  // Windows reads `Get-Process`'s own `StartTime`. Neither macOS nor any other platform is
  // measured; `getOsCreatedAt` returns `null` there; S29.7 makes that indistinguishable
  // from any other capture failure.
  let linuxClkTck: number | null = null;
  async function realGetOsCreatedAt(pid: number): Promise<IsoTimestamp | null> {
    if (isWindows) {
      try {
        const { stdout } = await execFileAsync('powershell', [
          '-NoProfile',
          '-Command',
          `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`,
        ]);
        const line = stdout.trim();
        return line.length > 0 ? (line as IsoTimestamp) : null;
      } catch {
        return null;
      }
    }
    if (isDarwin) return null;
    try {
      if (linuxClkTck === null) {
        const { stdout } = await execFileAsync('getconf', ['CLK_TCK']);
        linuxClkTck = Number(stdout.trim());
      }
      const stat = await readFile('/proc/stat', 'utf8');
      const btimeLine = stat.split('\n').find((l) => l.startsWith('btime '));
      if (!btimeLine) return null;
      const btime = Number(btimeLine.split(/\s+/)[1]);
      const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
      // `comm` (the parenthesised field) may itself contain spaces or parens; split past
      // the last `)` to reach the fixed-width fields reliably, per `man proc`.
      const afterComm = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
      const startTicks = Number(afterComm[19]); // field 22; index 22 - 3, past state/ppid/pgrp... counted from field 3
      if (!Number.isFinite(btime) || !Number.isFinite(startTicks) || !linuxClkTck) return null;
      return new Date((btime + startTicks / linuxClkTck) * 1000).toISOString() as IsoTimestamp;
    } catch {
      return null;
    }
  }

  return { getProcessImage, imagesMatch, getOsCreatedAt: realGetOsCreatedAt };
}
