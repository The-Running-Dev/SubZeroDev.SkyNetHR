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
    // Declared names are folded the same way every other name here is: Windows environment
    // names are case-insensitive, so a provider declaring `PROVIDER_CONFIG` against a host
    // holding `Provider_Config` must retain it, exactly as `Path` and `http_proxy` are.
    const providerNames = new Set((options.providerNames ?? []).map((name) => name.toUpperCase()));
    base = Object.fromEntries(Object.entries(source).filter(([name]) => {
      // Preserve original spelling/values, including Windows Path and lowercase proxies.
      const upper = name.toUpperCase();
      return BASE_NAMES.has(upper) || upper.startsWith('PROGRAMFILES') ||
        upper.startsWith('XDG_') || upper.startsWith('LC_') || providerNames.has(upper);
    }));
  }
  return { ...base, ...options.host, ...options.overrides };
}
