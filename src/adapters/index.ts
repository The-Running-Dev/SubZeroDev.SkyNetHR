import type { Adapter, AdapterError, AdapterOptions, Result, Vendor } from '../contract/index.js';
import { createClaudeAdapter } from './claude/index.js';

export function createAdapter(vendor: Vendor, opts: AdapterOptions): Result<Adapter, AdapterError> {
  switch (vendor) {
    case 'claude':
      return { ok: true, value: createClaudeAdapter(opts) };
    case 'codex':
      // S8.1 is the experiment that earns this adapter; it may not be guessed at.
      return { ok: false, error: { code: 'unsupported_vendor', vendor } };
    default:
      return { ok: false, error: { code: 'unsupported_vendor', vendor: String(vendor) } };
  }
}
