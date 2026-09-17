export interface EnvironmentOptions {
  // Phase 3 compatibility default. A later release may select constructed explicitly.
  readonly mode?: 'inherit' | 'constructed';
  readonly source?: NodeJS.ProcessEnv;
  readonly providerNames?: readonly string[];
  readonly host?: NodeJS.ProcessEnv;
  readonly overrides?: NodeJS.ProcessEnv;
}

const BASE_NAMES = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'USERNAME', 'LANG',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE', 'SSL_CERT_DIR',
]);

export function buildEnvironment(options: EnvironmentOptions = {}): NodeJS.ProcessEnv {
  const source = options.source ?? process.env;
  let base: NodeJS.ProcessEnv;
  if ((options.mode ?? 'inherit') === 'inherit') {
    base = { ...source };
  } else {
    const providerNames = new Set(options.providerNames ?? []);
    base = Object.fromEntries(Object.entries(source).filter(([name]) => {
      // Preserve original spelling/values, including Windows Path and lowercase proxies.
      const upper = name.toUpperCase();
      return BASE_NAMES.has(upper) || upper.startsWith('PROGRAMFILES') ||
        upper.startsWith('XDG_') || upper.startsWith('LC_') || providerNames.has(name);
    }));
  }
  return { ...base, ...options.host, ...options.overrides };
}
