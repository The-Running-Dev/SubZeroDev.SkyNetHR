// One-line, safe-to-show-collapsed rendering of a Codex command execution. Server-side
// for the same reason as Claude's (`../claude/summarise.ts`, #23) — the vendor boundary
// keeps tool-shape knowledge out of the session manager.
export function summariseCommand(command: string): string {
  return command.split('\n')[0]!.slice(0, 200);
}
