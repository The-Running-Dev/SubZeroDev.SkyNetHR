import type { Adapter, AdapterError, AdapterOptions, Result, Vendor } from '../contract/index.js';
import { createClaudeAdapter } from './claude/index.js';
import { createCodexAdapter } from './codex/index.js';

export function createAdapter(vendor: Vendor, opts: AdapterOptions): Result<Adapter, AdapterError> {
  switch (vendor) {
    case 'claude':
      // Sandbox validation is the adapter's (20-contract.md § Adapter), and Claude has
      // no sandbox mechanism at all (D28) — every non-null request is unsupported.
      if (opts.sandbox !== null) {
        return { ok: false, error: { code: 'unsupported_sandbox', sandbox: opts.sandbox } };
      }
      return { ok: true, value: createClaudeAdapter(opts) };
    case 'codex':
      // Symmetric with Claude's guard above: every Codex session launches under an
      // explicit `sandbox_mode` (10-design.md § The hard problem), so "no sandbox" is
      // exactly the one thing this vendor does not offer.
      if (opts.sandbox === null) {
        return { ok: false, error: { code: 'unsupported_sandbox', sandbox: 'null' } };
      }
      return createCodexAdapter(opts);
    default:
      return { ok: false, error: { code: 'unsupported_vendor', vendor: String(vendor) } };
  }
}
