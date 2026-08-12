import { renderEvent } from './render.js';

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
}

function selectSession(sessionId) {
  state.sessionId = sessionId;
  state.refetched = false;
  applySessionAvailability();
  applyPolicyBanner();
  $('checkpoints').hidden = false;
  openStream(sessionId);
  void refreshSessions();
  void refreshCheckpoints();
}

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

async function refreshCheckpoints() {
  if (state.sessionId === null) return;
  const requestedSessionId = state.sessionId;
  const result = await api('GET', `/api/sessions/${encodeURIComponent(requestedSessionId)}/checkpoints`);
  if (result.status === 401 || result.status !== 200) return;
  // A faster response for a session switched to *after* this request was sent must not
  // overwrite that session's own list with a stale one.
  if (state.sessionId !== requestedSessionId) return;

  const list = $('checkpoint-list');
  clear(list);
  for (const checkpoint of result.payload.checkpoints) {
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
    onRequestRendered: (requestId, controls) => state.pendingPermissions.set(requestId, controls),
    // S9.2: the download link on a truncated `tool.result` — not part of the wire
    // vocabulary any event carries, so it comes from this stream's own session rather
    // than the envelope.
    sessionId,
  };

  if (envelope.kind === 'error' && envelope.data?.kind === 'replay_gap') {
    if (handleReplayGap()) return;
  }
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
  }
  if (envelope.kind === 'checkpoint.created') {
    // A new checkpoint invalidates the list this session already fetched, whether it
    // came from this client's own turn or a restore issued elsewhere.
    void refreshCheckpoints();
  }
  if (envelope.kind === 'permission.resolved') {
    const controls = state.pendingPermissions.get(envelope.data.requestId);
    if (controls) {
      // The request row this client already rendered is updated in place; a
      // separate standalone row would just repeat the same outcome right below it.
      const who = envelope.data.operator ? envelope.data.operator : `server (${envelope.data.reason})`;
      controls.setResolved(`${envelope.data.decision} — ${who}`);
      state.pendingPermissions.delete(envelope.data.requestId);
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
    'turn.started', 'turn.ended',
    'message', 'thinking', 'tool.call', 'tool.result',
    'permission.request', 'permission.resolved', 'checkpoint.created', 'error',
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
function openWsStream(sessionId) {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const stream = new WebSocket(`${proto}//${window.location.host}/api/sessions/${encodeURIComponent(sessionId)}/events`);
  state.stream = stream;

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
    if (envelope.type === 'error') return; // a first-message auth/ownership refusal, not an Envelope
    handleEnvelope(sessionId, envelope);
  };
  stream.onerror = () => status('reconnecting…', 'warn');
  stream.onclose = () => {
    if (state.stream !== stream || state.sessionId !== sessionId) return; // superseded by a newer stream
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
  clear($('transcript'));

  if (activeEdge() === 'ws') openWsStream(sessionId);
  else openSseStream(sessionId);
}

async function createSession(event) {
  event.preventDefault();
  const cwd = $('cwd').value.trim();
  const vendor = $('vendor').value.trim();
  const model = $('model').value.trim();
  const sandbox = $('sandbox').value.trim();
  if (cwd === '' || vendor === '') return status('a folder and an agent are both required', 'error');

  status('starting…', 'info');
  const result = await api('POST', '/api/sessions', {
    vendor,
    cwd,
    model: model === '' ? null : model,
    sandbox: sandbox === '' ? null : sandbox,
  });
  if (result.status === 401) return;
  if (result.status !== 201) return status(describe(result), 'error');
  status('session started', 'ok');
  await refreshSessions();
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
// The shared-secret exchange. In the header-trust modes the proxy has already
// authenticated the operator and this panel is never shown.
// ---------------------------------------------------------------------------

function showLogin() {
  $('login').hidden = false;
  $('console').hidden = true;
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
  void refreshSessions();
}

start();
