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

## document-map

`design/state-index.md` does not exist in this repository and never has
(`git log --all -- design/state-index.md` returns nothing), and `design/20-contract.md` carries no
`invariants` region. This repo adopted only the `WorkRef` mirror under `design/state/work/`, not
the fuller design-state apparatus `tools/Update-DesignProjection.ps1` projects into (decision D208,
`design/90-decisions.md`, issue #312).

**"Regenerate the projection in the same breath" does not apply to this repository.** Do not run
`Update-DesignProjection.ps1` here. Its exit 1 — seven `DocumentMissing`/`RegionMissing` refusals
for `units`, `bound-by`, `consumers`, `decision-affects`, `question-affects`, `outstanding` and
`invariants` — is the expected, permanent result against this layout, not a finding to report or a
gap to fix. There is no projection here, so nothing can go `ProjectionStale`.

**Stage only `design/state/work` when committing a mirror refresh.** The core command's staging
step names `design/state-index.md` alongside it; that path does not exist here and `git add` fails
on it. The mirror-refresh carve-out in `AGENTS.md`, *Git and delivery* is unaffected — it already
scopes to paths the refresh scripts actually wrote.
