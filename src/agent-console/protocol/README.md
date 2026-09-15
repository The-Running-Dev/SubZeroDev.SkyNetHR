# Event schema fixtures

These JSON Schema 2020-12 files describe the Phase 1 contract. They are test assets;
no runtime module loads them. The TypeScript declarations in `../contract/index.ts`
own shape, and `design/20-contract.md` owns meaning.

Register every schema by its `$id` before validation. The `.invalid` URLs are stable
identifiers for local resolution, not endpoints to fetch. Enable `date-time` format
assertions as well as the schema's UTC, millisecond-precision pattern.

- `schemas/envelope.schema.json` validates the generic replayable vocabulary.
- `schemas/frame.schema.json` validates `message.delta` and rejects any `seq` property,
  including `null` (I51). The TypeScript event map retains this kind for dispatch;
  that does not permit emitting a delta envelope.
- `schemas/events/` describes each `kind` / `data` pair. Use the envelope or frame entry
  schema to validate a complete transport record, including its required metadata.
- `fixtures/valid` and `fixtures/invalid` contain plain transport records. The next
  directory, `envelopes` or `frames`, selects the schema independently of the record's
  contents. Each invalid filename names the mistake it demonstrates.

SkyNetHR composes its host-owned event schemas and fixtures under
`src/contract/protocol/`. The generic schemas contain no host references or vendor
literals. A host registers both schema sets and validates envelopes with its own
entry schema; the frame schema remains generic.

Missing and null are distinct. Only `raw` is optional on these transport records;
nullable payload fields remain required. `raw`, input values and suggestion items
are opaque JSON. Additional object properties remain allowed, matching structural
TypeScript types. The schemas do not invent identifier grammars or enforce stateful
producer rules such as sequence contiguity or event ordering.

`seq` is a safe integer (zero is a possible replay-gap watermark). Other declared
`number` fields retain that type and bound integer values to the JavaScript-safe
range; they are not silently narrowed to integers. Declared enum members remain
available even where a producer does not currently emit them.

Run `npm test` for the normal build and suite. For focused verification after a
build, run `node --test dist/contract/protocol/conformance.test.js`. The test reports
schema, positive, negative and vocabulary counts, and also typechecks every valid
fixture against the host contract without changing or emitting a source file.
