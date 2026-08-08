# Spike

Proof that the transport, the SSE replay and the permission handshake work end to end.
Zero dependencies, no build step.

```bash
cd spike
WORKSPACE_ROOTS=/path/to/a/repo node server.mjs
```

PowerShell:

```powershell
$env:WORKSPACE_ROOTS = 'D:\Dropbox\Projects\Some.Repo'; node server.mjs
```

Then open <http://127.0.0.1:8787>, put a path inside that root in the box, and start a
session. Ask it to read a file and you should see `tool.call`, a permission prompt, your
decision going back to the CLI, and `tool.result`.

Run the one test that matters:

```bash
node --test
```

Four tests, all passing on Node 25.3. Pass no path — `node --test test/` tries to resolve
`test` as a module on Node 25 and fails.

## Configuration

| Variable | Meaning |
|---|---|
| `WORKSPACE_ROOTS` | Path-separator-delimited roots. A session `cwd` must resolve inside one |
| `HOST` / `PORT` | Default `127.0.0.1:8787` |
| `CONSOLE_SECRET` | Shared-secret mode; set cookie `console_secret=<value>` |
| `CONSOLE_TRUST_HEADER` | Trusted identity header, e.g. `x-user-id` for Open WebUI |
| `CONSOLE_TRUSTED_PEERS` | Comma-separated upstream addresses allowed to set that header |
| `CONSOLE_DEBUG_RAW` | Include the vendor payload in envelopes |
| `CONSOLE_STORAGE` | Defaults to `spike/.data` |

The server **refuses to start** on a non-loopback interface with no auth configured. That
is deliberate and is criterion S3.4 — do not relax it to get something working.

## What this proves

- The stream-json transport, with stdin held open for the turn (S1.1)
- The NDJSON splitter, tested byte-by-byte including a mid-character UTF-8 split (S1.2)
- Claude event mapping to the normalised envelope (S1.3)
- Server-assigned `seq` and SSE replay via `Last-Event-ID` (S2.1, S3.1–S3.3)
- The workspace jail on a resolved real path (S2.2, S2.3)
- The permission handshake both ways, including cancellation on child death (S4.1–S4.5)
- Fail-closed startup (S3.4)

## What this is not

**Not the implementation.** It is throwaway proof that the risky parts are not risky. The
real build follows `design/30-slices.md` in TypeScript, and should reuse the *shape* of
`lib/ndjson.mjs` and `lib/claude-adapter.mjs` rather than these files.

Deliberately absent, each with its slice:

- Codex — the adapter is an experiment that has not been run (S8). `vendor: 'codex'` is
  rejected outright rather than stubbed, so nothing can appear to work when it does not.
- Checkpoints (S6), the audit log (S7), event caps and disk-backed replay (S9).
- Real auth. Shared-secret-in-a-cookie is enough to exercise the identity plumbing and is
  not a login system (D3).
- Persistence across restart. Sessions are in memory; `events.ndjson` is written but never
  read back.
- `permission.scope: 'always'` is accepted and logged but does not yet pass the vendor's
  suggestion back — that is an open question, not an oversight (`90-decisions.md § Open`).
- Token-level streaming. `--include-partial-messages` is untested; `message.delta` exists
  in the contract and is never emitted.
