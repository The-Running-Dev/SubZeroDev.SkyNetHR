# Runtime-redesign brief — item-by-item feasibility classification

Written against the tree at `32132a5`, audited against `6c38f93`. Not authoritative:
`design/20-contract.md` and `design/30-slices.md` outrank this. It exists to record **which layer
owns each behaviour**, because that, not effort, is what decides whether an item is reachable.

## How to read a verdict

Every row carries an evidence class, because the first version of this document stated
inferences in the same voice as source readings and at least three of them were wrong
(*Corrections*, below). The class says what backs the verdict, not how confident it sounds:

| | Class | Meaning |
|---|---|---|
| **S** | Source | Read in the tree or in a probe finding, and cited. A reader can check it. |
| **I** | Inferred | Follows from a class-S boundary fact, but this specific item was not separately checked. Sound only if the boundary fact is. |
| **A** | Assumed | No check was performed. Stated here so it can be attacked rather than inherited. |

**A class-I or class-A row is not a finding.** Treat it as a hypothesis with a citation
attached to its premise, and do not build a slice on one without promoting it to S first.

## The boundary this whole document turns on

**SkyNetHR does not assemble model context.** It spawns a vendor CLI as a child process and writes
the operator's message to that child's stdin.

- **[S]** `claude -p --output-format stream-json --input-format stream-json --verbose
  --permission-prompt-tool stdio [--model M] [--resume <id>] [--include-partial-messages]` —
  `providers/claude-cli/index.ts`, `buildArgs`. That list is exhaustive; there is no other argv path.
- **[S]** `codex app-server`, `thread/start` / `thread/resume` with `approvalPolicy: 'never'` —
  `providers/codex-cli/index.ts`.
- **[S]** `send()` forwards the operator's text and attachments and nothing else
  (`claude-cli/index.ts`).

What crosses that boundary **into** the model is: the operator's text, its attachments, a model id, and a
resume handle. The CLI owns the system prompt, the conversation history, its own compaction, its tool
definitions, **tool execution**, tool-result injection, subagent spawning, and every retry. SkyNet
observes the result stream and normalises it into envelopes.

So the brief's founding principle splits cleanly in two, and the split is not cosmetic:

| | Owner | Status |
|---|---|---|
| **Runtime state is a derived projection of events** | SkyNet | **[S]** Already true, and extensible. `PayrollView` is a fold over the spill with no running counter (D147); the transcript is rendered from replayed envelopes. |
| **Model context is a derived projection of SkyNet's events** | the vendor CLI | **[I]** Not achievable at this boundary. SkyNet can decide *whether* a turn happens and *what one operator message says*; nothing in the argv or the stdin record lets it decide what history the CLI replays alongside it. |

Every "requires owning model-context assembly" verdict below is that second row, and nothing else.
Where an item is graded *partially implementable*, the observable half is real and worth shipping — but
shipping it must not be reported as having delivered the token guarantee.

**Three further boundary facts, all class-S:**

1. **SkyNet is in Claude's tool-approval path, and is not in Codex's.** The Claude adapter answers
   `control_request` / `can_use_tool` with an allow-or-deny `control_response`. The Codex adapter
   launches with `approvalPolicy: 'never'` (`codex-cli/index.ts`), and an approval request arriving
   anyway is declined as an anomaly. Anything built on the approval hook is therefore **Claude-only**,
   which collides with the provider-neutrality constraint.
2. **The approval hook does not fire for the calls the brief wants deduplicated.**
   `design/findings/S26-real-permission-round-trip.md` records, against the real installed CLI, that
   `can_use_tool` fires for `Write`, `Edit` and side-effecting `Bash`, and **does not fire for `Read` or
   a side-effect-free `Bash`** — the CLI decides by whether the specific invocation has a side effect,
   not by tool name. The brief's own dedup examples are `cat`, `grep`, `git status`, `wc`, `find` —
   every one of them the case that never reaches SkyNet.
3. **The spawned CLI inherits the host environment, so host-level hooks already run inside it.**
   `buildEnvironment` defaults to `mode: 'inherit'` and, even in `constructed` mode, keeps `HOME`,
   `USERPROFILE`, `APPDATA` and `LOCALAPPDATA` (`process/environment.ts`); `claude-cli/index.ts`
   overrides only `FORCE_COLOR` and `NO_COLOR`. SkyNet's own captured fixtures show the consequence:
   `hook_started` / `hook_response` records with `hook_name: "SessionStart:startup"`
   (`providers/claude-cli/fixtures/usage-probe-bash.ndjson`), parsed by the adapter
   (`claude-cli/index.ts`). **Hooks are not a future option. They are already executing, configured by
   the host account, invisible to SkyNet except for those two record types.**

---

## Category 1 — Implementable now, wholly inside SkyNet

These need no vendor cooperation. They are folds, storage, or rendering. **18 brief items in 17 rows**
— items 36 and 37 share one. The three categories are 18 + 6 + 16 = 40, exhaustive and disjoint. The
first version of this document reported "17 items" for this category, counting rows rather than items.

| # | Item | Class | Notes |
|---|---|---|---|
| 10 | Subagent lifecycle events | **S** | **Shipped** (PR #406). Five `task_*` codes on `SessionNoticeCode` (`agent-console/contract/index.ts`). |
| 12 | Tool-output virtualization | **S** shipped half / **I** missing half | Full output persisted per `turnId`/`callId` with a per-session byte budget (`store/fs.ts`, D162/S23); `truncated` and pre-truncation `bytes` on the envelope (`agent-console/contract/index.ts`); a fetch route answering `no_such_output` (`edge/http-common/index.ts`). Missing: *indexed* access — search, read-range, read-section. **I** because absence was established by grepping the route layer, not by enumerating it. |
| 13 | Runtime-enforced output limits | **S** / **I** | A byte limit and an explicit `truncated` flag exist. No *token* estimate was found; that absence is **I**, not separately grepped. |
| 15 | Operator / Tools / Debug / Raw views | **S** / **I** | D246 shipped three verbosity levels over one transcript (`client/render.js`). That a view *selector* is the same mechanism is a judgement. |
| 16 | Diff rendering | **S** | Pure client. The `textContent`-only invariant holds — the sole `innerHTML` occurrence in `client/render.js` is the comment asserting there is none. A diff view must be built from elements. |
| 17 | Hide command JSON | **S** | **Shipped** (D246: the `input` body is folded by verbosity). |
| 18 | Auto-collapse successful read-only operations | **S** / **I** | **Shipped in substance** (D246 defaults `input`/`output` folds closed at `compact`). Per-tool policy refinement is a judgement. |
| 19 | Aggregate repetitive errors | **S** | **Shipped** (PR #407): adjacency coalescing with a count badge; every instance retained. |
| 20 | Sticky session header | **I** | Candidate fields exist across `SessionRecord` and `PayrollView`, but the brief's field list was not checked one by one against them. |
| 21 | **Per-turn token deltas** | **S** | **Shipped** (D248, PR #412): `PayrollView` gains the per-turn partition of `burn`. |
| 23 | Token attribution visualization | **S** | Buildable **only over categories SkyNet can measure** — see item 22, which is the honest limit. |
| 24 | Session/workflow budgets | **S** / **I** | `Config.sessionTokenBudget` and `PayrollView.remainingTokens` exist (`src/contract/index.ts`, D129). Warn / soft-stop / hard-stop thresholds, and a budget crossing as an explicit event, are SkyNet's to add (**I**). Per-*model-call* budgets are not — the CLI makes those calls. |
| 28 | First-class blocked state | **S** / **I** | A turn state machine (`TurnStopReason`) and a permission-pending path (`PermissionRequest`) both exist. That a `blocked` state is the same machinery is a judgement. |
| 29 | Human-readable session names | **S** | `SessionRecord` carries no name field today (`src/contract/index.ts`). Adding one plus a rename route is wholly SkyNet's. |
| 30 | Rich session-list metadata | **I** | Same shape as 29; the specific field list was not checked. |
| 34 | Repository index | **I** | A workspace-root jail exists (`src/jail/`). That a deterministic index inside it is useful to SkyNet's own UI without model involvement is a judgement. |
| 36, 37 | Machine-classify install state / machine-check inventory | **I** | **Not runtime work at all** — this belongs in AgentKit's `tools/`, not in SkyNetHR. Listed only so the classification is exhaustive. |

## Category 2 — Partially implementable: observable, not controllable

For each of these SkyNet can **measure and display** the phenomenon, and cannot **prevent** it. This is
the category most at risk of being mis-reported, so each row states the split.

| # | Item | Observable (ship this) | Not controllable (say so) | Class |
|---|---|---|---|---|
| 3 | Duplicate tool-call suppression | Count repeated identical `tool.call` envelopes within a session and surface a diagnostic. | Cannot suppress. Tool execution is inside the CLI, and per boundary fact 2 the read-only calls the brief names never reach the approval hook at all. | **S** for the split; **I** that a diagnostic fold is straightforward |
| 9 | Session-scoped permission policies | Standing rules already exist (`StandingRuleExpression`, `ResolvedScope`, S10 grammar) and reduce operator round trips. | Reduces *ceremony*, not *tokens* — and only on Claude (boundary fact 1). Codex runs `approvalPolicy: 'never'`, so its "policy" is the sandbox, decided once at `thread/start`. | **S** |
| 22 | Categorize token costs | The four `Usage` components are real and measured: input, output, cache-read, cache-create. Cache-hit versus cache-miss is derivable from those. | `system/instructions`, `historical conversation`, `project docs`, `file reads`, `subagents` are **not attributable** — the adapters normalise one usage figure per call (D75/I28) and no attribution accompanies it. Inventing them would be the fabricated-savings failure the acceptance criteria forbid. | **S** measured half; **I** unattributable half |
| 25 | Context-growth diagnostics | Per-turn input-token growth is measured, and D248 makes the deltas readable. A turn whose input jumped 42K is visible. | The *why* — which 31K was `INSTALL.md` — is not. SkyNet never saw the context. | **S** / **I** |
| 31 | Ephemeral agent status messages | SkyNet can mark narration ephemeral in its own transcript and exclude it from what *it* renders. | Cannot keep it out of the model's context; the CLI already has it, and it is the CLI's own output. | **I** |
| 39 | Orchestration-loop detection | Repeated identical `tool.call` sequences are visible in the spill; a diagnostic is foldable. | Diagnostic only. The brief explicitly allows this ("initially be diagnostic before becoming enforcement") — enforcement is Category 3. | **I** |

## Category 3 — Requires SkyNet to own model-context assembly, or a different vendor boundary

Not "hard". **Structurally unreachable** while a vendor CLI owns the conversation — subject to the hook
question below, which two of these rows depend on.

| # | Item | Why it cannot be reached here | Class |
|---|---|---|---|
| 1 | Separate audit from model transcript | The model transcript is the CLI's, held in the CLI's own session store and replayed by `--resume`. SkyNet does not write it, and doing so would mean editing another process's private store. **Corrected**: the first version said SkyNet "has no write access", which was never checked and is probably false on disk — the objection is that it is not a supported interface, not that the bytes are unreachable. | **I** |
| 2 | Content-addressed file-read cache | SkyNet would have to intercept the model's `Read` and substitute a reference. `Read` does not reach the approval hook (fact 2, **S**), and `control_response` is allow-or-deny (**S**). Whether a `PreToolUse` hook can substitute a *result* is **unverified** and is the whole question. | **S** premise / **A** the lever |
| 4 | Cached full-read contracts | The same mechanism as 2, plus it requires the model to understand a reference in place of content, which means owning the prompt. | **I** |
| 5 | Structured session state *as model input* | The *state object* is Category 1 — SkyNet can build and display it. Feeding it to the model **instead of** conversational history is Category 3. **This split is the single easiest one to blur and must not be.** | **S** split |
| 6 | Blocking questions that actually block | Split. SkyNet **can** hold a turn blocked and refuse to advance its own workflow (item 28). It **cannot** stop the model, mid-turn, from inventing an answer and continuing — that loop is inside the CLI. | **I** |
| 7 | Collapse tool/permission/tool/result *in model context* | The **rendering** half is shipped (D246: permission request merged into the `tool.call` row by `callId`). The model-context half is the CLI's. | **S** / **I** |
| 8 | Remove permission mechanics from model context | **Never measured.** Whether SkyNet's `control_response` round trip contributes any model tokens at all is unknown; if it does not, this item is already satisfied and needs no work. One probe settles it. | **A** |
| 11 | No giant instructions duplicated in subagent prompts | Subagents are spawned by the CLI. PR #406 surfaces their *lifecycle*, not their prompts, so SkyNet neither composes nor sees them. | **S** / **I** |
| 14 | Turn token guidance into enforcement | Enforcement means gating what reaches the model. | **I** |
| 26 | Automatic checkpoint compaction (of context) | SkyNet's checkpoints are **git checkpoints of the workspace** (`extensions/checkpoints/index.ts`, `ckpt.git`), not context checkpoints. Compacting model context is the CLI's own compaction, which SkyNet only observes (`session.notice / compaction`). | **S** |
| 27 | Checkpoints as context boundaries | The same. Restoring a context projection presumes owning one. | **I** |
| 32 | Result ledger *consumed by the model* | Building the ledger is Category 1. Getting the model to read it instead of re-running the command is Category 3. | **I** |
| 33 | Dependency-aware cache invalidation | Presupposes the cache in 2 and 32 being model-visible. | **I** |
| 35 | Section-aware Markdown retrieval | SkyNet can index and serve sections to **itself** (Category 1). Making the model retrieve sections instead of whole files means owning its tool set. | **I** |
| 38 | Reasoning models only for genuine forks | An agent-design rule, not a runtime feature. It belongs to AgentKit's command prose. | **I** |
| 40 | "Read once, reason many" as a runtime invariant | The invariant's subject is model context. See the boundary table. | **I** |

## The hook question

The first version of this document called Claude Code hooks "the one lever that would move items between
categories", and said SkyNet spawns `claude` with "no hook configuration". **That was wrong**, and the
correction cuts both ways (boundary fact 3): SkyNet injects no settings of its own, but the child
inherits the host environment and **host-level hooks already run inside every SkyNet-spawned session**.

Two consequences, and neither is a recommendation:

- **A risk that exists today.** Host-level hook configuration can already alter what happens inside a
  SkyNet session — including, in principle, blocking or rewriting tool calls — through a path SkyNet
  does not own, does not audit, and surfaces only as `hook_started` / `hook_response` records it
  currently parses but does not persist as first-class events. Whether that matters is a security
  question this document does not answer.
- **A lever whose key capability is unverified.** A `PreToolUse` hook that can *substitute* a result,
  rather than only deny a call, would move items 2, 3 and 12's suppression half. Whether it can is
  **class A** — unchecked against the installed CLI. It is also Claude-only, so it trades
  provider-neutrality for a capability nobody has confirmed exists.

**The next step here is a probe, not a slice**, and the S26 harness is the pattern for it. Nothing in
this document acts on either consequence.

## Corrections to the first version

Recorded rather than silently edited, because the failure mode was uniform confidence, and a reader who
took the first version at face value should be able to see exactly what they inherited.

1. **"SkyNet spawns `claude` with no hook configuration at all."** False as stated. SkyNet injects none;
   the child inherits `HOME`/`USERPROFILE` and runs the host's hooks, which SkyNet's own fixtures show
   firing. See boundary fact 3.
2. **"A `PreToolUse` hook can deny *or substitute*."** Never verified. It was the load-bearing premise of
   the entire "one lever" section and is now marked class A.
3. **"SkyNet has no write access to the CLI's session store" (item 1).** Never checked, and probably
   false at the filesystem level. The real objection is narrower and is now stated as such.
4. **Item 8's premise** — that `control_response` costs model tokens — was presented as a reason for a
   Category 3 verdict. It is unmeasured, and the verdict now says so.
5. **The headline count.** Category 1 was reported as "17 items". It is 18 items in 17 rows, because
   items 36 and 37 share a row. The category totals now sum to 40 explicitly.

## What this means for delivery order

The brief's own Phase A is measure-and-expose, and that phase is **entirely Category 1** — which is why
it is the right place to be. Per-turn token deltas (item 21, D248) are the first of it. Phases B, C and
most of E and G are dominated by Category 3, and attempting them at this boundary would produce UI that
looks like the brief while delivering none of its token guarantee.
