// D245/S18.5's surface enumeration: "a themeable surface is each top-level panel and each
// in-console fold." Sourced from `client/index.html` — eight top-level `.panel` sections
// (each shown/hidden via its own `hidden` attribute, never nested inside `#console`; D246
// moved checkpoints/checklist/payroll/reviews from transcript-pane folds into this group as
// `.panel--audit` overlays) and three folds inside `#console .transcript-pane` (policy-banner
// and compose toggled via `hidden`, plus `#transcript` itself, which carries no `hidden`
// attribute and is always present).
export const SURFACES = [
  { id: 'requisitions', kind: 'panel', hasHiddenToggle: true },
  { id: 'audit', kind: 'panel', hasHiddenToggle: true },
  { id: 'terminate', kind: 'panel', hasHiddenToggle: true },
  { id: 'login', kind: 'panel', hasHiddenToggle: true },
  { id: 'checkpoints', kind: 'panel', hasHiddenToggle: true },
  { id: 'checklist', kind: 'panel', hasHiddenToggle: true },
  { id: 'payroll', kind: 'panel', hasHiddenToggle: true },
  { id: 'reviews', kind: 'panel', hasHiddenToggle: true },
  { id: 'policy-banner', kind: 'fold', hasHiddenToggle: true },
  { id: 'transcript', kind: 'fold', hasHiddenToggle: false },
  { id: 'compose', kind: 'fold', hasHiddenToggle: true },
];

export const THEMES = ['A', 'B', 'C', 'D'];
