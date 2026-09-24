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

// S37: compact may demote short assistant narration, but the classification is a display
// annotation only. The complete rule set is data here — no renderer branch carries its own
// phrase test. Conservative length/paragraph bounds keep a substantive answer from becoming
// ephemeral merely because its first sentence announces an action.
export const EPHEMERAL_ASSISTANT_TEXT_RULES = Object.freeze([
  {
    id: 'short-progress',
    maxChars: 80,
    maxParagraphs: 1,
    pattern: /^(?:working on (?:it|this)|on it|checking now|looking into it|one moment)(?:[.!…]*)$/i,
  },
  {
    id: 'about-to-action',
    maxChars: 280,
    maxParagraphs: 1,
    pattern: /^(?:(?:i|we)(?:['’](?:m|re)| am| are)\s+)?about to\s+(?:check|inspect|review|investigate|trace|look|run|test|verify|implement|update|change|fix|add|remove|read|open|fetch|compare|start|continue)\b/i,
  },
  {
    id: 'present-action',
    maxChars: 280,
    maxParagraphs: 1,
    pattern: /^(?:i|we)(?:['’](?:m|re)| am| are)\s+(?:checking|inspecting|reviewing|investigating|tracing|looking|running|testing|verifying|implementing|updating|changing|fixing|adding|removing|reading|opening|fetching|comparing|starting|continuing|working)\b/i,
  },
  {
    id: 'going-to-action',
    maxChars: 280,
    maxParagraphs: 1,
    pattern: /^(?:i|we)(?:['’](?:m|re)| am| are)\s+going to\s+(?:check|inspect|review|investigate|trace|look|run|test|verify|implement|update|change|fix|add|remove|read|open|fetch|compare|start|continue)\b/i,
  },
  {
    id: 'let-me-action',
    maxChars: 280,
    maxParagraphs: 1,
    pattern: /^let me\s+(?:check|inspect|review|investigate|trace|look|run|test|verify|implement|update|change|fix|add|remove|read|open|fetch|compare|start|continue)\b/i,
  },
  {
    id: 'next-action',
    maxChars: 280,
    maxParagraphs: 1,
    pattern: /^(?:i|we)(?:['’]ll| will)\s+(?:check|inspect|review|investigate|trace|look|run|test|verify|implement|update|change|fix|add|remove|read|open|fetch|compare|start|continue)\b/i,
  },
]);

export function classifyAssistantText(text) {
  const value = String(text ?? '').trim();
  const paragraphs = value === '' ? 0 : value.split(/\n\s*\n/).length;
  for (const rule of EPHEMERAL_ASSISTANT_TEXT_RULES) {
    if (value.length <= rule.maxChars && paragraphs <= rule.maxParagraphs && rule.pattern.test(value)) return rule.id;
  }
  return null;
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
  wrapper.__messageText = data.text;
  if (data.role !== 'user') {
    wrapper.__assistantTurnId = data.turnId;
    wrapper.__ephemeralRule = classifyAssistantText(data.text);
  }
  return wrapper;
}

// (D168, S25.5) Grows the bubble a `message.delta` started, in arrival order — the only
// order a frame carries (I51) — rather than replacing its text. `node` is whatever
// `renderEvent` returned for that `turnId`'s first delta.
export function appendMessageDeltaText(node, text) {
  const textNode = node.__messageTextNode;
  if (!textNode) return;
  // Grown from a plain field kept on `node`, not from reading `textNode.textContent`
  // back — a DOM `textContent` getter re-copies everything accumulated so far, which
  // would otherwise make every delta's cost proportional to the text seen up to that
  // point instead of to the delta itself.
  node.__messageText = (node.__messageText ?? '') + text;
  textNode.textContent = node.__messageText;
  if (node.__assistantTurnId !== undefined) node.__ephemeralRule = classifyAssistantText(node.__messageText);
}

// Returns whether this call hid the node. The node stays attached to the transcript and
// retains its text either way; normal/full therefore reveal the same node immediately.
export function applyAssistantMessageVerbosity(node, level) {
  const hidden = level === 'compact' && node.__ephemeralRule !== null && node.__ephemeralRule !== undefined;
  node.hidden = hidden;
  return hidden;
}

export function renderHiddenAssistantBlocks(doc, count) {
  const body = el(doc, 'div', 'message__hidden');
  const node = row(doc, 'assistant-hidden', 'agent', body);
  node.__hiddenCountNode = body;
  node.hidden = true;
  updateHiddenAssistantBlocks(node, count);
  return node;
}

export function updateHiddenAssistantBlocks(node, count) {
  const noun = count === 1 ? 'block' : 'blocks';
  node.__hiddenCountNode.textContent = `${count} narration ${noun} hidden`;
}

// D246: verbosity governs `thinking` text and `tool.call`/`tool.result` bodies via a
// native `<details>` fold — never the permission block, which is exempt (I12/S4.11) and
// built without one. `thinking` collapses at every level but Full; input/output collapse
// only at Compact.
function foldable(doc, label, contentNode, open) {
  const details = el(doc, 'details', 'fold');
  details.open = open;
  details.appendChild(el(doc, 'summary', 'fold__summary', label));
  details.appendChild(contentNode);
  return details;
}

function thinkingNode(doc, data, handlers) {
  const body = el(doc, 'div', 'thinking');
  const verbosity = (handlers && handlers.verbosity) || 'normal';
  const textNode = el(doc, 'div', 'thinking__text', data.text);
  body.appendChild(foldable(doc, 'thinking', textNode, verbosity === 'full'));
  return row(doc, 'thinking', 'thinking', body);
}

// Registers itself with `handlers.onToolCallRendered(callId, refs)` when given one, so a
// later `permission.request` sharing this `callId` can find and merge into this same row
// (D246) rather than rendering the input a second time.
function toolCallNode(doc, data, handlers) {
  const body = el(doc, 'div', 'tool');
  body.appendChild(el(doc, 'div', 'tool__name', data.name));
  if (data.summary) body.appendChild(el(doc, 'div', 'tool__summary', data.summary));
  const inputPre = el(doc, 'pre', 'tool__input', pretty(data.input));
  const verbosity = (handlers && handlers.verbosity) || 'normal';
  const fold = foldable(doc, 'input', inputPre, verbosity !== 'compact');
  body.appendChild(fold);
  if (handlers && handlers.onToolCallRendered) handlers.onToolCallRendered(data.callId, { body, fold, inputPre });
  return row(doc, 'tool-call', 'tool', body);
}

// S34.8: the renderer's own cap on diff lines shown inline, declared here and nowhere
// else — a diff past this length still states its full extent as a trailing count.
const DIFF_LINE_BOUND = 200;

function diffLineKind(line) {
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  return 'context';
}

// S34.2/S34.3/S34.6/S34.8: one element per hunk header, one per line — each line's own
// added/removed/context class carries the marking, and every line reaches the page
// through `el`'s `textContent` (never markup). No button, form or contenteditable
// appears anywhere in here; there is nothing here for an operator to act on (S34.6).
function toolResultDiffNode(doc, diff) {
  const container = el(doc, 'div', 'tool__diff');
  const totalLines = diff.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  let shown = 0;
  for (const hunk of diff.hunks) {
    if (shown >= DIFF_LINE_BOUND) break;
    const hunkNode = el(doc, 'div', 'tool__diff-hunk');
    hunkNode.appendChild(
      el(doc, 'div', 'tool__diff-hunk-header', `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`),
    );
    for (const line of hunk.lines) {
      if (shown >= DIFF_LINE_BOUND) break;
      hunkNode.appendChild(el(doc, 'div', `tool__diff-line tool__diff-line--${diffLineKind(line)}`, line));
      shown++;
    }
    container.appendChild(hunkNode);
  }
  if (totalLines > shown) container.appendChild(el(doc, 'div', 'tool__diff-more', `+${totalLines - shown} more lines`));
  return container;
}

// S9.2/Delivers: a truncated result's full bytes are one click away at the tool-output
// route. `sessionId` comes from `handlers` rather than `data` — it is not part of the
// wire vocabulary any event carries (I20) — so this is the one renderer that reads it.
//
// S34.5: a `diff: null` result renders exactly as it always has — the diff branch below
// is additive, never a replacement of this function's existing output path.
function toolResultNode(doc, data, handlers) {
  const body = el(doc, 'div', 'tool');
  const status = el(doc, 'div', 'tool__status', data.ok ? 'ok' : 'failed');
  body.appendChild(status);
  const verbosity = (handlers && handlers.verbosity) || 'normal';
  if (data.diff) {
    body.appendChild(foldable(doc, 'diff', toolResultDiffNode(doc, data.diff), verbosity !== 'compact'));
  } else {
    const outputPre = el(doc, 'pre', 'tool__output', data.output);
    body.appendChild(foldable(doc, 'output', outputPre, verbosity !== 'compact'));
  }
  if (data.truncated) {
    // S34.4: partiality comes from this same flag, not from inspecting the diff for a cut hunk.
    const truncatedText = data.diff ? `diff partial — ${data.bytes} bytes in full` : `truncated — ${data.bytes} bytes in full`;
    body.appendChild(el(doc, 'div', 'tool__truncated', truncatedText));
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

// A burst of notices or errors identical in every rendered field is one thing happening to
// an operator and N things in the audit log. `coalesceKey` decides that identity: equal keys
// are the same row, `null` is a kind that never collapses. Only `session.notice` and `error`
// return a key, because every other kind carries content of its own, and collapsing content
// hides information rather than repetition — D246's folds are how those stay compact.
//
// Adjacency is the rule, and it is deliberate: seventeen consecutive `task_progress` notices
// become one row reading `×17`, while the same notice recurring either side of a tool call
// stays two rows — the second occurrence is then telling the operator something the first
// did not. Nothing here touches the event log; every instance is still in `events.ndjson`.
export function coalesceKey(envelope) {
  if (envelope.kind === 'session.notice') {
    const data = envelope.data;
    return `session.notice ${data.level} ${data.code} ${data.text}`;
  }
  if (envelope.kind === 'error') {
    const data = envelope.data;
    return `error ${data.fatal ? 'fatal' : 'error'} ${data.kind} ${data.message ?? ''}`;
  }
  return null;
}

// Wraps an already-rendered row so later identical envelopes fold into it. The count badge
// and the instance list are created on the first `bump` rather than up front, so a notice
// that never repeats renders exactly as it did before this existed.
//
// Instances are listed by timestamp and nothing else: two envelopes reaching the same group
// are by construction identical in every other rendered field, so a timestamp is the whole
// of what distinguishes them.
export function createCoalesceGroup(doc, node, firstTs) {
  const timestamps = [firstTs];
  let count = null;
  let list = null;
  return {
    node,
    bump(ts) {
      timestamps.push(ts);
      if (count === null) {
        count = el(doc, 'span', 'event__count');
        node.appendChild(count);
        const details = el(doc, 'details', 'event__instances');
        details.appendChild(el(doc, 'summary', 'event__instances-summary', 'instances'));
        list = el(doc, 'ul', 'event__instances-list');
        details.appendChild(list);
        node.appendChild(details);
        list.appendChild(el(doc, 'li', 'event__instance', timestamps[0]));
      }
      count.textContent = `×${timestamps.length}`;
      list.appendChild(el(doc, 'li', 'event__instance', ts));
      return timestamps.length;
    },
  };
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

// S32.5/S32.7/S32.13: `unreached` is a restore's `RestoreResult.unreached` — `IgnoredDelta[]`
// or `null`. `null` means the comparison could not be made and renders as unknown; an empty
// array is the positive answer and renders distinguishably from it. Every path is untrusted
// (a workspace-relative filename an agent could have written) and reaches the document only
// through `el`'s `textContent`, never assembled markup.
export function renderUnreachedReport(doc, unreached) {
  const section = el(doc, 'div', 'restore-report');
  if (unreached === null) {
    section.appendChild(el(doc, 'p', 'restore-report__unknown', 'could not tell whether the rollback left anything standing'));
    return section;
  }
  if (unreached.length === 0) {
    section.appendChild(el(doc, 'p', 'restore-report__clean', 'nothing ignored was left standing'));
    return section;
  }
  const list = doc.createElement('ul');
  list.className = 'restore-report__list';
  for (const delta of unreached) {
    const item = el(doc, 'li', `restore-report__item restore-report__item--${delta.change}`);
    item.appendChild(el(doc, 'span', 'restore-report__change', delta.change));
    item.appendChild(el(doc, 'span', 'restore-report__path', delta.path));
    list.appendChild(item);
  }
  section.appendChild(list);
  return section;
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
//
// D246: a request sharing `callId` with an already-rendered `tool.call` merges into that
// row instead of drawing a second one — `handlers.getToolCallByCallId` finds it, and its
// folded input is unwrapped to a plain, always-visible `<pre>` (I12/S4.11: the permission
// prompt is exempt from every verbosity level, never just defaulted open). No match falls
// back to a standalone block with its own exact input, unfolded the same way.
function permissionRequestNode(doc, data, handlers) {
  const merged = handlers && handlers.getToolCallByCallId ? handlers.getToolCallByCallId(data.callId) : null;

  let body;
  if (merged) {
    body = merged.body;
    if (merged.fold.parentNode === body) body.replaceChild(merged.inputPre, merged.fold);
  } else {
    body = el(doc, 'div', 'permission');
    body.appendChild(el(doc, 'div', 'permission__tool', data.tool));
    body.appendChild(el(doc, 'pre', 'permission__input', pretty(data.input)));
  }

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

  return merged ? null : row(doc, 'permission', 'permission', body);
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

// Shared by `renderPayrollSummary`/`renderTokenBreakdown` below and `openTerminate` in
// app.js — all are a `<dl>` of label/value rows over the same `payroll-summary__*` classes,
// so all build a row here rather than each hand-rolling its own copy of the same
// three-element wrapper. Returns the `dd` node so a caller (S33.5's peak marker) can append
// to it; every existing caller ignores the return value.
export function renderSummaryRow(doc, dl, label, value) {
  const wrapper = el(doc, 'div', 'payroll-summary__row');
  const dd = el(doc, 'dd', 'payroll-summary__value', value);
  wrapper.appendChild(el(doc, 'dt', 'payroll-summary__label', label));
  wrapper.appendChild(dd);
  dl.appendChild(wrapper);
  return dd;
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
  // D248: the per-turn partition of the same burn, in the order the server sent it — the
  // fold's order is the spill's order and this is a pure read, so nothing is sorted, ranked
  // or re-summed here (I28). A turn that reported nothing still gets a row: `+0 tokens` next
  // to a turn that cost a hundred thousand is the comparison this list exists to make, and
  // that zero says "this turn reported nothing", never "this session reports nothing" — the
  // session-wide unknown is `session.notice / usage_unavailable` in the transcript (D146).
  if (Array.isArray(view.turns) && view.turns.length > 0) {
    let ordinal = 0;
    for (const turn of view.turns) {
      ordinal += 1;
      const total = turn.usage.inputTokens + turn.usage.outputTokens + turn.usage.cacheRead + turn.usage.cacheCreate;
      const open = turn.endedAt === null ? ' — still running' : '';
      renderSummaryRow(doc, dl, `Turn ${ordinal}`, `+${formatTokenCount(total)} tokens${open}`);
    }
  }
  return dl;
}

// S33.2: cache-hit versus cache-miss, derived from `cacheRead`/`cacheCreate` and nothing
// else — never from a third field, never inferred from the total.
function cacheHitMissLabel(burn) {
  if (burn.cacheRead === 0 && burn.cacheCreate === 0) return 'no cache activity';
  if (burn.cacheCreate === 0) return 'all cache hits';
  if (burn.cacheRead === 0) return 'all cache misses';
  return 'mixed cache hits and misses';
}

// S33: the fresh/output/cache-read/cache-write split of the same `burn` `renderPayrollSummary`
// above already totals, plus the per-turn input growth that drove it. `usageUnavailable` is
// this session's `session.notice / usage_unavailable` flag (D146) — the one thing this panel
// must refuse to guess at when it is set, so that branch renders nothing else at all rather
// than a set of components next to a truthful-looking zero (S33.7).
export function renderTokenBreakdown(doc, view, session, usageUnavailable) {
  const dl = el(doc, 'dl', 'payroll-summary payroll-breakdown');
  renderSummaryRow(doc, dl, 'Session', view.sessionId);
  if (session !== null) {
    renderSummaryRow(doc, dl, 'Agent', session.model ? `${session.vendor} · ${session.model}` : session.vendor);
  }
  if (usageUnavailable) {
    renderSummaryRow(doc, dl, 'Token usage', 'unavailable — this session’s transport does not report token usage');
    return dl;
  }
  // S33.4: stated outright rather than left to be inferred from the absence of a category
  // (S33.3) — one usage figure arrives per call with no attribution to what was in context
  // (D75, I28).
  renderSummaryRow(doc, dl, 'What this counts', 'these figures are what the transport reported as usage; the console cannot attribute them to what was in the model’s context');
  const { burn } = view;
  const total = burn.inputTokens + burn.outputTokens + burn.cacheRead + burn.cacheCreate;
  const share = (n) => (total === 0 ? 0 : Math.round((n / total) * 100));
  // S33.1: each figure is `burn`'s own field, formatted for display — the four sum to the
  // total exactly because nothing here is a rounded share fed back in as a count.
  renderSummaryRow(doc, dl, 'Fresh input', `${formatTokenCount(burn.inputTokens)} tokens (${share(burn.inputTokens)}%)`);
  renderSummaryRow(doc, dl, 'Output', `${formatTokenCount(burn.outputTokens)} tokens (${share(burn.outputTokens)}%)`);
  renderSummaryRow(doc, dl, 'Cache reads', `${formatTokenCount(burn.cacheRead)} tokens (${share(burn.cacheRead)}%)`);
  renderSummaryRow(doc, dl, 'Cache writes', `${formatTokenCount(burn.cacheCreate)} tokens (${share(burn.cacheCreate)}%)`);
  renderSummaryRow(doc, dl, 'Cache hit rate', cacheHitMissLabel(burn));
  // S33.5/S33.6: per-turn growth in `inputTokens`, in server order. A turn reporting no
  // usage at all (every component zero) renders a `+0` row and leaves the running baseline
  // where the last non-zero turn left it, rather than either vanishing or resetting growth
  // to look like it started over.
  if (Array.isArray(view.turns) && view.turns.length > 0) {
    let baseline = 0;
    const deltas = [];
    for (const turn of view.turns) {
      const u = turn.usage;
      const isZero = u.inputTokens === 0 && u.outputTokens === 0 && u.cacheRead === 0 && u.cacheCreate === 0;
      if (isZero) {
        deltas.push(0);
      } else {
        deltas.push(u.inputTokens - baseline);
        baseline = u.inputTokens;
      }
    }
    const peakIndex = deltas.reduce((best, d, i) => (d > deltas[best] ? i : best), 0);
    deltas.forEach((delta, i) => {
      const dd = renderSummaryRow(doc, dl, `Turn ${i + 1} input growth`, `+${formatTokenCount(delta)} tokens`);
      if (i === peakIndex) dd.appendChild(el(doc, 'span', 'payroll-breakdown__peak', 'PEAK'));
    });
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
 * `handlers` is optional. `verbosity` reaches `thinking`, `tool.call` and `tool.result`;
 * `sessionId` reaches `tool.result`; `onToolCallRendered`/`getToolCallByCallId` join
 * `tool.call` and `permission.request` by `callId` (D246); the rest ignore it.
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
