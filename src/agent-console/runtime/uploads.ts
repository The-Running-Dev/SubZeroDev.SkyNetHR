import { mkdir, open, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { applicationError } from './protocol/peer.js';

// The core still authorizes, caps and atomically binds the upload. This staging
// copy belongs to the filesystem runtime, and is never historical attachment data.
export class UploadFiles {
  constructor(private root: string | undefined) {}
  private file(sessionId: string, id: string) { return path.join(this.root!, 'sessions', sessionId, 'uploads', id); }
  async begin(sessionId: string, id: string) {
    if (!this.root) return;
    const file = this.file(sessionId, id);
    try { await mkdir(path.dirname(file), { recursive: true }); const handle = await open(file, 'wx'); await handle.close(); }
    catch (error) { throw applicationError('storage', String(error)); }
  }
  async write(sessionId: string, id: string, offset: number, bytes: Uint8Array) {
    if (!this.root) return;
    try {
      const handle = await open(this.file(sessionId, id), 'r+');
      try { let written = 0; while (written < bytes.length) { const result = await handle.write(bytes, written, bytes.length - written, offset + written); if (!result.bytesWritten) throw new Error('zero-byte staging write'); written += result.bytesWritten; } }
      finally { await handle.close(); }
    } catch (error) { throw applicationError('storage', String(error)); }
  }
  async remove(sessionId: string, id: string) { if (this.root) await rm(this.file(sessionId, id), { force: true }).catch(error => console.warn('upload cleanup', error)); }
  async recover(ids: readonly string[]) {
    if (!this.root) return;
    for (const sessionId of ids) {
      const directory = path.join(this.root, 'sessions', sessionId, 'uploads');
      let names: string[];
      try { names = await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw applicationError('storage', String(error)); }
      // Handles are connection-local and cannot survive restart. Only runtime-minted
      // UUID files in this dedicated directory are discarded; nothing is recursive.
      for (const id of names) if (/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) await this.remove(sessionId, id);
    }
  }
}
