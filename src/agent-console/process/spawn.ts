import { spawn, type ChildProcess } from 'node:child_process';
import { buildEnvironment, type EnvironmentOptions } from './environment.js';

export interface ResolvedSpawn {
  readonly command: string;
  readonly args: readonly string[];
  readonly shell: boolean;
}

// The caller identifies its bare CLI name; provider command/transport selection stays there.
export function resolveSpawn(executable: string, args: readonly string[], shellForBareName: boolean,
  platform: NodeJS.Platform = process.platform): ResolvedSpawn {
  const script = executable.endsWith('.mjs') || executable.endsWith('.js');
  const shell = platform === 'win32' && !script && (shellForBareName || /\.(cmd|bat)$/i.test(executable));
  const command = script ? process.execPath : shell && /\s/.test(executable) ? `"${executable}"` : executable;
  return { command, args: script ? [executable, ...args] : args, shell };
}

// #201: a shell-backed child's pid names ComSpec, not the CLI it launches. Keep the
// original executable image for direct/fixture spawns, including the test seam.
export function reportableImage(executable: string, usedShell: boolean): string {
  if (!usedShell) return executable;
  const comspec = process.env['ComSpec'] ?? process.env['COMSPEC'] ?? 'cmd.exe';
  return comspec.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');
}

// Return Node's child/streams directly: callbacks run synchronously in their existing
// registration order. Providers own close identity guards, protocol parsing and outcomes.
export function spawnProcess(resolved: ResolvedSpawn, options: EnvironmentOptions & {
  readonly cwd: string;
  readonly stdin?: 'pipe' | 'ignore';
}): ChildProcess {
  return spawn(resolved.command, [...resolved.args], {
    cwd: options.cwd,
    stdio: [options.stdin ?? 'pipe', 'pipe', 'pipe'],
    shell: resolved.shell,
    detached: process.platform !== 'win32',
    env: buildEnvironment(options),
  });
}

export function protectStdin(child: ChildProcess): void {
  child.stdin?.on('error', () => {});
}

export function closeStdin(child: ChildProcess, data?: string): void {
  child.stdin?.end(data);
}
