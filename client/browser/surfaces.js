// D245/S18.5's surface enumeration: "a themeable surface is each top-level panel and each
// in-console fold." Sourced from `client/index.html` — four top-level `.panel` sections
// (each shown/hidden via its own `hidden` attribute, never nested inside `#console`) and
// seven folds inside `#console .transcript-pane` (six toggled the same way, plus `#transcript`
// itself, which carries no `hidden` attribute and is always present).
export const SURFACES = [
  { id: 'requisitions', kind: 'panel', hasHiddenToggle: true },
  { id: 'audit', kind: 'panel', hasHiddenToggle: true },
  { id: 'terminate', kind: 'panel', hasHiddenToggle: true },
  { id: 'login', kind: 'panel', hasHiddenToggle: true },
  { id: 'policy-banner', kind: 'fold', hasHiddenToggle: true },
  { id: 'transcript', kind: 'fold', hasHiddenToggle: false },
  { id: 'checkpoints', kind: 'fold', hasHiddenToggle: true },
  { id: 'checklist', kind: 'fold', hasHiddenToggle: true },
  { id: 'payroll', kind: 'fold', hasHiddenToggle: true },
  { id: 'reviews', kind: 'fold', hasHiddenToggle: true },
  { id: 'compose', kind: 'fold', hasHiddenToggle: true },
];

export const THEMES = ['A', 'B', 'C', 'D'];
