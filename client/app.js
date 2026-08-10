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
};

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
}

function selectSession(sessionId) {
  state.sessionId = sessionId;
  state.refetched = false;
  $('compose').hidden = false;
  openStream(sessionId);
  void refreshSessions();
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

function openStream(sessionId) {
  if (state.stream) state.stream.close();
  state.lastSeq = 0;
  state.pendingPermissions = new Map();
  clear($('transcript'));

  // The browser's own EventSource retry handles a dropped connection, replaying from the
  // `Last-Event-ID` it kept; only a reported gap needs anything from this side.
  const stream = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
  state.stream = stream;

  stream.onopen = () => status('connected', 'ok');
  stream.onerror = () => status('reconnecting…', 'warn');

  const handlers = {
    onAnswerPermission: answerPermission,
    onRequestRendered: (requestId, controls) => state.pendingPermissions.set(requestId, controls),
  };

  for (const kind of [
    'session.started', 'session.ended', 'session.notice',
    'turn.started', 'turn.ended',
    'message', 'thinking', 'tool.call', 'tool.result',
    'permission.request', 'permission.resolved', 'error',
  ]) {
    stream.addEventListener(kind, (event) => {
      let envelope;
      try {
        envelope = JSON.parse(event.data);
      } catch {
        return;
      }
      if (envelope.kind === 'error' && envelope.data?.kind === 'replay_gap') {
        if (handleReplayGap()) return;
      }
      if (envelope.kind === 'permission.resolved') {
        const controls = state.pendingPermissions.get(envelope.data.requestId);
        if (controls) {
          const who = envelope.data.operator ? envelope.data.operator : `server (${envelope.data.reason})`;
          controls.setResolved(`${envelope.data.decision} — ${who}`);
        }
      }
      state.lastSeq = envelope.seq;
      const node = renderEvent(document, envelope, handlers);
      if (node === null) return;
      const transcript = $('transcript');
      transcript.appendChild(node);
      transcript.scrollTop = transcript.scrollHeight;
    });
  }
}

async function createSession(event) {
  event.preventDefault();
  const cwd = $('cwd').value.trim();
  const vendor = $('vendor').value.trim();
  const model = $('model').value.trim();
  if (cwd === '' || vendor === '') return status('a folder and an agent are both required', 'error');

  status('starting…', 'info');
  const result = await api('POST', '/api/sessions', {
    vendor,
    cwd,
    model: model === '' ? null : model,
    sandbox: null,
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
