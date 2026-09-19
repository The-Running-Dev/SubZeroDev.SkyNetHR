# Runtime-redesign brief — item-by-item feasibility classification

Written against the tree at `32132a5`, by inspection of `src/agent-console/providers/claude-cli/index.ts`,
`src/agent-console/providers/codex-cli/index.ts`, `src/agent-console/core/index.ts`,
`src/agent-console/store/fs.ts`, `src/session-manager/`, and `client/`. Not authoritative:
`design/20-contract.md` and `design/30-slices.md` outrank this. It exists to record **which layer
owns each behaviour**, because that, not effort, is what decides whether an item is reachable.

## The boundary this whole document turns on

**SkyNetHR does not assemble model context.** It spawns a vendor CLI as a child process and writes
the operator's message to that child's stdin:

- `claude -p --output-format stream-json --input-format stream-json --verbose --permission-prompt-tool
  stdio [--model M] [--resume <cliSessionId>]` (`providers/claude-cli/index.ts`, `buildArgs`), with one
  `user` record per turn.
- `codex app-server`, `thread/start` / `thread/resume` with `approvalPolicy: never`
  (`providers/codex-cli/index.ts`).

What crosses that boundary **into** the model is: the operator's text, its attachments, a model id, and a
resume handle. Nothing else. The CLI owns the system prompt, the conversation history, its own
compaction, its tool definitions, **tool execution**, tool-result injection, subagent spawning, and every
retry. SkyNet observes the result stream and normalises it into envelopes.

So the brief's founding principle splits cleanly in two, and the split is not cosmetic:

| | Owner | Status |
|---|---|---|
| **Runtime state is a derived projection of events** | SkyNet | Already true, and extensible. `PayrollView` is a fold over the spill with no running counter (D147); the transcript is rendered from replayed envelopes. |
| **Model context is a derived projection of SkyNet's events** | the vendor CLI | **Not achievable at this boundary, at any effort.** SkyNet can decide *whether* a turn happens and *what one operator message says*; it cannot decide what history the CLI replays alongside it. |

Every "requires owning model-context assembly" verdict below is that second row, and nothing else.
Where an item is graded *partially implementable*, the observable half is real and worth shipping — but
shipping it must not be reported as having delivered the token guarantee.

**Two further boundary facts, both load-bearing, both verified rather than assumed:**

1. **SkyNet is in Claude's tool-approval path, and is not in Codex's.** The Claude adapter answers
   `control_request` / `can_use_tool` with an allow-or-deny `control_response`
   (`claude-cli/index.ts`). The Codex adapter launches with `approvalPolicy: never`, and an approval
   request arriving anyway is declined as an anomaly. Anything built on the approval hook is therefore
   **Claude-only**, which collides with the provider-neutrality constraint.
2. **The approval hook does not fire for the calls the brief wants deduplicated.**
   `design/findings/S26-real-permission-round-trip.md` records, against the real installed CLI, that
   `can_use_tool` fires for `Write`, `Edit` and side-effecting `Bash`, and **does not fire for `Read` or
   a side-effect-free `Bash`**. The brief's own dedup examples are `cat`, `grep`, `git status`, `wc`,
   `find` — every one of them the case that never reaches SkyNet.

---

## Category 1 — Implementable now, wholly inside SkyNet

These need no vendor cooperation. They are folds, storage, or rendering.

| # | Item | Notes |
|---|---|---|
| 10 | Subagent lifecycle events | **Shipped** (PR #406). Five `task_*` codes on `SessionNoticeCode`. |
| 12 | Tool-output virtualization (SkyNet's half) | **Shipped in part** (S9/S23/D162): full output persisted per `turnId`/`callId`, `truncated`/`bytes` on the envelope, a download route, a per-session byte budget. What is missing is *indexed* access — search, read-range, read-section. All of that is SkyNet-side and buildable. |
| 13 | Runtime-enforced output limits | **Shipped in part**: a byte limit and an explicit `truncated` flag exist. A *token* estimate does not. |
| 15 | Operator / Tools / Debug / Raw views | D246 shipped three verbosity levels over one transcript. A view *selector* over the same replayed envelopes is more of the same mechanism. |
| 16 | Diff rendering | Pure client. Constrained by the `textContent`-only invariant in `client/render.js` — a diff view must be built from elements, never assembled markup. |
| 17 | Hide command JSON | **Shipped** (D246 folds). |
| 18 | Auto-collapse successful read-only operations | **Shipped in substance** (D246). Refinement is per-tool policy, still pure client. |
| 19 | Aggregate repetitive errors | **Shipped** (PR #407): adjacency coalescing with a count badge; every instance retained. |
| 20 | Sticky session header | Every field is SkyNet-owned or already in `PayrollView`/`SessionRecord`. |
| 21 | **Per-turn token deltas** | **This slice** (D248): `PayrollView` gains the per-turn partition of `burn`. |
| 23 | Token attribution visualization | Buildable **only over categories SkyNet can measure** — see item 22, which is the honest limit. |
| 24 | Session/workflow budgets | `Config.sessionTokenBudget` and `remainingTokens` exist (D129). Warn / soft-stop / hard-stop thresholds, and a budget crossing as an explicit event, are SkyNet's to add. Per-*model-call* budgets are not — the CLI makes those calls. |
| 28 | First-class blocked state | SkyNet already has a turn state machine and a permission-pending state. A `blocked` state with a surfaced question is the same machinery. |
| 29 | Human-readable session names | A `SessionRecord` field plus a rename route. Wholly SkyNet's. |
| 30 | Rich session-list metadata | Same; every candidate field already exists or is a fold away. |
| 34 | Repository index | Deterministic code over the workspace root, inside the existing jail. Useful to SkyNet's *own* UI without any model involvement. |
| 36, 37 | Machine-classify install state / machine-check inventory | **Not runtime work at all** — this belongs in AgentKit's `tools/`, not in SkyNetHR. Listed only so the classification is exhaustive. |

## Category 2 — Partially implementable: observable, not controllable

For each of these SkyNet can **measure and display** the phenomenon, and cannot **prevent** it. This is
the category most at risk of being mis-reported, so each row states the split.

| # | Item | Observable (ship this) | Not controllable (say so) |
|---|---|---|---|
| 3 | Duplicate tool-call suppression | Count repeated identical `tool.call` envelopes within a session and surface a diagnostic. | Cannot suppress. Tool execution is inside the CLI, and per boundary fact 2 the read-only calls the brief names never reach the approval hook at all. |
| 9 | Session-scoped permission policies | Standing rules already exist (S10 grammar) and reduce operator round trips. | Reduces *ceremony*, not *tokens* — and only on Claude (boundary fact 1). Codex runs with `approvalPolicy: never`, so its "policy" is the sandbox, decided once at `thread/start`. |
| 22 | Categorize token costs | The four `Usage` components are real and measured: input, output, cache-read, cache-create. Cache-hit versus cache-miss is genuinely derivable from those. | `system/instructions`, `historical conversation`, `project docs`, `file reads`, `subagents` are **not measurable** — the CLI reports one usage figure per call and no attribution. The brief itself says not to claim unmeasurable categories; this is that case, and inventing them would be the fabricated-savings failure the acceptance criteria forbid. |
| 25 | Context-growth diagnostics | Per-turn input-token growth is measurable, and D248 makes the deltas readable. A turn whose input jumped 42K is visible. | The *why* — which 31K was `INSTALL.md` — is not. SkyNet never saw the context. |
| 31 | Ephemeral agent status messages | SkyNet can mark narration ephemeral in its own transcript and exclude it from what *it* renders. | Cannot keep it out of the model's context; the CLI already has it, and it is the CLI's own output. |
| 39 | Orchestration-loop detection | Repeated identical `tool.call` sequences are visible in the spill; a diagnostic is straightforwardly foldable. | Diagnostic only. The brief explicitly allows this ("initially be diagnostic before becoming enforcement") — enforcement is Category 3. |

## Category 3 — Requires SkyNet to own model-context assembly, or a different vendor boundary

Not "hard". **Structurally unreachable** while a vendor CLI owns the conversation. Each would require
SkyNet to call the model API directly and run its own agent loop — which the handoff's own constraints
rule out ("preserve the CLI subprocess architecture").

| # | Item | Why it cannot be reached here |
|---|---|---|
| 1 | Separate audit from model transcript | The model transcript is the CLI's, held in the CLI's own session store and replayed by `--resume`. SkyNet has no write access to it. |
| 2 | Content-addressed file-read cache | SkyNet would have to intercept the model's `Read` and substitute a reference. `Read` does not reach the approval hook, and the hook cannot return a *result* — only allow or deny. |
| 4 | Cached full-read contracts | The same mechanism as 2, plus it requires the model to understand a reference in place of content, which means owning the prompt. |
| 5 | Structured session state *as model input* | The *state object* is Category 1 — SkyNet can build and display it. Feeding it to the model **instead of** conversational history is Category 3. **This split is the single easiest one to blur and must not be.** |
| 6 | Blocking questions that actually block | Split. SkyNet **can** hold a turn blocked and refuse to advance its own workflow (Category 1, item 28). It **cannot** stop the model, mid-turn, from inventing an answer and continuing — that loop is inside the CLI. The observed failure was the inner agent's, not SkyNet's. |
| 7 | Collapse tool/permission/tool/result *in model context* | The **rendering** half is shipped (D246: the permission request merged into the `tool.call` row by `callId`). The model-context half is the CLI's. |
| 8 | Remove permission mechanics from model context | Worth checking empirically whether SkyNet's `control_response` payload contributes any tokens at all — if it does not, the item is already satisfied and needs no work. Otherwise unreachable. |
| 11 | No giant instructions duplicated in subagent prompts | Subagents are spawned by the CLI. SkyNet does not compose their prompts and does not see them. |
| 14 | Turn token guidance into enforcement | Enforcement means gating what reaches the model. |
| 26 | Automatic checkpoint compaction (of context) | SkyNet's checkpoints are **git checkpoints of the workspace** (`ckpt.git`), not context checkpoints. Compacting model context is the CLI's own compaction, which SkyNet only observes (`session.notice / compaction`). |
| 27 | Checkpoints as context boundaries | The same. Restoring a context projection presumes owning one. |
| 32 | Result ledger *consumed by the model* | Building the ledger is Category 1. Getting the model to read it instead of re-running the command is Category 3. |
| 33 | Dependency-aware cache invalidation | Presupposes the cache in 2 and 32 being model-visible. |
| 35 | Section-aware Markdown retrieval | SkyNet can index and serve sections to **itself** (Category 1). Making the model retrieve sections instead of whole files means owning its tool set. |
| 38 | Reasoning models only for genuine forks | An agent-design rule, not a runtime feature. It belongs to AgentKit's command prose. |
| 40 | "Read once, reason many" as a runtime invariant | The invariant's subject is model context. See the boundary table. |

## The one lever that would move items between categories without abandoning the CLI

Claude Code supports **hooks** (`PreToolUse`, `PostToolUse`) and a settings file. SkyNet spawns `claude`
today with **no settings injection at all** — no `--settings`, no hook configuration (verified by grep
over `claude-cli/index.ts` and `process/`). A `PreToolUse` hook can deny *or substitute*, and a
`PostToolUse` hook sees the result. That is a genuinely different lever from `--permission-prompt-tool`,
and it would plausibly move items 2, 3 and 12's suppression half from Category 3 to Category 2 or 1 —
**on Claude only**.

It is recorded here as the one identified path, not recommended: it is a real architectural fork
(provider-neutrality, and coupling to one vendor's hook schema), so it is the user's call and belongs in
a decision, not in a slice. Nothing in this document acts on it.

## What this means for delivery order

The brief's own Phase A is measure-and-expose, and that phase is **entirely Category 1** — which is why
it is the right place to be. Per-turn token deltas (item 21, D248) are the first of it. Phases B, C and
most of E and G are dominated by Category 3, and attempting them at this boundary would produce UI that
looks like the brief while delivering none of its token guarantee.
