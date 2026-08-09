// Rendering rules are binding and live in `10-design.md § Security controls`.
//
// The whole of this file's input is attacker-influenceable: model output, tool names, tool
// arguments, stderr. Every string therefore reaches the document through `textContent` and
// nothing else. There is no `innerHTML` here, and no string of markup is ever assembled —
// not as a hardening measure to be audited later, but because the alternative has no safe
// version.
//
// `doc` is passed in rather than reached for so this module can be exercised without a
// browser. It is the only reason the signature has a first parameter.

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function row(doc, kindClass, label, body) {
  const wrapper = el(doc, 'div', `event event--${kindClass}`);
  wrapper.appendChild(el(doc, 'span', 'event__label', label));
  wrapper.appendChild(body);
  return wrapper;
}

function pretty(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function messageNode(doc, data) {
  const body = el(doc, 'div', 'message');
  body.appendChild(el(doc, 'div', 'message__text', data.text));
  return row(doc, data.role === 'user' ? 'user' : 'assistant', data.role === 'user' ? 'you' : 'agent', body);
}

function thinkingNode(doc, data) {
  const body = el(doc, 'div', 'thinking');
  body.appendChild(el(doc, 'div', 'thinking__text', data.text));
  return row(doc, 'thinking', 'thinking', body);
}

function toolCallNode(doc, data) {
  const body = el(doc, 'div', 'tool');
  body.appendChild(el(doc, 'div', 'tool__name', data.name));
  if (data.summary) body.appendChild(el(doc, 'div', 'tool__summary', data.summary));
  body.appendChild(el(doc, 'pre', 'tool__input', pretty(data.input)));
  return row(doc, 'tool-call', 'tool', body);
}

function toolResultNode(doc, data) {
  const body = el(doc, 'div', 'tool');
  const status = el(doc, 'div', 'tool__status', data.ok ? 'ok' : 'failed');
  body.appendChild(status);
  body.appendChild(el(doc, 'pre', 'tool__output', data.output));
  if (data.truncated) {
    body.appendChild(el(doc, 'div', 'tool__truncated', `truncated — ${data.bytes} bytes in full`));
  }
  return row(doc, 'tool-result', 'result', body);
}

function noticeNode(doc, data) {
  const body = el(doc, 'div', 'notice');
  body.appendChild(el(doc, 'div', 'notice__text', data.text));
  return row(doc, `notice-${data.level}`, data.code, body);
}

function errorNode(doc, data) {
  const body = el(doc, 'div', 'error-event');
  body.appendChild(el(doc, 'div', 'error-event__text', data.message ?? data.code));
  return row(doc, 'error', data.fatal ? 'fatal' : 'error', body);
}

function turnStartedNode(doc) {
  return row(doc, 'turn-started', 'turn', el(doc, 'div', 'turn__text', 'started'));
}

function turnEndedNode(doc, data) {
  return row(doc, 'turn-ended', 'turn', el(doc, 'div', 'turn__text', `ended — ${data.stopReason}`));
}

function sessionStartedNode(doc, data) {
  const body = el(doc, 'div', 'session-started');
  body.appendChild(el(doc, 'div', 'session-started__cwd', data.cwd));
  // `vendor` is data the server sent, displayed as text. No branch reads it (I20).
  body.appendChild(el(doc, 'div', 'session-started__meta', data.model ? `${data.vendor} · ${data.model}` : data.vendor));
  return row(doc, 'session-started', 'session', body);
}

function sessionEndedNode(doc, data) {
  return row(doc, 'session-ended', 'session', el(doc, 'div', 'session__text', `ended — ${data.reason}`));
}

function permissionRequestNode(doc, data) {
  const body = el(doc, 'div', 'permission');
  body.appendChild(el(doc, 'div', 'permission__tool', data.tool));
  body.appendChild(el(doc, 'pre', 'permission__input', pretty(data.input)));
  // Answering is S4's. Until then the request is shown so a stalled turn is legible
  // rather than looking like an agent that stopped thinking.
  body.appendChild(el(doc, 'div', 'permission__hint', 'awaiting an answer'));
  return row(doc, 'permission', 'permission', body);
}

const RENDERERS = {
  'session.started': sessionStartedNode,
  'session.ended': sessionEndedNode,
  'session.notice': noticeNode,
  'turn.started': turnStartedNode,
  'turn.ended': turnEndedNode,
  message: messageNode,
  thinking: thinkingNode,
  'tool.call': toolCallNode,
  'tool.result': toolResultNode,
  'permission.request': permissionRequestNode,
  error: errorNode,
};

/**
 * Returns a detached element for one envelope, or `null` for a kind this build does not
 * draw. `null` rather than a placeholder: an event a later slice introduces should be
 * invisible here, not rendered as damage.
 */
export function renderEvent(doc, envelope) {
  const renderer = RENDERERS[envelope.kind];
  if (renderer === undefined) return null;
  return renderer(doc, envelope.data ?? {});
}
