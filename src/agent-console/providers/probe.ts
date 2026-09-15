import { spawn } from 'node:child_process';

export interface ProbeResult { readonly ok: boolean; readonly output: string }

// Short help/version probes drain both pipes. Their timeout does not block other sessions.
export function probeCommand(command: string, args: readonly string[], cwd: string, shell: boolean, timeoutMs = 2000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, output: output.trim() });
    };
    try {
      const child = spawn(command, [...args], { cwd, shell, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } });
      child.stdout.on('data', (chunk: Buffer) => { if (output.length < 4096) output += chunk.toString('utf8').slice(0, 4096 - output.length); });
      child.stderr.resume();
      child.once('error', () => finish(false));
      child.once('close', (code) => finish(code === 0));
      timer = setTimeout(() => {
        if (child.pid !== undefined) {
          if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).once('error', () => {});
          else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
        }
        finish(false);
      }, timeoutMs);
    } catch { finish(false); }
  });
}
