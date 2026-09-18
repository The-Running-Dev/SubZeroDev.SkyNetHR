// Cross-platform Chromium-family browser discovery, Node builtins only. No precedent existed
// in this repo before D245 — `pass.js` is the only caller, and needs one absolute path to an
// executable it can launch headless with a remote-debugging port.
//
// S19: a check that cannot run fails by name rather than skipping. `findBrowser` throws with
// every path and command it tried, so a CI log without a browser says exactly why the pass
// did not run instead of silently reporting zero surfaces covered.
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { platform } from 'node:process';

const ENV_VAR = 'CHROME_PATH';

const WINDOWS_CANDIDATES = [
  '%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe',
  '%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe',
  '%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe',
  '%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe',
  '%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe',
];

const LINUX_CANDIDATES = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/snap/bin/chromium',
];

const WINDOWS_LOOKUP_NAMES = ['chrome.exe', 'msedge.exe'];
const LINUX_LOOKUP_NAMES = ['google-chrome-stable', 'google-chrome', 'chromium-browser', 'chromium'];

function expandWindowsEnvVars(path) {
  return path.replace(/%([^%]+)%/g, (match, name) => process.env[name] ?? match);
}

function lookupOnPath(command, names) {
  for (const name of names) {
    try {
      const output = execFileSync(command, [name], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString('utf8')
        .trim();
      const first = output.split(/\r?\n/)[0]?.trim();
      if (first) return first;
    } catch {
      // Not found via this lookup — try the next name.
    }
  }
  return null;
}

/**
 * Returns an absolute path to a Chromium-family executable. Throws, naming every location
 * tried, when none is found — never returns null and never skips.
 */
export function findBrowser() {
  const tried = [];

  const fromEnv = process.env[ENV_VAR];
  if (fromEnv) {
    tried.push(`${ENV_VAR}=${fromEnv}`);
    if (existsSync(fromEnv)) return fromEnv;
  }

  const isWindows = platform === 'win32';
  const candidates = isWindows ? WINDOWS_CANDIDATES : LINUX_CANDIDATES;
  for (const raw of candidates) {
    const resolved = isWindows ? expandWindowsEnvVars(raw) : raw;
    tried.push(resolved);
    if (existsSync(resolved)) return resolved;
  }

  const lookupCommand = isWindows ? 'where' : 'which';
  const lookupNames = isWindows ? WINDOWS_LOOKUP_NAMES : LINUX_LOOKUP_NAMES;
  tried.push(`${lookupCommand} ${lookupNames.join('/')}`);
  const found = lookupOnPath(lookupCommand, lookupNames);
  if (found) return found;

  throw new Error(
    `no Chromium-family browser found for S18.5's browser pass. Tried:\n${tried.map((t) => `  - ${t}`).join('\n')}\n` +
      `Set ${ENV_VAR} to an absolute path, or install Chrome/Chromium/Edge.`,
  );
}
