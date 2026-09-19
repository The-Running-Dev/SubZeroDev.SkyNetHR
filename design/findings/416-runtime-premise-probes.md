# #416 — PreToolUse substitution and permission tokens

## Measured boundary

Run on Linux with the real Claude Code **2.1.278**, Node 24.19.0, and SkyNetHR
`6b0534b` plus the two harness files in this change. This is a probe, not a slice.
The earlier S26 finding used 2.1.228; these results do not claim a run of that version
or of the operator's Windows installation.

`harness/run-416-probes.mjs` follows `run-s26-multi.mjs`: real store, manager,
subscription, adapter, and `answerPermission`. The existing executable seam points
to a byte-forwarding capture bridge. Only the harness supplies isolated settings
and a local Messages API; no production source or dependency changes.

The API supplies a deterministic tool call and final reply. Claude Code itself
runs the hooks, executes the tools, handles permissions, persists/resumes the
conversation, and constructs the captured model-bound requests. This measures
the client protocol and context boundary. **No hosted model ran; no vendor token
count or bill was measured.** API usage numbers are synthetic protocol fields and
are never used as evidence. The capture contains request bodies, not auth headers.

## (a) Can PreToolUse substitute a result?

**No direct result-substitution interface was found or demonstrated.** The
[documented PreToolUse output](https://code.claude.com/docs/en/hooks#pretooluse-decision-control)
supports decisions, input rewriting, and additional context. Result replacement is
documented under PostToolUse; that happens after execution and was not tested here.

| Read hook output | Captured model-bound result |
|---|---|
| Allow | Original file content; successful result |
| Allow plus `updatedToolOutput: "PROBE_SUBSTITUTE_RESULT"` | Original content; candidate field did not replace it |
| Deny with marker as reason | Marker in `tool_result`, **`is_error: true`** |
| Allow plus `updatedInput` pointing to a cached file | Cached file content; successful result from the redirected Read |

Every hook fired exactly once. Denial did not provide a successful substitute;
input rewriting selected a different file to read. The negative experiment tests
the named candidate field, not every imaginable undocumented field. Together with
the documented interface it supports a narrow “no supported direct substitution”
answer, not a universal claim about all hook-based workarounds.

## (b) Does control_response cost model tokens?

**The permission protocol envelope is not model context in the tested flows.**

- Automatic Write approval and SkyNet's interactive allow each made two model
  requests: the initial tool-call request and one continuation. Interactive allow
  had exactly one real `can_use_tool` / `control_response` pair; automatic approval
  had none. After normalizing the scratch workspace path, their continuation
  message histories were identical. System context and tool definitions remained
  unchanged across the interactive exchange.
- SkyNet's deny includes `interrupt: true`. It stopped before a continuation
  request and did not write the file. On explicit resume, the rejection became an
  error `tool_result` in the next model request. Its text was CLI-generated, not
  the raw `control_response` JSON or the operator's audit reason.
- Both flows excluded control record types, permission request IDs, and the
  harness audit-reason marker from captured model requests.

**Inference from the captured inputs:** the allow round trip adds no model-input
tokens or extra model call. Denial contributes model-visible rejection text on
resume, which is tokenizable input. This is not a numeric billing measurement;
the extra token count was not measured. Brief item 8 cannot be called blanket
“already satisfied” without distinguishing protocol mechanics from denial content.
No classification, policy, contract, or redesign decision is made here.

## Reproduce and inspect

```sh
npm ci
npm run build
node harness/run-416-probes.mjs /absolute/path/to/claude
```

Use the actual executable (`claude.exe` on Windows), not an npm `.cmd` shim.
The harness needs no account or real API key. It creates a fresh temporary tree,
retains raw CLI wire, hook input/output, model request bodies, events and stderr,
and prints that location. It exits nonzero on any unmet observation or timeout.
The committed [evidence summary](416-runtime-premise-evidence.json) retains the
observed results, control frames, and comparison hashes; temporary paths are
normalized to `<probe-root>`. Full vendor system prompts are not committed.

Validation: build passed; seven probe cases passed; existing Claude adapter tests
passed (17 passed, one Windows-only test skipped). Windows execution, hosted-model
billing, browser tests, PowerShell checks, and the complete application suite were
not run locally. None of the last three surfaces is changed by this probe.
