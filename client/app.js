import { createIncidentGroupsBuilder, renderAuditRow, renderEvent, renderPayrollSummary, renderRequisitionRow, renderReviewRow, renderSummaryRow } from './render.js';

const $ = (id) => document.getElementById(id);

const state = {
  sessionId: null,
  stream: null,
  lastSeq: 0,
  refetched: false,
  // requestId -> { setResolved(text) }, so a permission.resolved envelope — including
  // one answered from a different client — can update the row without querying the DOM.
  pendingPermissions: new Map(),
  // id -> SessionSummary, from the last list. `state` on the summary is what decides
  // whether the compose box is offered (S7.2, D20): an ended session — rehydrated after a
  // restart, or closed by its operator — refuses every message with `409 session_ended`,
  // and a box that still invites typing turns that refusal into a surprise.
  sessionsById: new Map(),
  // S12: the opaque `nextCursor` from the last audit page fetched, round-tripped verbatim
  // — nothing here parses, decodes or constructs one (D86, S12.5).
  auditCursor: null,
  // S12: the filter values the current `auditCursor` was fetched under, pinned at reset
  // time (open / submit Filter) — "Load older" reuses these rather than re-reading the
  // filter inputs live, so an edited-but-unsubmitted filter cannot be silently combined
  // with a cursor minted under the old one.
  auditFilters: null,
  // S12: bumped on every `loadAuditPage` call so a slower, superseded response (a filter
  // reset that outruns an in-flight "Load older") can never overwrite state a newer call
  // already reset — mirrors `refreshCheckpoints`'s `requestedSessionId` guard.
  auditRequestToken: 0,
  // S17.5: total records loaded under the current filter, across every page fetched since
  // the last reset — both views need this count for the empty-state check, but only the
  // incident view needs the records themselves, and it keeps those in `incidentGroupsBuilder`
  // below rather than a second array here.
  auditRecordCount: 0,
  // S17.5/S17.7: the incident view's session/operator groups, appended to incrementally as
  // each page arrives — rebuilt fresh on every reset. `null` until the first reset.
  incidentGroupsBuilder: null,
  // S15: the reviewId of the draft this operator is currently editing for the selected
  // session, if any. Ephemeral — a reload loses it, same as every other piece of UI state
  // this client keeps nowhere durable (D67/D70 keep no per-operator record server-side);
  // there is no "list my drafts" route to recover it from, and none is needed — losing the
  // id after a reload just means starting a new draft.
  reviewDraftId: null,
  // S18.6/D79: whether the selected session has a running turn right now. Not a server
  // field — reconstructed from `turn.started`/`turn.ended` on this session's own stream,
  // the only place this client can observe it. Reset on every `openStream` so a reconnect
  // rebuilds it from the replay rather than carrying a stale guess forward.
  turnLive: false,
  // The running turn's id, carried by `turn.started` — `interrupt` needs it on the request
  // body (S5). `null` whenever `turnLive` is false; reset alongside it on every `openStream`.
  currentTurnId: null,
  // Wall-clock time the last envelope for the selected session was received. Feeds the
  // "no output for N min" indicator (D21: no server-side timer, the client watches its own
  // silence). `null` until the first envelope after a stream (re)opens.
  lastEnvelopeAt: null,
};

function currentSession() {
  return state.sessionId === null ? null : (state.sessionsById.get(state.sessionId) ?? null);
}

function sessionIsEnded() {
  const session = currentSession();
  return session !== null && session.state === 'ended';
}

// The compose box is the one control whose availability is a fact about the session rather
// than about this client. Everything else on the page stays readable either way: an ended
// session keeps its whole transcript and its checkpoints (D20).
function applySessionAvailability() {
  if (state.sessionId === null) return;
  const ended = sessionIsEnded();
  $('compose').hidden = ended;
  if (ended) status('this session has ended — the transcript is read-only', 'warn');
}

// S8.3: the standing sandbox banner is a fact about the session (`policy.banner`, set
// once at create and immutable for its life), not about a single event — so it is
// re-derived from whichever source is freshest whenever the session might have changed:
// selecting it (from `GET /api/sessions`, survives a reload) and a live `session.started`
// envelope (survives a replay from the spill, S8.3's other half — `banner` is passed
// explicitly there rather than re-read from `sessionsById`, which a fresh `create()` may
// not have caught up with yet). A `null` banner (an interactive-policy session, D5) hides
// the bar — no branch reads which vendor that is (I20).
function applyPolicyBanner(bannerOverride) {
  const bar = $('policy-banner');
  const session = currentSession();
  const banner = bannerOverride !== undefined ? bannerOverride : session && session.policy ? session.policy.banner : null;
  if (banner === null || banner === undefined) {
    bar.hidden = true;
    clear(bar);
    return;
  }
  bar.hidden = false;
  clear(bar);
  bar.appendChild(text('span', 'policy-banner__text', banner));
}

// ---------------------------------------------------------------------------
// S18.6/D79 — the status badge. A projection over `state`, the live turn (tracked from this
// session's own stream, above) and outstanding permission requests (`state.pendingPermissions`,
// S4/S9) — never a stored field, and never fetched. `ON PIP` (S18.7/D72) is a separate badge,
// derived in `refreshReviews` from the review fold, and can appear alongside any of these four.
// ---------------------------------------------------------------------------

// One table from state to { label, class } rather than two functions that have to agree on
// four magic strings by hand — a relabel here can't drift the class it renders with. The
// class reuses `.status__text--*`'s tone colours (`ok`/`error`/`info`) rather than
// redeclaring them; only the border-colour and the one tone with no existing match
// (`--ink-faint`, CLOCKED OUT) are `.status-badge`'s own in app.css.
const STATUS_BADGE_STATES = {
  clockedOut: { label: 'CLOCKED OUT', cls: 'status-badge status-badge--clocked-out' },
  blocked: { label: 'BLOCKED', cls: 'status-badge status-badge--blocked status__text--error' },
  onShift: { label: 'ON SHIFT', cls: 'status-badge status-badge--on-shift status__text--ok' },
  idle: { label: 'IDLE', cls: 'status-badge status__text--info' },
};

function statusBadgeState() {
  const session = currentSession();
  if (session === null) return null;
  if (session.state === 'ended') return STATUS_BADGE_STATES.clockedOut;
  if (state.pendingPermissions.size > 0) return STATUS_BADGE_STATES.blocked;
  if (state.turnLive) return STATUS_BADGE_STATES.onShift;
  return STATUS_BADGE_STATES.idle;
}

function applyStatusBadge() {
  const badge = $('status-badge');
  const next = statusBadgeState();
  if (next === null) {
    badge.hidden = true;
    return;
  }
  // Selecting a session calls this both from `openStream` and from the `refreshSessions`
  // that follows it, with nothing in between able to change the answer — skip the write
  // when nothing actually changed rather than re-render the identical badge twice.
  if (badge.hidden === false && badge.className === next.cls && badge.textContent === next.label) return;
  badge.hidden = false;
  badge.className = next.cls;
  badge.textContent = next.label;
}

// Interrupt is only offered while a turn is actually running and its id is known; End is
// offered whenever a session is selected and not already ended (S5's `end` route itself
// refuses `409 turn_in_flight` while one runs — this just steers the operator to Interrupt
// first rather than surfacing that refusal after the click).
function applyTurnControls() {
  $('interrupt').hidden = !state.turnLive || state.currentTurnId === null;
  $('end-session').hidden = state.sessionId === null || sessionIsEnded();
}

// D21: elapsed-since-last-envelope, computed here rather than carried on any envelope —
// the server keeps no idle timer, so "how long has it been quiet" is this client's own
// clock against `state.lastEnvelopeAt`, and only means anything while a turn is live.
function updateElapsedIndicator() {
  const el = $('turn-elapsed');
  if (!state.turnLive || state.lastEnvelopeAt === null) {
    el.hidden = true;
    return;
  }
  const minutes = Math.floor((Date.now() - state.lastEnvelopeAt) / 60000);
  el.hidden = false;
  el.textContent = `no output for ${minutes} min`;
}

function text(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = String(value);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function status(message, tone) {
  const bar = $('status');
  clear(bar);
  bar.appendChild(text('span', `status__text status__text--${tone ?? 'info'}`, message));
}

async function api(method, path, body) {
  const options = {
    method,
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  const response = await fetch(path, options);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  // A 401 from any route but the login exchange itself means the credential that got us
  // this far no longer works — every caller, not just refreshSessions, needs to fall back
  // to the login panel rather than leaving the console up showing a dead-end error.
  if (response.status === 401 && path !== '/api/login') showLogin();
  return { status: response.status, payload };
}

function describe(result) {
  const error = result.payload && result.payload.error;
  if (!error) return `request failed (${result.status})`;
  const field = error.detail && error.detail.field;
  return field ? `${error.code}: ${error.message} (${field})` : `${error.code}: ${error.message}`;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

async function refreshSessions() {
  const result = await api('GET', '/api/sessions');
  if (result.status === 401) return;
  if (result.status !== 200) return status(describe(result), 'error');

  const list = $('sessions');
  clear(list);
  state.sessionsById = new Map();
  for (const session of result.payload.sessions) {
    state.sessionsById.set(session.id, session);
  }
  for (const session of result.payload.sessions) {
    const item = document.createElement('li');
    item.className = 'session';
    if (session.id === state.sessionId) item.className = 'session session--current';

    const button = document.createElement('button');
    button.className = 'session__button';
    button.type = 'button';
    button.appendChild(text('span', 'session__cwd', session.cwd));
    button.appendChild(text('span', 'session__meta', `${session.vendor} · ${session.state}`));
    button.addEventListener('click', () => selectSession(session.id));

    item.appendChild(button);
    list.appendChild(item);
  }

  // A session can end without this client doing anything — a restart, or its operator
  // closing it from another tab — so the refresh that discovers that is also what has to
  // withdraw the compose box.
  applySessionAvailability();
  applyPolicyBanner();
  applyStatusBadge();
  applyTurnControls();
  $('terminate-open').hidden = state.sessionId === null;
}

function selectSession(sessionId) {
  state.sessionId = sessionId;
  state.refetched = false;
  applySessionAvailability();
  applyPolicyBanner();
  $('checkpoints').hidden = false;
  $('reviews').hidden = false;
  $('terminate-open').hidden = false;
  resetReviewForm();
  openStream(sessionId);
  void refreshSessions();
  void refreshCheckpoints();
  void refreshChecklist();
  void refreshReviews();
  void refreshPayroll();
}

// Fetches `/api/sessions/:id<suffix>` for the session selected when the call was made.
// Returns `null` when the caller must do nothing further — unauthenticated, or a faster
// session switch already landed after this request was sent, so rendering its payload
// would overwrite the newly-selected session's own state with a stale one. Otherwise
// returns `{ ok, payload }`, where `ok` is whether the fetch itself succeeded — some
// callers need to react to a failure (e.g. hide a now-untrustworthy panel) rather than
// just no-op the same as a `null`.
async function fetchForCurrentSession(suffix) {
  if (state.sessionId === null) return null;
  const requestedSessionId = state.sessionId;
  const result = await api('GET', `/api/sessions/${encodeURIComponent(requestedSessionId)}${suffix}`);
  if (result.status === 401) return null;
  if (state.sessionId !== requestedSessionId) return null;
  return { ok: result.status === 200, payload: result.payload };
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

async function refreshCheckpoints() {
  const fetched = await fetchForCurrentSession('/checkpoints');
  if (!fetched || !fetched.ok) return;

  const list = $('checkpoint-list');
  clear(list);
  for (const checkpoint of fetched.payload.checkpoints) {
    const item = document.createElement('li');
    item.className = 'checkpoint-item';

    item.appendChild(text('span', 'checkpoint-item__label', checkpoint.label));

    const button = document.createElement('button');
    button.className = 'button button--quiet';
    button.type = 'button';
    button.textContent = 'Restore';
    button.addEventListener('click', () => void restoreCheckpoint(checkpoint.sha));

    item.appendChild(button);
    list.appendChild(item);
  }
}

async function restoreCheckpoint(sha) {
  if (state.sessionId === null) return;
  status('restoring…', 'info');
  const result = await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/checkpoint/restore`, { sha });
  if (result.status === 401) return;
  if (result.status !== 200) return status(describe(result), 'error');
  status('restored', 'ok');
  await refreshCheckpoints();
}

// ---------------------------------------------------------------------------
// Onboarding checklist (S14) — S14.8: an empty `items` list (no `config.checklist`
// configured for this deployment) hides the panel rather than showing an empty one.
// ---------------------------------------------------------------------------

async function refreshChecklist() {
  const fetched = await fetchForCurrentSession('/checklist');
  if (!fetched) return;
  if (!fetched.ok) {
    // A failed refetch must not leave the previous session's rows (and their Tick
    // handlers, bound to that session's item ids) on screen under the session now
    // selected — hide the stale panel rather than trust it.
    $('checklist').hidden = true;
    clear($('checklist-list'));
    return;
  }

  const items = fetched.payload.items;
  $('checklist').hidden = items.length === 0;
  const list = $('checklist-list');
  clear(list);
  for (const item of items) {
    const li = document.createElement('li');
    li.className = item.completedBy ? 'checklist-item checklist-item--done' : 'checklist-item';
    li.appendChild(text('span', 'checklist-item__label', item.label));
    if (item.completedBy) {
      li.appendChild(text('span', 'checklist-item__done', `done — ${item.completedBy}`));
    } else {
      const button = document.createElement('button');
      button.className = 'button button--quiet';
      button.type = 'button';
      button.textContent = 'Tick';
      button.addEventListener('click', () => void tickChecklistItem(item.id));
      li.appendChild(button);
    }
    list.appendChild(li);
  }
}

async function tickChecklistItem(itemId) {
  if (state.sessionId === null) return;
  const result = await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/checklist/${encodeURIComponent(itemId)}`, {});
  if (result.status === 401) return;
  if (result.status !== 200) return status(describe(result), 'error');
  await refreshChecklist();
}

// ---------------------------------------------------------------------------
// Payroll (S16) — a pure read, no form. `500 payroll_unavailable` (S16.8) hides the
// panel rather than showing a stale or zeroed one; the session itself is unaffected.
// ---------------------------------------------------------------------------

async function refreshPayroll() {
  const fetched = await fetchForCurrentSession('/payroll');
  if (!fetched) return;
  const panel = $('payroll');
  const container = $('payroll-summary');
  if (!fetched.ok) {
    panel.hidden = true;
    clear(container);
    return;
  }
  panel.hidden = false;
  clear(container);
  container.appendChild(renderPayrollSummary(document, fetched.payload));
}

// A `replay_gap` says the server could not serve the history this connection asked for, so
// what is on screen is not the run (S3.3). A fresh `EventSource` carries no `Last-Event-ID`
// and therefore asks for the transcript from seq 1 — which is the refetch. Once only: a
// spill that cannot be read will gap again, and a client that reopens on every gap is a
// reconnect loop rather than a recovery.
function handleReplayGap() {
  if (state.refetched) {
    status('history unavailable — showing live events only', 'warn');
    return false;
  }
  state.refetched = true;
  status('reloading the transcript…', 'warn');
  openStream(state.sessionId);
  return true;
}

// Shared by both transports (S11.1: the envelope sequence is the same regardless of which
// one delivered it) — an `EventSource` `event.data` string and a WebSocket text frame carry
// the identical JSON, so both hand it here rather than duplicating the dispatch.
function handleEnvelope(sessionId, envelope) {
  const handlers = {
    onAnswerPermission: answerPermission,
    onRequestRendered: (requestId, controls) => {
      // Guarded the same way `turn.started`/`turn.ended` below are: a stream torn down by
      // `openStream` (a session switch) can still have an event in flight, and that event
      // must not repopulate the fresh `pendingPermissions` map `openStream` just reset.
      if (envelope.sessionId !== state.sessionId) return;
      state.pendingPermissions.set(requestId, controls);
      applyStatusBadge();
    },
    // S9.2: the download link on a truncated `tool.result` — not part of the wire
    // vocabulary any event carries, so it comes from this stream's own session rather
    // than the envelope.
    sessionId,
  };

  if (envelope.kind === 'error' && envelope.data?.kind === 'replay_gap') {
    if (handleReplayGap()) return;
  }
  // Every envelope for the session on screen resets the silence clock, not only the ones
  // that render — D21's "no output for N min" measures since the last *envelope*, which
  // includes `usage`, `checkpoint.created` and the rest, not just transcript content.
  if (envelope.sessionId === state.sessionId) state.lastEnvelopeAt = Date.now();
  if (envelope.kind === 'session.started' && envelope.sessionId === state.sessionId && envelope.data && envelope.data.policy) {
    // Replayed from the spill on every reconnect, including after a gap refetch —
    // the banner must survive that the same way the rest of the transcript does,
    // not just the initial live delivery.
    applyPolicyBanner(envelope.data.policy.banner);
  }
  if (envelope.kind === 'session.ended' && envelope.sessionId === state.sessionId) {
    // Withdrawn the moment it happens rather than at the next refresh: the session may
    // have been ended from another tab, or by a storage failure, and the operator must
    // not be left typing into a box whose next send is a `409`. The event still renders
    // below, so the transcript says what happened as well as the status bar.
    const session = currentSession();
    if (session !== null) state.sessionsById.set(state.sessionId, { ...session, state: 'ended' });
    applySessionAvailability();
    applyStatusBadge();
    applyTurnControls();
  }
  if (envelope.kind === 'turn.started' && envelope.sessionId === state.sessionId) {
    state.turnLive = true;
    state.currentTurnId = envelope.data.turnId;
    applyStatusBadge();
    applyTurnControls();
    updateElapsedIndicator();
  }
  if (envelope.kind === 'turn.ended' && envelope.sessionId === state.sessionId) {
    state.turnLive = false;
    state.currentTurnId = null;
    applyStatusBadge();
    applyTurnControls();
    updateElapsedIndicator();
  }
  if (envelope.kind === 'checkpoint.created') {
    // A new checkpoint invalidates the list this session already fetched, whether it
    // came from this client's own turn or a restore issued elsewhere.
    void refreshCheckpoints();
  }
  if (envelope.kind === 'checklist.item.completed' && envelope.sessionId === state.sessionId) {
    // Shows up for anyone else watching the same session (S14, brief item 10) — not just
    // the operator who ticked it.
    void refreshChecklist();
  }
  if ((envelope.kind === 'usage' || envelope.kind === 'turn.ended' || envelope.kind === 'session.ended') && envelope.sessionId === state.sessionId) {
    // `usage` moves burn; `turn.ended` closes an idle boundary and, on a restart-closed
    // turn, a dropped interval; `session.ended` finalises the trailing idle gap. Selecting
    // a session only fetches a snapshot (S16) — without this the panel would freeze at
    // whatever it read then, and a transient `payroll_unavailable` would never get a
    // second try.
    void refreshPayroll();
  }
  if (envelope.kind === 'permission.resolved') {
    const controls = state.pendingPermissions.get(envelope.data.requestId);
    if (controls) {
      // The request row this client already rendered is updated in place; a
      // separate standalone row would just repeat the same outcome right below it.
      const who = envelope.data.operator ? envelope.data.operator : `server (${envelope.data.reason})`;
      controls.setResolved(`${envelope.data.decision} — ${who}`);
      state.pendingPermissions.delete(envelope.data.requestId);
      applyStatusBadge();
      state.lastSeq = envelope.seq;
      return;
    }
  }
  state.lastSeq = envelope.seq;
  const node = renderEvent(document, envelope, handlers);
  if (node === null) return;
  const transcript = $('transcript');
  transcript.appendChild(node);
  transcript.scrollTop = transcript.scrollHeight;
}

// S11.5: the client learns which edge is live from the served page, never by probing.
function activeEdge() {
  const meta = document.querySelector('meta[name="skynet-edge"]');
  return meta && meta.content === 'ws' ? 'ws' : 'sse';
}

function openSseStream(sessionId) {
  // The browser's own EventSource retry handles a dropped connection, replaying from the
  // `Last-Event-ID` it kept; only a reported gap needs anything from this side.
  const stream = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
  state.stream = stream;

  // An ended session still streams — its whole transcript replays from the spill (D40) —
  // so "connected" is true and is not the thing the operator needs told. Saying it anyway
  // would overwrite the one message explaining why they cannot type.
  stream.onopen = () => (sessionIsEnded() ? applySessionAvailability() : status('connected', 'ok'));
  stream.onerror = () => status('reconnecting…', 'warn');

  for (const kind of [
    'session.started', 'session.ended', 'session.notice',
    'turn.started', 'turn.ended', 'usage',
    'message', 'thinking', 'tool.call', 'tool.result',
    'permission.request', 'permission.resolved', 'checkpoint.created', 'checklist.item.completed', 'error',
  ]) {
    stream.addEventListener(kind, (event) => {
      let envelope;
      try {
        envelope = JSON.parse(event.data);
      } catch {
        return;
      }
      handleEnvelope(sessionId, envelope);
    });
  }
}

// S11.4: a WebSocket carries no `Last-Event-ID` equivalent, so the resume point travels as
// `{ after }` on the first frame this client sends — read exactly as `Last-Event-ID` is on
// the SSE edge (`20-contract.md § edge/sse and edge/ws`). `WebSocket` has no built-in retry
// the way `EventSource` does, so a lost connection reopens by hand, resuming from whatever
// `state.lastSeq` this client last saw.
// 4401/4404 are this edge's own close codes for a first-message refusal (S11.3): the
// operator does not have a usable identity, or does not own this session. Neither
// resolves itself on retry, so reconnecting on these codes would just repeat the same
// refusal every 2 seconds forever with nothing telling the operator why.
const WS_PERMANENT_FAILURE_CODES = new Set([4401, 4404]);

function describeWsError(error) {
  return error && error.code && error.message ? `${error.code}: ${error.message}` : 'connection refused';
}

function openWsStream(sessionId) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const stream = new WebSocket(`${proto}//${window.location.host}/api/sessions/${encodeURIComponent(sessionId)}/events`);
  state.stream = stream;
  let lastError = null;

  stream.onopen = () => {
    stream.send(JSON.stringify({ after: state.lastSeq }));
    if (sessionIsEnded()) applySessionAvailability();
    else status('connected', 'ok');
  };
  stream.onmessage = (event) => {
    let envelope;
    try {
      envelope = JSON.parse(event.data);
    } catch {
      return;
    }
    if (envelope.type === 'error') {
      lastError = envelope.error; // a first-message auth/ownership refusal, not an Envelope
      return;
    }
    handleEnvelope(sessionId, envelope);
  };
  stream.onerror = () => status('reconnecting…', 'warn');
  stream.onclose = (event) => {
    if (state.stream !== stream || state.sessionId !== sessionId) return; // superseded by a newer stream
    if (WS_PERMANENT_FAILURE_CODES.has(event.code)) {
      status(describeWsError(lastError), 'error');
      return;
    }
    status('reconnecting…', 'warn');
    setTimeout(() => {
      if (state.stream === stream && state.sessionId === sessionId) openWsStream(sessionId);
    }, 2000);
  };
}

function openStream(sessionId) {
  if (state.stream) state.stream.close();
  state.lastSeq = 0;
  state.pendingPermissions = new Map();
  state.turnLive = false;
  state.currentTurnId = null;
  state.lastEnvelopeAt = null;
  clear($('transcript'));
  applyStatusBadge();
  applyTurnControls();
  updateElapsedIndicator();

  if (activeEdge() === 'ws') openWsStream(sessionId);
  else openSseStream(sessionId);
}

async function createSession(event) {
  event.preventDefault();
  const cwd = $('cwd').value.trim();
  const vendor = $('vendor').value.trim();
  const model = $('model').value.trim();
  const sandbox = $('sandbox').value.trim();
  const requisitionId = $('requisition-id').value.trim();
  if (cwd === '' || vendor === '') return status('a folder and an agent are both required', 'error');

  status('starting…', 'info');
  const result = await api('POST', '/api/sessions', {
    vendor,
    cwd,
    model: model === '' ? null : model,
    sandbox: sandbox === '' ? null : sandbox,
    requisitionId: requisitionId === '' ? null : requisitionId,
  });
  if (result.status === 401) return;
  if (result.status !== 201) {
    // A requisition-claim refusal (already decided, consumed by someone else) means the
    // option the operator just picked is stale — drop it from the picker rather than
    // leaving a dead option there to fail identically on retry.
    if (requisitionId !== '') await refreshRequisitionOptions();
    return status(describe(result), 'error');
  }
  status('session started', 'ok');
  await refreshSessions();
  if (requisitionId !== '') await refreshRequisitionOptions();
  selectSession(result.payload.sessionId);
}

// Posts the operator's decision and reports whether the server accepted it — `false`
// means another client (or this one, twice) already answered, per the wire contract.
async function answerPermission(requestId, decision) {
  if (state.sessionId === null) return false;
  const result = await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/permission`, {
    requestId,
    decision,
    scope: 'once',
    rule: null,
    reason: null,
  });
  if (result.status === 401) return false;
  if (result.status !== 200) {
    status(describe(result), 'error');
    return false;
  }
  return Boolean(result.payload && result.payload.accepted);
}

// S5: stops the running turn without ending the session. Needs the turn's own id, which
// only `applyTurnControls` offers the button for having — a stale click after the turn
// already ended (id gone) is a no-op rather than a request with a fabricated turnId.
async function doInterrupt() {
  if (state.sessionId === null || state.currentTurnId === null) return;
  const result = await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/interrupt`, { turnId: state.currentTurnId });
  if (result.status === 401) return;
  if (result.status !== 200) return status(describe(result), 'error');
  status('interrupted', 'ok');
}

// S5/D36: frees the workspace and keeps the record — distinct from Terminate, which
// destroys it. Refused `409 turn_in_flight` while a turn runs; `describe(result)` surfaces
// that refusal the same way every other write on this session does.
async function doEnd() {
  if (state.sessionId === null) return;
  const result = await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/end`, {});
  if (result.status === 401) return;
  if (result.status !== 200) return status(describe(result), 'error');
  status('session ended', 'ok');
  await refreshSessions();
}

async function sendMessage(event) {
  event.preventDefault();
  const field = $('text');
  const value = field.value.trim();
  if (value === '' || state.sessionId === null) return;
  field.value = '';

  const result = await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/message`, { text: value });
  if (result.status === 401) {
    field.value = value;
    return;
  }
  if (result.status !== 202) {
    field.value = value;
    return status(describe(result), 'error');
  }
  status('working…', 'info');
}

// ---------------------------------------------------------------------------
// Audit log (S12) — open to every authenticated operator, not scoped to the caller's own
// sessions (D70, S12.7), so this panel is independent of `state.sessionId`.
// ---------------------------------------------------------------------------

function isoFromLocalInput(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function readAuditFilters() {
  return {
    sessionId: $('audit-filter-session').value.trim(),
    operator: $('audit-filter-operator').value.trim(),
    since: isoFromLocalInput($('audit-filter-since').value),
    until: isoFromLocalInput($('audit-filter-until').value),
    incidentsOnly: $('audit-filter-incidents').checked,
  };
}

function auditQueryParams(filters, before) {
  const params = new URLSearchParams();
  params.set('limit', '50');
  if (before !== null) params.set('before', before);
  if (filters.sessionId !== '') params.set('sessionId', filters.sessionId);
  if (filters.operator !== '') params.set('operator', filters.operator);
  if (filters.since !== null) params.set('since', filters.since);
  if (filters.until !== null) params.set('until', filters.until);
  if (filters.incidentsOnly) params.set('incidentsOnly', 'true');
  return params;
}

async function loadAuditPage(reset) {
  if (reset) {
    state.auditCursor = null;
    state.auditFilters = readAuditFilters();
    state.auditRecordCount = 0;
    clear($('audit-rows'));
    clear($('audit-incident-groups'));
    state.incidentGroupsBuilder = createIncidentGroupsBuilder(document, $('audit-incident-groups'));
    $('audit-empty').hidden = true;
    // S17.5: the incident view groups by session and by operator; the ordinary view stays
    // the flat table S12 shipped. Set from the filters just pinned above, not after the
    // fetch below resolves — a 401, an error, or a response this reset itself supersedes
    // must not leave the *previous* mode's container visible over an empty/stale one.
    $('audit-table-wrap').hidden = state.auditFilters.incidentsOnly;
    $('audit-incident-groups').hidden = !state.auditFilters.incidentsOnly;
  }
  // Pinned at the last reset — "Load older" resumes the same query its cursor was minted
  // under, never whatever the filter inputs currently hold.
  const filters = state.auditFilters ?? readAuditFilters();
  const requestToken = ++state.auditRequestToken;
  const params = auditQueryParams(filters, state.auditCursor);
  const result = await api('GET', `/api/audit?${params.toString()}`);
  if (state.auditRequestToken !== requestToken) return; // superseded by a newer request
  if (result.status === 401) return;
  if (result.status !== 200) return status(describe(result), 'error');

  state.auditRecordCount += result.payload.records.length;

  // S17.7: each view only ever draws the page just fetched — the incident view appends it
  // into the groups already on the page rather than regrouping everything loaded so far.
  if (filters.incidentsOnly) {
    state.incidentGroupsBuilder.addRecords(result.payload.records);
  } else {
    const tbody = $('audit-rows');
    for (const record of result.payload.records) {
      tbody.appendChild(renderAuditRow(document, record));
    }
  }

  // D86/S12.5: round-tripped exactly as received — nothing here parses or constructs it.
  state.auditCursor = result.payload.nextCursor;
  $('audit-load-more').hidden = state.auditCursor === null;
  // A page can come back short — even empty — with a cursor still to follow: the server
  // bounds how many records one read may *examine*, not only how many it returns
  // (I39), so a filter that matches nothing in the first window is not an empty log.
  // "No records" is only true once the paging has actually reached the oldest record.
  if (state.auditRecordCount === 0 && state.auditCursor === null) $('audit-empty').hidden = false;
}

function openAudit() {
  $('audit').hidden = false;
  void loadAuditPage(true);
}

function closeAudit() {
  $('audit').hidden = true;
}

async function filterAudit(event) {
  event.preventDefault();
  await loadAuditPage(true);
}

// ---------------------------------------------------------------------------
// Reviews (S15) — PIP status is derived client-side from the finals `GET /api/reviews`
// already returns, never served as a session field (D72/D79): the latest final by
// `updatedAt`, ties broken by the later entry in the array — the server's own write order
// (S15.9/D83), the same tie-break `records.isUnderPip` applies. A draft is its author's
// alone (S15.3); `state.reviewDraftId` is this client's only record of which one it is
// currently editing.
// ---------------------------------------------------------------------------

function resetReviewForm() {
  $('review-form').reset();
  $('review-publish').disabled = true;
  state.reviewDraftId = null;
}

async function refreshReviews() {
  if (state.sessionId === null) return;
  const requestedSessionId = state.sessionId;
  const result = await api('GET', `/api/reviews?subject=${encodeURIComponent(requestedSessionId)}`);
  if (result.status === 401) return;
  if (state.sessionId !== requestedSessionId) return; // superseded by a faster session switch
  if (result.status !== 200) return status(describe(result), 'error');

  const reviews = result.payload.reviews;
  const tbody = $('review-rows');
  clear(tbody);
  for (const review of reviews) tbody.appendChild(renderReviewRow(document, review));
  $('reviews-empty').hidden = reviews.length > 0;

  let latest = null;
  for (const review of reviews) {
    if (latest === null || review.updatedAt >= latest.updatedAt) latest = review;
  }
  $('pip-badge').hidden = !(latest && latest.pip);
}

async function saveReviewDraft(event) {
  event.preventDefault();
  if (state.sessionId === null) return;
  const rating = $('review-rating').value.trim();
  const pip = $('review-pip').checked;
  const body = $('review-body').value;

  const result =
    state.reviewDraftId === null
      ? await api('POST', '/api/reviews', { subject: state.sessionId, rating: rating === '' ? null : rating, pip, body })
      : await api('POST', `/api/reviews/${encodeURIComponent(state.reviewDraftId)}`, { rating: rating === '' ? null : rating, pip, body });
  if (result.status === 401) return;
  if (result.status !== 201 && result.status !== 200) return status(describe(result), 'error');
  state.reviewDraftId = result.payload.review.reviewId;
  $('review-publish').disabled = false;
  status('draft saved', 'ok');
}

async function publishReview() {
  if (state.reviewDraftId === null) return;
  const result = await api('POST', `/api/reviews/${encodeURIComponent(state.reviewDraftId)}/finalise`, {});
  if (result.status === 401) return;
  if (result.status !== 200) return status(describe(result), 'error');
  status('review published', 'ok');
  resetReviewForm();
  await refreshReviews();
}

// ---------------------------------------------------------------------------
// Requisitions (S13) — open to every authenticated operator (D70): a requisition cannot
// be approved by someone who cannot see it. `workspace` is rendered as text only, exactly
// like every other operator-authored string this client shows (S13.15, I26).
// ---------------------------------------------------------------------------

// Fetches the requisition list once; `loadRequisitions` and `refreshRequisitionOptions`
// both render from the same response instead of each issuing their own GET.
async function fetchRequisitions() {
  const result = await api('GET', '/api/requisitions');
  if (result.status === 401) return null;
  if (result.status !== 200) {
    status(describe(result), 'error');
    return null;
  }
  return result.payload.requisitions;
}

function renderRequisitionRows(requisitions) {
  const tbody = $('requisition-rows');
  clear(tbody);
  for (const requisition of requisitions) {
    tbody.appendChild(renderRequisitionRow(document, requisition, (id, decision) => void decideRequisition(id, decision)));
  }
  $('requisitions-empty').hidden = tbody.children.length > 0;
}

// Repopulates the new-session form's requisition picker with the currently approved ones
// — the only state `POST /api/sessions` can spend (S13.7). Refreshed whenever the
// requisitions panel changes and after a session claims one, so a spent or since-decided
// requisition cannot linger as a selectable option.
function renderRequisitionOptions(requisitions) {
  const select = $('requisition-id');
  const previous = select.value;
  clear(select);
  const none = text('option', '', 'none');
  none.value = '';
  select.appendChild(none);
  let previousStillOffered = false;
  for (const requisition of requisitions) {
    if (requisition.state !== 'approved') continue;
    const option = text('option', '', `${requisition.title} (${requisition.workspace})`);
    option.value = requisition.requisitionId;
    if (option.value === previous) previousStillOffered = true;
    select.appendChild(option);
  }
  select.value = previousStillOffered ? previous : '';
}

async function loadRequisitions() {
  const requisitions = await fetchRequisitions();
  if (requisitions === null) return;
  renderRequisitionRows(requisitions);
}

async function refreshRequisitionOptions() {
  const requisitions = await fetchRequisitions();
  if (requisitions === null) return;
  renderRequisitionOptions(requisitions);
}

// The table and the picker both change on a decision — one fetch feeds both renders
// instead of `loadRequisitions` and `refreshRequisitionOptions` each fetching their own.
async function refreshRequisitionsPanel() {
  const requisitions = await fetchRequisitions();
  if (requisitions === null) return;
  renderRequisitionRows(requisitions);
  renderRequisitionOptions(requisitions);
}

async function raiseRequisition(event) {
  event.preventDefault();
  const title = $('requisition-title').value.trim();
  const justification = $('requisition-justification').value.trim();
  const workspace = $('requisition-workspace').value.trim();
  const vendor = $('requisition-vendor').value.trim();
  if (title === '' || justification === '' || workspace === '' || vendor === '') {
    return status('title, justification, workspace and agent are all required', 'error');
  }
  const result = await api('POST', '/api/requisitions', { title, justification, workspace, vendor });
  if (result.status === 401) return;
  if (result.status !== 201) return status(describe(result), 'error');
  $('raise-requisition').reset();
  status('requisition raised', 'ok');
  await loadRequisitions();
}

async function decideRequisition(requisitionId, decision) {
  const result = await api('POST', `/api/requisitions/${encodeURIComponent(requisitionId)}/decision`, { decision });
  if (result.status === 401) return;
  if (result.status !== 200) return status(describe(result), 'error');
  await refreshRequisitionsPanel();
}

function openRequisitions() {
  $('requisitions').hidden = false;
  void loadRequisitions();
}

function closeRequisitions() {
  $('requisitions').hidden = true;
}

// ---------------------------------------------------------------------------
// S18.1/D78 — the theme switcher. Sets the attribute `theme.js` already set before first
// paint; writes the choice to the same browser-storage key so it survives a reload
// (D60/S18.3 — this value never reaches the server, and switching issues no request and
// changes no markup, S18.2). `theme.js` cannot share this constant: it must stay a classic
// script and this file is a module, so the four-letter list is duplicated, not imported.
// ---------------------------------------------------------------------------

const THEME_STORAGE_KEY = 'skynet-hr-theme';
const THEMES = ['A', 'B', 'C', 'D'];

function applyTheme(themeId) {
  document.documentElement.setAttribute('data-theme', themeId);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, themeId);
  } catch {
    // A storage failure still lets the switch take effect for the rest of this load;
    // it just will not survive a reload.
  }
}

function initTheme() {
  const select = $('theme-select');
  const current = document.documentElement.getAttribute('data-theme');
  select.value = THEMES.includes(current) ? current : 'B';
  select.addEventListener('change', () => applyTheme(select.value));
}

// ---------------------------------------------------------------------------
// S18.9/D56 — the termination screen: presentation over `DELETE /api/sessions/:id` and the
// session state `GET /api/sessions` already returns. No field, route or stored value is
// introduced. Severance, a context purge, session duplication and a transcript of the
// departure conversation are all cut (D56/S18.10) — there is nothing here for any of them.
// ---------------------------------------------------------------------------

function openTerminate() {
  const session = currentSession();
  if (session === null) return;
  const dl = $('terminate-summary');
  clear(dl);
  renderSummaryRow(document, dl, 'Session', session.id);
  renderSummaryRow(document, dl, 'Owner', session.owner);
  renderSummaryRow(document, dl, 'Agent', session.model ? `${session.vendor} · ${session.model}` : session.vendor);
  renderSummaryRow(document, dl, 'Folder', session.cwd);
  renderSummaryRow(document, dl, 'Status', session.state);
  const ended = session.state === 'ended';
  $('terminate-ended').hidden = !ended;
  $('terminate-confirm').hidden = ended;
  $('terminate').hidden = false;
}

function closeTerminate() {
  $('terminate').hidden = true;
}

async function confirmTerminate() {
  if (state.sessionId === null) return;
  const result = await api('DELETE', `/api/sessions/${encodeURIComponent(state.sessionId)}`);
  if (result.status === 401) return;
  if (result.status !== 200) return status(describe(result), 'error');
  status('employment terminated', 'ok');
  closeTerminate();
  // DELETE actually removes the session — a subsequent GET 404s — so `refreshSessions`
  // below will no longer find it in `sessionsById`. Every piece of chrome that reads
  // `currentSession()`/`state.sessionId` has to go back to the same "nothing selected"
  // state a fresh page load starts in, not stay pointed at an id nothing on the server
  // answers to any more (`applySessionAvailability`'s `ended` check is false for a session
  // that no longer exists, not true, so left alone it would re-enable the compose box).
  if (state.stream) state.stream.close();
  state.stream = null;
  state.sessionId = null;
  state.lastSeq = 0;
  state.pendingPermissions = new Map();
  state.turnLive = false;
  state.currentTurnId = null;
  state.lastEnvelopeAt = null;
  clear($('transcript'));
  resetReviewForm();
  $('compose').hidden = true;
  $('checkpoints').hidden = true;
  $('checklist').hidden = true;
  $('payroll').hidden = true;
  $('reviews').hidden = true;
  applyTurnControls();
  updateElapsedIndicator();
  await refreshSessions();
}

// ---------------------------------------------------------------------------
// The shared-secret exchange. In the header-trust modes the proxy has already
// authenticated the operator and this panel is never shown.
// ---------------------------------------------------------------------------

function showLogin() {
  $('login').hidden = false;
  $('console').hidden = true;
  // The audit panel is a fixed full-viewport overlay independent of `#console` (S12.7) —
  // left open, it paints above `#login` and hides the very form this function exists to show.
  $('audit').hidden = true;
  $('terminate').hidden = true;
}

async function submitLogin(event) {
  event.preventDefault();
  const result = await api('POST', '/api/login', { secret: $('secret').value });
  if (result.status !== 200) return status('that secret was not accepted', 'error');
  $('secret').value = '';
  $('login').hidden = true;
  $('console').hidden = false;
  await refreshSessions();
}

function start() {
  $('new-session').addEventListener('submit', createSession);
  $('compose').addEventListener('submit', sendMessage);
  $('login-form').addEventListener('submit', submitLogin);
  $('refresh').addEventListener('click', () => void refreshSessions());
  $('audit-open').addEventListener('click', openAudit);
  $('audit-close').addEventListener('click', closeAudit);
  $('audit-filters').addEventListener('submit', filterAudit);
  $('audit-load-more').addEventListener('click', () => void loadAuditPage(false));
  $('requisitions-open').addEventListener('click', openRequisitions);
  $('requisitions-close').addEventListener('click', closeRequisitions);
  $('raise-requisition').addEventListener('submit', raiseRequisition);
  $('review-form').addEventListener('submit', saveReviewDraft);
  $('review-publish').addEventListener('click', () => void publishReview());
  $('terminate-open').addEventListener('click', openTerminate);
  $('terminate-close').addEventListener('click', closeTerminate);
  $('terminate-confirm').addEventListener('click', () => void confirmTerminate());
  $('interrupt').addEventListener('click', () => void doInterrupt());
  $('end-session').addEventListener('click', () => void doEnd());
  // No server-side timer ticks this (D21) — the client re-reads its own clock against
  // `state.lastEnvelopeAt` on an interval short enough that "N min" feels live. `unref`
  // (absent in a real browser, where this call is a no-op) keeps a host process — a test
  // runner that `import()`s this module, not a page — from being held open by this timer
  // forever; the check is defensive rather than environment-sniffing.
  const elapsedTicker = setInterval(updateElapsedIndicator, 15000);
  if (typeof elapsedTicker.unref === 'function') elapsedTicker.unref();
  initTheme();
  void refreshSessions();
  void refreshRequisitionOptions();
}

start();
