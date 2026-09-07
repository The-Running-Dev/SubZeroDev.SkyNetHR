---
description: Per-repo overrides for /track
---

## document-map

`design/30-slices.md` keeps every landed slice's full body under `## Landed`, and `## Landed`
appears *before* `## Outstanding` — the reverse of `Update-SlicesDocument.ps1`'s assumption that
slices start under `## Outstanding` and retire to a bare index row under `## Landed` once their
issue closes. This is deliberate: other documents (`10-design.md`, `90-decisions.md`, other
slices) cite specific criterion ids like S1.6, S3.3, S7.5 by text, and a bare index would lose it
(`design/30-slices.md`'s own preamble to `## Landed`; decision D207, `design/90-decisions.md`,
issue #305).

**"Landed slices → retired" does not apply to this repository.** Do not run
`Update-SlicesDocument.ps1` here. Its `NoLandedSection` exit (2) against this document's shape is
the expected, permanent result — not a finding to report or a gap to fix. Slice retirement in
this repo remains a manual, no-op step.
