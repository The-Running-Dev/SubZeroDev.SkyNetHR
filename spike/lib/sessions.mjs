/**
 * Session manager: ownership, the filesystem jail, sequencing and the replay buffer.
 *
 * Knows nothing about any vendor (design/10-design.md). Adapters hand it unsequenced
 * events; it stamps `seq` (D2) and fans out to subscribers.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createClaudeAdapter } from './claude-adapter.mjs';

const RING = 2000;   // events retained for replay; S9.1 caps and spills the rest to disk

/**
 * Resolve a requested cwd and prove it lies inside a configured root (D4).
 * Symlinks followed, `..` collapsed, case-normalised on Windows.
 * @returns {string} the resolved real path — this, never the caller's string, is used
 * @throws {Error & {code:'outside_workspace_root'}}
 */
export function resolveInsideRoot(requested, roots) {
  const deny = () => {
    throw Object.assign(new Error('cwd outside workspace roots'), {
      code: 'outside_workspace_root',
    });
  };

  let real;
  try {
    real = fs.realpathSync(path.resolve(requested));
  } catch {
    deny();
  }

  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

  for (const root of roots) {
    let realRoot;
    try { realRoot = fs.realpathSync(path.resolve(root)); } catch { continue; }
    const rel = path.relative(norm(realRoot), norm(real));
    // Inside means: not empty-and-outside, no leading `..`, and not absolute.
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return real;
  }
  return deny();
}

export function createSessionStore({ roots, storageDir }) {
  const sessions = new Map();

  function create({ owner, vendor, cwd, model }) {
    if (vendor !== 'claude') {
      // The Codex adapter is an experiment, not an implementation (30-slices.md S8).
      throw Object.assign(new Error(`vendor not implemented: ${vendor}`), { code: 'bad_request' });
    }

    const resolved = resolveInsideRoot(cwd, roots);
    const id = randomUUID();
    const dir = path.join(storageDir, 'sessions', id);
    fs.mkdirSync(dir, { recursive: true });

    const session = {
      id,
      owner,
      vendor,
      cwd: resolved,
      seq: 0,
      buffer: [],            // ring of envelopes
      subscribers: new Set(),
      spill: fs.createWriteStream(path.join(dir, 'events.ndjson'), { flags: 'a' }),
      adapter: null,
    };

    session.emit = (kind, data, raw) => {
      const env = {
        seq: ++session.seq,
        sessionId: id,
        ts: new Date().toISOString(),
        kind,
        data,
        ...(process.env.CONSOLE_DEBUG_RAW ? { raw } : {}),
      };
      session.buffer.push(env);
      if (session.buffer.length > RING) session.buffer.shift();
      session.spill.write(JSON.stringify(env) + '\n');
      for (const send of session.subscribers) {
        try { send(env); } catch { /* a dead subscriber is reaped on its own close */ }
      }
    };

    session.adapter = createClaudeAdapter({
      cwd: resolved,
      model,
      emit: session.emit,
    });

    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify({ id, owner, vendor, cwd: resolved, model: model ?? null,
                       created: new Date().toISOString() }, null, 2),
    );

    sessions.set(id, session);
    return session;
  }

  /** Ownership is enforced by returning undefined, so callers 404 rather than 403. */
  function get(id, owner) {
    const s = sessions.get(id);
    return s && s.owner === owner ? s : undefined;
  }

  function list(owner) {
    return [...sessions.values()]
      .filter((s) => s.owner === owner)
      .map((s) => ({ sessionId: s.id, vendor: s.vendor, cwd: s.cwd, events: s.seq }));
  }

  /** Replay from `after`. `null` second element signals the sequence aged out (S3.3). */
  function replay(session, after) {
    if (!after) return session.buffer;
    const oldest = session.buffer[0]?.seq ?? 1;
    if (after + 1 < oldest) return null;
    return session.buffer.filter((e) => e.seq > after);
  }

  function destroy(id, owner) {
    const s = get(id, owner);
    if (!s) return false;
    s.adapter.interrupt();
    s.spill.end();
    sessions.delete(id);
    return true;
  }

  return { create, get, list, replay, destroy, all: sessions };
}
