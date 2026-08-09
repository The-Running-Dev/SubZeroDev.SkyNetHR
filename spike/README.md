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
is deliberate and is criterion S2.8 — do not relax it to get something working.

## What this proves

- The stream-json transport, with stdin held open for the turn (S1.1)
- The NDJSON splitter, tested byte-by-byte including a mid-character UTF-8 split (S1.2)
- Claude event mapping to the normalised envelope (S1.3)
- Server-assigned `seq` (S1.5), the SSE stream shape (S2.3) and replay via `Last-Event-ID`
  (S3.1)
- The workspace jail on a resolved real path (S1.6, S1.7)
- The permission handshake both ways (S4.1–S4.5), including cancellation on child death
  (S4.9)
- Fail-closed startup (S2.8)

## What this is not

**Not the implementation.** It is throwaway proof that the risky parts are not risky. The
real build follows `design/30-slices.md` in TypeScript, and should reuse the *shape* of
`lib/ndjson.mjs` and `lib/claude-adapter.mjs` rather than these files.

Deliberately absent, each with its slice:

- Codex — the adapter is an experiment that has not been run (S8). `vendor: 'codex'` is
  rejected outright rather than stubbed, so nothing can appear to work when it does not.
- Checkpoints (S6), the audit log (S4), event caps and disk-backed replay (S9). Replay is
  ring-only, so a too-old `Last-Event-ID` reports a gap; D40 says it must be served from the
  spill instead.
- Real auth. Shared-secret-in-a-cookie is enough to exercise the identity plumbing and is
  not a login system (D3).
- Persistence across restart. Sessions are in memory; `events.ndjson` is written but never
  read back.
- `permission.scope: 'always'` is accepted and logged but holds no rule and matches nothing.
  The grammar it would need is undecided — `20-contract.md § Unresolved` 2, issues #16 and
  #37 — and D35 forbids the shortcut of handing the grant to the CLI.
- Token-level streaming. `--include-partial-messages` is untested; `message.delta` exists
  in the contract and is never emitted.

**And it diverges from the contract in ways nothing above covers.** Listed so a reader does
not mistake this for a partial implementation of `20-contract.md`. None of it is fixed here —
S1 and S2 rebuild this in TypeScript against the contract, and `spike/.data` is deleted
rather than migrated.

| Here | Contract |
|---|---|
| Emits `session.exit` | Retired by D45; the kind does not exist |
| `error` kinds `adapter_crash`, `agent_stderr`, `spawn_failed` | `ErrorEventKind` is closed (D44) and holds none of them |
| `turn.ended` carries the vendor's stop string and no `usage` | `TurnStopReason` is a six-token union; `usage` is required |
| No `turnId` on any turn-scoped payload | D44 puts one on every payload that belongs to a turn |
| `session.notice` has no `code`; `policy` has no `sandbox` or `banner` | Both fields are required |
| `usage` is emitted flat | `UsageEvent { turnId, usage }`, and the adapter must normalise it to a delta (D75) |
| The adapter emits `session.started`, and owns `pending` and `busy` | The manager owns turn state (D17); `AdapterEmitted` excludes `session.started` |
| One `emit` callback | A four-member `notify` union (D46) |
| `POST /api/sessions` answers `200` | `201` |
| No origin allow-list | Required on every mutating route and the WS handshake (D29, I24) |
| No workspace busy check | `409 workspace_busy` on overlap (D19, D30) |
| Delete interrupts a live turn and removes no files | `409 turn_in_flight`; delete removes storage and never `audit.ndjson` (D25) |
| Interrupt kills the pid and takes no `turnId` | Terminate-then-force on the tree (D38); `{turnId}` required (D24) |
| CSP allows `style-src 'unsafe-inline'` | Strict CSP, no `unsafe-inline` anywhere (D43, D78) |
| `meta.json` written in place, no `schemaVersion`, field `created` | Temp-file-then-atomic-rename, `schemaVersion: 1`, `createdAt` (D37, D49) |
| No `end` route | `POST /:id/end` (D36) |
