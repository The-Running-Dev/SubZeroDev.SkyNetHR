import { renderEvent } from './render.js';

const $ = (id) => document.getElementById(id);

const state = {
  sessionId: null,
  stream: null,
  lastSeq: 0,
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
  if (result.status === 401) return showLogin();
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
  if (state.stream) state.stream.close();
  state.sessionId = sessionId;
  state.lastSeq = 0;
  clear($('transcript'));
  $('compose').hidden = false;

  // Reconnect and replay are S3's; this build opens a fresh stream and lets the browser's
  // own EventSource retry handle a dropped connection.
  const stream = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
  state.stream = stream;

  stream.onopen = () => status('connected', 'ok');
  stream.onerror = () => status('reconnecting…', 'warn');

  for (const kind of [
    'session.started', 'session.ended', 'session.notice',
    'turn.started', 'turn.ended',
    'message', 'thinking', 'tool.call', 'tool.result',
    'permission.request', 'error',
  ]) {
    stream.addEventListener(kind, (event) => {
      let envelope;
      try {
        envelope = JSON.parse(event.data);
      } catch {
        return;
      }
      state.lastSeq = envelope.seq;
      const node = renderEvent(document, envelope);
      if (node === null) return;
      const transcript = $('transcript');
      transcript.appendChild(node);
      transcript.scrollTop = transcript.scrollHeight;
    });
  }

  void refreshSessions();
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
  if (result.status !== 201) return status(describe(result), 'error');
  status('session started', 'ok');
  await refreshSessions();
  selectSession(result.payload.sessionId);
}

async function sendMessage(event) {
  event.preventDefault();
  const field = $('text');
  const value = field.value.trim();
  if (value === '' || state.sessionId === null) return;
  field.value = '';

  const result = await api('POST', `/api/sessions/${encodeURIComponent(state.sessionId)}/message`, { text: value });
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
