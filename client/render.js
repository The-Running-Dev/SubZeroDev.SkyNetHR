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

// S9.2/Delivers: a truncated result's full bytes are one click away at the tool-output
// route. `sessionId` comes from `handlers` rather than `data` — it is not part of the
// wire vocabulary any event carries (I20) — so this is the one renderer that reads it.
function toolResultNode(doc, data, handlers) {
  const body = el(doc, 'div', 'tool');
  const status = el(doc, 'div', 'tool__status', data.ok ? 'ok' : 'failed');
  body.appendChild(status);
  body.appendChild(el(doc, 'pre', 'tool__output', data.output));
  if (data.truncated) {
    body.appendChild(el(doc, 'div', 'tool__truncated', `truncated — ${data.bytes} bytes in full`));
    if (handlers && handlers.sessionId) {
      const link = el(doc, 'a', 'tool__truncated-link', 'download full output');
      link.setAttribute(
        'href',
        `/api/sessions/${encodeURIComponent(handlers.sessionId)}/tool-output/${encodeURIComponent(data.turnId)}/${encodeURIComponent(data.callId)}`,
      );
      body.appendChild(link);
    }
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

function checkpointCreatedNode(doc, data) {
  return row(doc, 'checkpoint', 'checkpoint', el(doc, 'div', 'checkpoint__text', data.turnId === null ? `safety checkpoint — ${data.label}` : data.label));
}

// S14.3: this envelope carries no `turnId` and may land mid-turn — rendered attributed to
// the operator who ticked it (`data.by`), never to the agent.
function checklistItemCompletedNode(doc, data) {
  return row(doc, 'checklist', 'checklist', el(doc, 'div', 'checklist__text', `checklist item checked off — ${data.by}`));
}

// `handlers.onAnswerPermission(requestId, decision)` posts the answer and resolves to
// whether the server accepted it; `handlers.onRequestRendered(requestId, controls)`
// hands the caller a `setResolved(text)` closure so a later `permission.resolved` —
// including one answered from a different client — can update this same row without
// the caller ever querying the DOM for it.
function permissionRequestNode(doc, data, handlers) {
  const body = el(doc, 'div', 'permission');
  body.appendChild(el(doc, 'div', 'permission__tool', data.tool));
  body.appendChild(el(doc, 'pre', 'permission__input', pretty(data.input)));

  const actions = el(doc, 'div', 'permission__actions');
  const allowBtn = el(doc, 'button', 'button button--allow', 'Allow');
  allowBtn.type = 'button';
  const denyBtn = el(doc, 'button', 'button button--deny', 'Deny');
  denyBtn.type = 'button';
  const hint = el(doc, 'div', 'permission__hint', 'awaiting an answer');

  function setResolved(text) {
    allowBtn.disabled = true;
    denyBtn.disabled = true;
    hint.textContent = text;
  }

  if (handlers && handlers.onAnswerPermission) {
    async function answer(decision) {
      allowBtn.disabled = true;
      denyBtn.disabled = true;
      hint.textContent = 'sending…';
      const accepted = await handlers.onAnswerPermission(data.requestId, decision);
      // A definite outcome — who answered, and with what — arrives separately as this
      // same request's `permission.resolved` envelope, which calls `setResolved`
      // above; `accepted: false` here means only that this click lost the race.
      if (!accepted) hint.textContent = 'already answered';
    }
    allowBtn.addEventListener('click', () => void answer('allow'));
    denyBtn.addEventListener('click', () => void answer('deny'));
  } else {
    setResolved('awaiting an answer');
  }

  actions.appendChild(allowBtn);
  actions.appendChild(denyBtn);
  body.appendChild(actions);
  body.appendChild(hint);

  if (handlers && handlers.onRequestRendered) handlers.onRequestRendered(data.requestId, { setResolved });

  return row(doc, 'permission', 'permission', body);
}

function permissionResolvedNode(doc, data) {
  const body = el(doc, 'div', 'permission-resolved');
  const who = data.operator ? data.operator : `server (${data.reason})`;
  body.appendChild(el(doc, 'div', 'permission-resolved__text', `${data.decision} — ${who}`));
  return row(doc, 'permission-resolved', 'permission', body);
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
  'permission.resolved': permissionResolvedNode,
  'checkpoint.created': checkpointCreatedNode,
  'checklist.item.completed': checklistItemCompletedNode,
  error: errorNode,
};

/**
 * Returns a detached element for one envelope, or `null` for a kind this build does not
 * draw. `null` rather than a placeholder: an event a later slice introduces should be
 * invisible here, not rendered as damage.
 *
 * `handlers` is optional and reaches only `permission.request` and `tool.result` today
 * (see above); every other renderer ignores it.
 */
export function renderEvent(doc, envelope, handlers) {
  const renderer = RENDERERS[envelope.kind];
  if (renderer === undefined) return null;
  return renderer(doc, envelope.data ?? {}, handlers);
}

// S12.10: an `AuditRecord.input` is attacker-influenceable exactly like a `tool.call`'s
// (I12: never truncated, summarised or derived — the operator sees the real bytes), so it
// goes through `textContent` the same way, never assembled markup.
export function renderAuditRow(doc, record) {
  const tr = doc.createElement('tr');
  tr.className = 'audit-row';
  const cell = (className, text) => {
    const td = doc.createElement('td');
    td.className = className;
    td.textContent = text === null || text === undefined ? '' : String(text);
    return td;
  };
  tr.appendChild(cell('audit-row__ts', record.ts));
  tr.appendChild(cell('audit-row__operator', record.operator === null ? 'server' : record.operator));
  tr.appendChild(cell('audit-row__session', record.sessionId));
  tr.appendChild(cell('audit-row__tool', record.tool));
  const inputCell = doc.createElement('td');
  inputCell.className = 'audit-row__input';
  inputCell.appendChild(el(doc, 'pre', 'audit-row__input-pre', pretty(record.input)));
  tr.appendChild(inputCell);
  tr.appendChild(cell('audit-row__decision', record.decision));
  tr.appendChild(cell('audit-row__scope', record.scope));
  return tr;
}

// S13.15: `title`, `justification` and `workspace` are one operator's free text read by
// another (D74) — the same `textContent`-only discipline as `renderAuditRow`'s `input`,
// never assembled markup. `onDecide`, when given, receives `(requisitionId, decision)` and
// is wired to Approve/Reject buttons shown only while `state === 'open'`.
export function renderRequisitionRow(doc, requisition, onDecide) {
  const tr = doc.createElement('tr');
  tr.className = 'requisition-row';
  const cell = (className, text) => {
    const td = doc.createElement('td');
    td.className = className;
    td.textContent = text === null || text === undefined ? '' : String(text);
    return td;
  };
  tr.appendChild(cell('requisition-row__title', requisition.title));
  tr.appendChild(cell('requisition-row__justification', requisition.justification));
  tr.appendChild(cell('requisition-row__workspace', requisition.workspace));
  tr.appendChild(cell('requisition-row__vendor', requisition.vendor));
  tr.appendChild(cell('requisition-row__raised-by', requisition.raisedBy));
  tr.appendChild(cell('requisition-row__state', requisition.state));
  tr.appendChild(cell('requisition-row__decided-by', requisition.decidedBy));

  const actions = doc.createElement('td');
  actions.className = 'requisition-row__actions';
  if (requisition.state === 'open' && onDecide) {
    const approve = doc.createElement('button');
    approve.type = 'button';
    approve.className = 'button button--quiet';
    approve.textContent = 'Approve';
    approve.addEventListener('click', () => onDecide(requisition.requisitionId, 'approve'));
    const reject = doc.createElement('button');
    reject.type = 'button';
    reject.className = 'button button--quiet';
    reject.textContent = 'Reject';
    reject.addEventListener('click', () => onDecide(requisition.requisitionId, 'reject'));
    actions.appendChild(approve);
    actions.appendChild(reject);
  }
  tr.appendChild(actions);
  return tr;
}
