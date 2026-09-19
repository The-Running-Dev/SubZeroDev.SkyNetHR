// Harness-only bridge: capture the real CLI wire without changing the adapter.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const options = JSON.parse(readFileSync(process.env.SKYNET_PROBE_416_OPTIONS, 'utf8'));
const log = (file, value) => appendFileSync(file, JSON.stringify(value) + '\n');
if (process.argv[2] === '--hook') {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const output = { hookSpecificOutput: { hookEventName: 'PreToolUse' } };
  const specific = output.hookSpecificOutput;
  if (options.mode === 'deny') {
    specific.permissionDecision = 'deny';
    specific.permissionDecisionReason = 'PROBE_DENIAL_ONLY';
  } else {
    specific.permissionDecision = 'allow';
    if (options.mode === 'candidate') specific.updatedToolOutput = 'PROBE_SUBSTITUTE_RESULT';
    if (options.mode === 'rewrite') specific.updatedInput = { file_path: options.cachedFile };
  }
  log(options.hookLog, { input, output });
  console.log(JSON.stringify(output));
} else {
  const version = process.argv.includes('--version');
  const args = process.argv.slice(2);
  if (!version) {
    args.push('--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}');
    if (options.mode === 'automatic') args.push('--permission-mode', 'acceptEdits');
    if (['allow', 'candidate', 'deny', 'rewrite'].includes(options.mode)) {
      // Shell form also works on the older CLI used by the S26 finding.
      const command = `"${process.execPath}" "${fileURLToPath(import.meta.url)}" --hook`;
      args.push('--settings', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Read', hooks: [{ type: 'command', command }] }] } }));
    }
  }
  const child = spawn(options.cli, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  const capture = (stream, direction, destination) => {
    let buffer = '';
    stream.on('data', chunk => {
      destination.write(chunk);
      if (version) return;
      buffer += chunk.toString();
      for (let newline; (newline = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try { log(options.wireLog, { direction, record: JSON.parse(line) }); }
        catch { log(options.wireLog, { direction, text: line }); }
      }
    });
  };
  capture(process.stdin, 'stdin', child.stdin);
  capture(child.stdout, 'stdout', process.stdout);
  child.stderr.on('data', chunk => { appendFileSync(options.stderrLog, chunk); process.stderr.write(chunk); });
  child.stdin.on('error', () => {});
  process.stdin.on('end', () => child.stdin.end());
  child.on('close', code => process.exit(code ?? 1));
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
}
