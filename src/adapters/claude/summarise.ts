// `Bash`'s command lives in this field on the wire — the one fact this summary and
// `matchTarget`'s projection table (D109, `src/adapters/claude/index.ts`) both need, so
// they share it rather than each hardcoding 'command' independently.
export const BASH_COMMAND_FIELD = 'command';

// One-line, safe-to-show-collapsed rendering of a tool call. Server-side so the client
// stays vendor-blind (`ToolCall.summary`; open question 4, #23 — unowned long-term, but
// something has to render it today and the vendor boundary says it isn't the manager).
export function summariseToolCall(name: string, input: Readonly<Record<string, unknown>>): string {
  if (name === 'Bash' && typeof input[BASH_COMMAND_FIELD] === 'string') {
    return String(input[BASH_COMMAND_FIELD]).split('\n')[0]!.slice(0, 200);
  }
  for (const key of ['file_path', 'path', 'pattern', 'url', 'query']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return `${name}: ${value.slice(0, 200)}`;
  }
  return name;
}
