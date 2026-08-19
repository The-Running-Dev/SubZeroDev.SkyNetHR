# S21 finding — does the Claude CLI accept non-text content blocks?

Written before any transport code, per S21.1 (`design/30-slices.md § S21`). Probed against the
real, installed CLI — `claude` 2.1.227 — from a scratch directory, not against a fixture.

## Method

A Node script spawned `claude -p --output-format stream-json --input-format stream-json --verbose
--permission-prompt-tool stdio --dangerously-skip-permissions` and wrote one `user` record to
stdin whose `message.content` array held two blocks: a `text` block asking the model to name the
dominant colour, and an `image` block (`{ type: 'image', source: { type: 'base64', media_type:
'image/png', data: <base64> } }`) — the same content-block shape the adapter already writes for
text (`src/adapters/claude/index.ts`, `buildArgs`/`send`), extended with the block Anthropic's API
documents for images.

Two runs:

1. **A 1×1 red-pixel PNG (68 bytes).** The CLI accepted the record, forwarded it, and the API
   returned a normal completion turn (`is_error: false`, `stop_reason: "end_turn"`) — but the
   assistant's first content block was an `is_api_error_message: true` notice: `"API Error: an
   image in the conversation could not be processed and was removed."` This is a degenerate-image
   rejection, not a transport rejection: the record shape was accepted and the turn completed
   normally around it.
2. **A real PNG screenshot**, same script, same shape, `media_type: 'image/png'`. The CLI accepted
   the record, forwarded it, and the model answered `"Blue."` — the correct dominant colour of the
   screenshot — with `is_error: false`, `stop_reason: "end_turn"`, no error block.

## Answer

**Yes.** `claude --input-format stream-json` accepts a `user` message whose `content` array holds
a non-text block. An `image` block with valid image bytes is read, forwarded to the API, and
answered correctly. A degenerate image (run 1) is rejected by the vision pipeline with an inline
error content block on an otherwise-normal turn — the CLI does not reject the *record*, and the
turn does not fail — so a malformed or corrupt attachment surfaces to the operator as assistant
text on a completed turn rather than as a transport failure. Nothing here changes the outbound
record shape the adapter already writes for text: the `image` block is added to the same
`content` array, alongside the existing `{ type: 'text', text }` entry.

## Consequence for this slice

S21.1 is satisfied and the slice proceeds. `AttachmentPayload.data` (the decoded bytes the manager
hands the adapter, per `20-contract.md § adapters/*`) is mapped to one `{ type: 'image', source: {
type: 'base64', media_type, data: <base64> } }` block per attachment, appended to the same
`content` array `send` already builds, ahead of or alongside the text block. No workaround, and no
fallback of writing the file into the workspace and naming its path, is built — D160 already rules
that out and this finding confirms it was never needed.
