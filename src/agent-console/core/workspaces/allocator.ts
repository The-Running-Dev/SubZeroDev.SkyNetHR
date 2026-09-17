import type { ResolvedPath } from '../../contract/index.js';
import { createLane } from '../lane.js';
import { pathsOverlap } from './jail.js';

export interface Reservation {
  readonly id: string;
  readonly cwd: ResolvedPath;
  principal: string;
  state: 'pending' | 'live';
  exclusive: boolean;
}

// One allocator per runtime. Canonicalisation happens before reserve; its guard
// covers only decisions and mutations over these in-memory reservations.
export function createWorkspaceAllocator(maxLiveSessionsPerWorkspace = 1) {
  if (!Number.isSafeInteger(maxLiveSessionsPerWorkspace) || maxLiveSessionsPerWorkspace < 1) {
    throw new RangeError('maxLiveSessionsPerWorkspace must be a positive integer');
  }
  const guard = createLane();
  const reservations = new Map<string, Reservation>();
  return {
    reserve(id: string, cwd: ResolvedPath, principal: string): Reservation | null {
      return guard.run(() => {
        const overlaps = [...reservations.values()].filter(r => pathsOverlap(cwd, r.cwd));
        const exclusive = overlaps.find(r => r.exclusive);
        if (exclusive) return exclusive;
        if (overlaps.length >= maxLiveSessionsPerWorkspace) return overlaps[0]!;
        reservations.set(id, { id, cwd, principal, state: 'pending', exclusive: false });
        return null;
      });
    },
    activate(id: string): void { guard.run(() => { const r = reservations.get(id); if (r) r.state = 'live'; }); },
    reassign(id: string, principal: string): void { guard.run(() => { const r = reservations.get(id); if (r) r.principal = principal; }); },
    exclusive(id: string): Reservation | null {
      return guard.run(() => {
        const self = reservations.get(id);
        if (!self) throw new Error('Cannot reserve an unallocated workspace');
        const other = [...reservations.values()].find(r => r.id !== id && pathsOverlap(self.cwd, r.cwd));
        if (other) return other;
        if (self.exclusive) return self;
        self.exclusive = true;
        return null;
      });
    },
    releaseExclusive(id: string): void { guard.run(() => { const r = reservations.get(id); if (r) r.exclusive = false; }); },
    release(id: string): void { guard.run(() => { reservations.delete(id); }); },
  };
}
