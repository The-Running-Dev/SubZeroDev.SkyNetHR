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

// (D160/S21.10) The same allow-list the read route serves `Content-Type` under — an image
// renders inline under the document's existing `img-src 'self'`; everything else is a
// download naming the file and its size. `filename` reaches the DOM only as a text node
// (`el`'s `textContent`), so an upload named `<img src=x onerror=alert(1)>` renders as
// literal characters and executes nothing (I26, D74).
const ATTACHMENT_IMAGE_ALLOWLIST = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const kib = n / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}

function attachmentNode(doc, ref, sessionId, turnId) {
  const href = `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(turnId)}/${encodeURIComponent(ref.attachmentId)}`;
  if (ATTACHMENT_IMAGE_ALLOWLIST.has(ref.mediaType)) {
    const img = el(doc, 'img', 'message__attachment-image');
    img.setAttribute('src', href);
    img.setAttribute('alt', ref.filename);
    return img;
  }
  const link = el(doc, 'a', 'message__attachment-link');
  link.setAttribute('href', href);
  link.appendChild(el(doc, 'span', 'message__attachment-name', ref.filename));
  link.appendChild(el(doc, 'span', 'message__attachment-size', ` (${formatBytes(ref.bytes)})`));
  return link;
}

function messageNode(doc, data, handlers) {
  const body = el(doc, 'div', 'message');
  const textNode = el(doc, 'div', 'message__text', data.text);
  body.appendChild(textNode);
  if (Array.isArray(data.attachments) && data.attachments.length > 0 && handlers && handlers.sessionId) {
    const attachments = el(doc, 'div', 'message__attachments');
    for (const ref of data.attachments) attachments.appendChild(attachmentNode(doc, ref, handlers.sessionId, data.turnId));
    body.appendChild(attachments);
  }
  const wrapper = row(doc, data.role === 'user' ? 'user' : 'assistant', data.role === 'user' ? 'you' : 'agent', body);
  // (D168, S25.5) Read back by `appendMessageDeltaText` below, so a bubble started from
  // one `message.delta` can grow as its later deltas arrive rather than each rendering a
  // new node. A plain property, not part of the DOM API: harmless on a real element and
  // supported by the test stub's proxy the same way any other assignment is.
  wrapper.__messageTextNode = textNode;
  return wrapper;
}

// (D168, S25.5) Grows the bubble a `message.delta` started, in arrival order — the only
// order a frame carries (I51) — rather than replacing its text. `node` is whatever
// `renderEvent` returned for that `turnId`'s first delta.
export function appendMessageDeltaText(node, text) {
  const textNode = node.__messageTextNode;
  if (!textNode) return;
  textNode.textContent = (textNode.textContent || '') + text;
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

// S16: no formatter for a duration or a token count existed anywhere in this client before
// this panel — both are written here, next to `pretty`, rather than inline in `app.js`,
// matching this file's existing convention that value-to-text conversion lives here.
export function formatDuration(ms) {
  const clamped = Math.max(0, ms);
  const totalMinutes = Math.floor(clamped / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0 && minutes === 0) return '<1m';
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

export function formatTokenCount(n) {
  return n.toLocaleString('en-US');
}

// `currency` is a label the server never interprets (D158), so this formats by
// concatenation rather than handing it to `Intl.NumberFormat`, which would reject or
// mis-render anything that is not a real ISO currency code.
export function formatCost(costCurrency, currency) {
  const amount = costCurrency.toFixed(2);
  return currency === null ? amount : `${currency} ${amount}`;
}

// Shared by `renderPayrollSummary` below and `openTerminate` in app.js — both are a `<dl>` of
// label/value rows over the same `payroll-summary__*` classes, so both build a row here rather
// than each hand-rolling its own copy of the same three-element wrapper.
export function renderSummaryRow(doc, dl, label, value) {
  const wrapper = el(doc, 'div', 'payroll-summary__row');
  wrapper.appendChild(el(doc, 'dt', 'payroll-summary__label', label));
  wrapper.appendChild(el(doc, 'dd', 'payroll-summary__value', value));
  dl.appendChild(wrapper);
}

// S16.4/S16.7: a pure read — `burn`'s four fields are summed here for display only, never
// re-derived or second-guessed (the server's sum is authoritative, I28) — and the dropped-
// interval notice (D76) is shown only when there is one to report.
export function renderPayrollSummary(doc, view) {
  const totalBurn = view.burn.inputTokens + view.burn.outputTokens + view.burn.cacheRead + view.burn.cacheCreate;
  const dl = el(doc, 'dl', 'payroll-summary');
  renderSummaryRow(doc, dl, 'Burn', `${formatTokenCount(totalBurn)} tokens`);
  renderSummaryRow(doc, dl, 'Budget remaining', view.remainingTokens === null ? 'no budget set' : `${formatTokenCount(view.remainingTokens)} tokens`);
  renderSummaryRow(doc, dl, 'Idle time', formatDuration(view.idleMs));
  if (view.droppedIntervals > 0) {
    const plural = view.droppedIntervals === 1 ? 'interval' : 'intervals';
    renderSummaryRow(doc, dl, 'Unaccounted idle', `${view.droppedIntervals} ${plural} dropped — the server was down for part of it`);
  }
  // S20.4: an unpriceable session (no rates configured, or a transport that cannot report
  // usage) omits this row entirely rather than showing a currency-formatted zero.
  if (view.costCurrency !== null) {
    renderSummaryRow(doc, dl, 'Estimated cost', `${formatCost(view.costCurrency, view.currency)} — an estimate against configured rates, not a vendor bill`);
  }
  return dl;
}

const RENDERERS = {
  'session.started': sessionStartedNode,
  'session.ended': sessionEndedNode,
  'session.notice': noticeNode,
  'turn.started': turnStartedNode,
  'turn.ended': turnEndedNode,
  message: messageNode,
  // (D168, S25.5) The first delta of a `turnId` renders through this same node shape —
  // `appendMessageDeltaText` grows it for every delta after that.
  'message.delta': messageNode,
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

// S17.5: the server returns records; grouping by session and by operator is the reader's
// (D73) — no grouped shape exists in the contract. Nested session-then-operator, in the
// order groups are first encountered in `records` (already newest-first from the server).
export function groupAuditRecords(records) {
  const bySession = [];
  const sessionIndex = new Map();
  for (const record of records) {
    let session = sessionIndex.get(record.sessionId);
    if (session === undefined) {
      session = { sessionId: record.sessionId, operators: [], operatorIndex: new Map() };
      sessionIndex.set(record.sessionId, session);
      bySession.push(session);
    }
    const operatorKey = record.operator;
    let group = session.operatorIndex.get(operatorKey);
    if (group === undefined) {
      group = { operator: operatorKey, records: [] };
      session.operatorIndex.set(operatorKey, group);
      session.operators.push(group);
    }
    group.records.push(record);
  }
  return bySession.map(({ sessionId, operators }) => ({ sessionId, operators }));
}

// Same seven columns and labels as the flat table's static `<thead>` in `index.html` — kept
// in sync by hand since a per-operator table here has nowhere else to draw one from.
function incidentTableHead(doc) {
  const thead = doc.createElement('thead');
  const tr = doc.createElement('tr');
  for (const label of ['When', 'Operator', 'Session', 'Tool', 'Input', 'Decision', 'Scope']) {
    tr.appendChild(el(doc, 'th', undefined, label));
  }
  thead.appendChild(tr);
  return thead;
}

// The incident view (S17): the same rows `renderAuditRow` produces, under headings that
// group them by session and then by operator — never a new shape, just a different
// arrangement of the flat page the server already returned.
//
// S17.7: builds incrementally — `addRecords` slots each new page's records into the
// session/operator groups already on the page rather than regrouping and redrawing
// everything loaded so far, so "Load older" stays linear in total records loaded instead of
// quadratic.
export function createIncidentGroupsBuilder(doc, container) {
  const sessionIndex = new Map();

  function sessionGroupFor(sessionId) {
    let session = sessionIndex.get(sessionId);
    if (session === undefined) {
      const sessionEl = el(doc, 'section', 'incident-group incident-group--session');
      sessionEl.appendChild(el(doc, 'h3', 'incident-group__heading', `Session ${sessionId}`));
      container.appendChild(sessionEl);
      session = { sessionEl, operatorIndex: new Map() };
      sessionIndex.set(sessionId, session);
    }
    return session;
  }

  function operatorTbodyFor(session, operatorKey) {
    let tbody = session.operatorIndex.get(operatorKey);
    if (tbody === undefined) {
      const opGroup = el(doc, 'div', 'incident-group incident-group--operator');
      opGroup.appendChild(el(doc, 'h4', 'incident-group__subheading', operatorKey === null ? 'server' : operatorKey));
      const table = el(doc, 'table', 'audit-table');
      table.appendChild(incidentTableHead(doc));
      tbody = el(doc, 'tbody');
      table.appendChild(tbody);
      opGroup.appendChild(table);
      session.sessionEl.appendChild(opGroup);
      session.operatorIndex.set(operatorKey, tbody);
    }
    return tbody;
  }

  return {
    addRecords(records) {
      for (const record of records) {
        const tbody = operatorTbodyFor(sessionGroupFor(record.sessionId), record.operator);
        tbody.appendChild(renderAuditRow(doc, record));
      }
    },
  };
}

export function renderIncidentGroups(doc, records) {
  const container = el(doc, 'div', 'incident-groups');
  createIncidentGroupsBuilder(doc, container).addRecords(records);
  return container;
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

// S15.13: `body` is one operator's free text read by every authenticated operator once
// the review is final (D74's carve-out, widened past agent-derived content) — the same
// `textContent`-only discipline as `renderRequisitionRow`'s, never assembled markup.
export function renderReviewRow(doc, review) {
  const tr = doc.createElement('tr');
  tr.className = 'review-row';
  tr.appendChild(el(doc, 'td', 'review-row__author', review.author));
  tr.appendChild(el(doc, 'td', 'review-row__rating', review.rating));
  tr.appendChild(el(doc, 'td', 'review-row__pip', review.pip ? 'ON PIP' : ''));
  tr.appendChild(el(doc, 'td', 'review-row__state', review.state));
  const bodyCell = doc.createElement('td');
  bodyCell.className = 'review-row__body';
  bodyCell.appendChild(el(doc, 'pre', 'review-row__body-pre', review.body));
  tr.appendChild(bodyCell);
  return tr;
}
