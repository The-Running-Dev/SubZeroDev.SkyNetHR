// One-line, safe-to-show-collapsed rendering of a tool call. Server-side so the client
// stays vendor-blind (`ToolCall.summary`; open question 4, #23 — unowned long-term, but
// something has to render it today and the vendor boundary says it isn't the manager).
export function summariseToolCall(name: string, input: Readonly<Record<string, unknown>>): string {
  if (name === 'Bash' && typeof input['command'] === 'string') {
    return String(input['command']).split('\n')[0]!.slice(0, 200);
  }
  for (const key of ['file_path', 'path', 'pattern', 'url', 'query']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return `${name}: ${value.slice(0, 200)}`;
  }
  return name;
}
