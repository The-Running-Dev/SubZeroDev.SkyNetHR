import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

const KILL_GRACE_MS = 2000;

// Injectable OS calls permit both platform branches to be checked without killing test runners.
// These three entry points deliberately preserve different completion and fallback rules.
export function createTermination(operations: {
  readonly platform?: NodeJS.Platform;
  readonly spawn?: typeof nodeSpawn;
  readonly signal?: typeof process.kill;
  readonly schedule?: typeof setTimeout;
} = {}) {
  const isWindows = (operations.platform ?? process.platform) === 'win32';
  const spawn = operations.spawn ?? nodeSpawn;
  const signal = operations.signal ?? ((pid, signal) => process.kill(pid, signal));
  const schedule = operations.schedule ?? setTimeout;
  function terminate(proc: ChildProcess, owns: (proc: ChildProcess) => boolean): void {
    if (proc.pid === undefined) return;
    if (isWindows) {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F']).once('error', () => {});
      return;
    }
    const pid = proc.pid;
    try {
      signal(-pid, 'SIGTERM');
    } catch {
      try {
        proc.kill('SIGTERM');
      } catch {
        // Already gone.
      }
    }
    schedule(() => {
      if (!owns(proc)) return; // already exited; 'close' cleared it
      try {
        signal(-pid, 'SIGKILL');
      } catch {
        try {
          proc.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }
    }, KILL_GRACE_MS).unref();
  }

  // D38: the tree, not the recorded pid — `taskkill /T /F` walks the live process table
  // on Windows; on POSIX the recorded pid is the process-group leader (`detached: true`
  // at spawn), so signalling the negated pid reaches everything it later spawned.
  async function killProcessTree(pid: number, pgid: number | null): Promise<void> {
    if (isWindows) {
      await new Promise<void>((resolve) => {
        const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F']);
        p.once('error', (err) => {
          console.warn(`[session-manager] boot: taskkill /PID ${pid} /T /F failed to start: ${err.message}; the process may still be running`);
          resolve();
        });
        p.once('exit', (code) => {
          if (code !== 0) {
            console.warn(`[session-manager] boot: taskkill /PID ${pid} /T /F exited with code ${code}; the process may still be running`);
          }
          resolve();
        });
      });
      return;
    }
    try {
      signal(-(pgid ?? pid), 'SIGKILL');
    } catch {
      // Already gone — nothing left to kill.
    }
  }

  // Help/version probes have always force-killed immediately on timeout.
  function killProbe(child: ChildProcess): void {
    if (child.pid !== undefined) {
      if (isWindows) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).once('error', () => {});
      else { try { signal(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    }
  }

  return { terminate, killProcessTree, killProbe };
}
