import { rename } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

// Windows refuses a rename-over with EPERM (EACCES/EBUSY on some filesystems) while another
// rename onto the same target is in flight, or while something else holds the target open
// without delete sharing — two simultaneous pairs failed about one time in four in a local
// probe (issue #511), and full-suite load on CI makes the window wider (#382). That is a
// sharing violation that clears as soon as the other party lets go, not a path that cannot be
// written, so it is retried; a refusal that outlasts the retries still throws, and each caller
// still reports it as its own I/O error. Every temp-file-then-rename write goes through here:
// a bare `rename` over an existing file is the defect, wherever it sits.
export const RENAME_RETRY_DELAYS_MS = [10, 20, 40, 80, 160] as const;
const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

export async function renameOver(
  from: string,
  to: string,
  renameFn: (from: string, to: string) => Promise<void> = rename,
): Promise<void> {
  for (const wait of RENAME_RETRY_DELAYS_MS) {
    try {
      await renameFn(from, to);
      return;
    } catch (err) {
      if (!TRANSIENT_RENAME_CODES.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
      await delay(wait);
    }
  }
  await renameFn(from, to);
}
