import { createProcessMetadata } from './metadata.js';
import { createTermination } from './termination.js';
import type { ProcessLedger } from './ledger.js';

export { buildEnvironment } from './environment.js';
export { spawnProcess, resolveSpawn, reportableImage, closeStdin, protectStdin } from './spawn.js';
export type { ProcessLedger, ProcessRecord, ProcessTombstone } from './ledger.js';

const termination = createTermination();
export const terminateProcess = termination.terminate;
export const killProbe = termination.killProbe;

// Internal ProcessSupervisor composition. Injected persistence has no session-store,
// workspace, audit, lock, or event dependency. Its caller owns all lifecycle decisions.
export function createProcessSupervisor<E>(ledger: ProcessLedger<E>) {
  return { ledger, ...createProcessMetadata(), killProcessTree: termination.killProcessTree };
}
