# Unfinished session creation

An internal `create-attempts/<sessionId>.json` record retains the attempt/session id,
principal and canonical workspace. The runtime writes and flushes it before calling
the host. Its presence means creation has not been durably published; the host's
`status` remains authoritative for the outcome. It is separate from `meta.json`,
ordinary session summaries and the protocol. Existing session files are unchanged.

After the existing lease/reap steps, boot restores every pending allocation before
asking the host for status, outside all lanes and allocation guards. The status
observation uses the existing host callback deadline:

- `committing`, unavailable/unknown, `new` or `prepared`: retain the record and
  allocation; hide the session and refuse mutations. A freshly started host helper's
  `new` is not proof that a previous commit aborted.
- `committed`: run the existing ended-session/D130 recovery path, then clear the
  record and expose the ended session. A persistence failure retains quarantine.
- `aborted`: destroy checkpoint/session storage, then clear the record and release
  allocation. Failed cleanup retains the record for the next boot.

Boot never blindly aborts or recommits an unfinished attempt. A later boot can
observe its terminal outcome; this fix introduces no new recovery API or poller.
Unreadable recovery records fail boot with the existing typed storage error, since
silently skipping them could free an unknown workspace. Missing/corrupt ordinary
metadata does not discard an otherwise valid pending reservation.

Normal successful creation clears its recovery record only after confirmed host
commit. Legacy sessions without such records follow the existing boot path without
host status calls. This addition cannot infer attempts that an older build already
wrote without recovery state; it does not reclassify historical sessions.

The memory backend keeps the same records only for its instance's lifetime, retaining
its existing throwaway restart behavior. The runtime lease and host `server.lock`
lease remain separate and unchanged.
