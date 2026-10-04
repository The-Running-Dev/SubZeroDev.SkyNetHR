import type { ToolResultDiff, ToolResultDiffHunk } from '../../contract/index.js';

export interface FileChange {
  path: string;
  kind: { type: 'add' | 'delete' | 'update'; move_path?: string | null };
  diff: string;
}

export function isFileChanges(value: unknown): value is FileChange[] {
  return Array.isArray(value) && value.every(change => {
    if (change === null || typeof change !== 'object') return false;
    const kind = change.kind;
    return typeof change.path === 'string' && typeof change.diff === 'string'
      && kind !== null && typeof kind === 'object'
      && ['add', 'delete', 'update'].includes(kind.type)
      && (kind.move_path === undefined || kind.move_path === null || typeof kind.move_path === 'string');
  });
}

export function fileChangeHunks(change: FileChange): ToolResultDiffHunk[] | null {
  if (change.kind.type === 'update') return parseUnifiedDiff(change.diff);
  const lines = change.diff === '' ? [] : change.diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const added = change.kind.type === 'add';
  return [{
    oldStart: added || lines.length === 0 ? 0 : 1, oldLines: added ? 0 : lines.length,
    newStart: !added || lines.length === 0 ? 0 : 1, newLines: added ? lines.length : 0,
    lines: lines.map(line => (added ? '+' : '-') + line),
  }];
}

export function fileChangeOutput(changes: readonly FileChange[]): string {
  return changes.map(change => `${change.kind.type}: ${change.path}${change.kind.move_path ? ` -> ${change.kind.move_path}` : ''}\n${change.diff}`).join('\n');
}

export function fileChangesDiff(changes: readonly FileChange[]): ToolResultDiff | null {
  if (changes.length === 0) return null;
  const hunks: ToolResultDiffHunk[] = [];
  for (const change of changes) {
    const parsed = fileChangeHunks(change);
    if (parsed === null) return null; // Keep the whole output visible if any file cannot be parsed.
    const path = change.kind.move_path ? `${change.path} → ${change.kind.move_path}` : change.path;
    hunks.push(...parsed.map(hunk => ({ ...hunk, path })));
  }
  return { hunks };
}

// Codex supplies per-file unified hunks without a file header. Reject incomplete
// or malformed patches rather than showing a plausible but inaccurate change.
export function parseUnifiedDiff(diff: string): ToolResultDiffHunk[] | null {
  const hunks: ToolResultDiffHunk[] = [];
  let current: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] } | null = null;
  let oldCount = 0, newCount = 0;
  const complete = () => current === null || (oldCount === current.oldLines && newCount === current.newLines);
  const lines = diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(line);
    if (header) {
      if (!complete()) return null;
      const [oldStart, oldLines, newStart, newLines] = [Number(header[1]), Number(header[2] ?? 1), Number(header[3]), Number(header[4] ?? 1)];
      if (![oldStart, oldLines, newStart, newLines].every(Number.isSafeInteger)) return null;
      current = { oldStart: oldStart!, oldLines: oldLines!, newStart: newStart!, newLines: newLines!, lines: [] };
      hunks.push(current);
      oldCount = 0; newCount = 0;
    } else if (line === '\\ No newline at end of file') {
      if (current === null || current.lines.length === 0) return null;
    } else if (current !== null && /^[ +\-]/.test(line)) {
      current.lines.push(line);
      if (line[0] !== '+') oldCount++;
      if (line[0] !== '-') newCount++;
      if (oldCount > current.oldLines || newCount > current.newLines) return null;
    } else {
      return null;
    }
  }
  return hunks.length > 0 && complete() ? hunks : null;
}
