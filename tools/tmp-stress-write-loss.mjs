import { spawn } from 'node:child_process';

const fixture = process.argv[2];
const trials = Number(process.argv[3] || 50);

async function oneTrial() {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [fixture], {
      env: { ...process.env, SKYNET_TEST_SCENARIO: 'die-with-pending' },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    proc.stdout.on('data', (c) => { out += c.toString('utf8'); });
    proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }) + '\n');
    proc.on('close', () => {
      const controlRequests = (out.match(/"type":"control_request"/g) || []).length;
      resolve(controlRequests);
    });
  });
}

let lossCount = 0;
const counts = {};
for (let i = 0; i < trials; i++) {
  const n = await oneTrial();
  counts[n] = (counts[n] || 0) + 1;
  if (n !== 2) lossCount++;
}
console.log(`trials=${trials} lossCount=${lossCount} distribution=${JSON.stringify(counts)}`);
process.exit(0);
