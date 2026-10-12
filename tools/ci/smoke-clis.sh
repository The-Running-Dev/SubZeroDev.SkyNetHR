#!/bin/sh
# Runs inside the smoke-tested image (container.yml's `smoke-exec`), after the server answers.
#
# #198: answering on :3000 only proves the server binds; it says nothing about whether the other
# half of the two-vendor contract (src/adapters/index.ts's `VENDORS`) is reachable in the
# published artifact. Both CLIs answer `--version` / `exec --help` with no credential mounted
# (what the Codex adapter's own transport probe, `probeOk` in src/adapters/codex/index.ts,
# relies on), so this proves the executable is on PATH and responsive without a real credential.
set -eu

codex --version
codex exec --help > /dev/null
