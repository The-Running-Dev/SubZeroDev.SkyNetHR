# Codex file-change probe

Captured on Windows, 2026-10-04, with installed `codex-cli 0.158.0` using
`codex app-server` and `approvalPolicy: never`.

An edit-only prompt against a temporary repository was run under each sandbox:

| Sandbox | Observed result |
| --- | --- |
| `read-only` | File unchanged; no `fileChange` item |
| `workspace-write` | File edited; `fileChange` started and completed |
| `danger-full-access` | File edited; `fileChange` started and completed |

A further `workspace-write` turn added, deleted, and updated a file in one patch.
`file-change-probe.json` contains its started/completed notifications with paths
reduced to basenames and thread, turn, and item identifiers replaced. Both
notifications carried all three changes. Add/delete diffs contained the full file
text; update diffs contained unified hunks without file headers.

None of these four turns emitted `item/fileChange/patchUpdated`. Its separate test
fixture follows the installed CLI's generated
`v2/FileChangePatchUpdatedNotification.json` schema and is synthetic. It must not
be described as a captured notification.
