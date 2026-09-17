import { spawnProcess, killProbe } from '../process/index.js';

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
      const child = spawnProcess({ command, args: [...args], shell }, { cwd, stdin: 'ignore', overrides: { FORCE_COLOR: '0', NO_COLOR: '1' } });
      child.stdout!.on('data', (chunk: Buffer) => { if (output.length < 4096) output += chunk.toString('utf8').slice(0, 4096 - output.length); });
      child.stderr!.resume();
      child.once('error', () => finish(false));
      child.once('close', (code) => finish(code === 0));
      timer = setTimeout(() => {
        killProbe(child);
        finish(false);
      }, timeoutMs);
    } catch { finish(false); }
  });
}
