// This module deliberately has no static imports. Imported providers may log at load.
for (const level of ['log', 'info', 'debug', 'warn', 'error'] as const) {
  console[level] = (...values: unknown[]) => {
    const message = values.map(value => typeof value === 'string' ? value : String(value)).join(' ');
    process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, message }) + '\n');
  };
}

export async function main() {
  const { runRuntime } = await import('./server.js');
  await runRuntime(process.stdin, process.stdout, { onExit: reason => process.exit(reason === 'stdin_eof' ? 0 : 1) }).closed;
}
const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => { console.error(error); process.exitCode = 1; });
}
