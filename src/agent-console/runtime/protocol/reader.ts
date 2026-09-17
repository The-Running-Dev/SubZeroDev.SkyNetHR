import { LINE_BYTES } from './writer.js';

// Byte accounting happens before decoding and before allocating a combined line.
export class RpcReader {
  private chunks: Buffer[] = [];
  private size = 0;
  private discarded = false;
  private decoder = new TextDecoder('utf-8', { fatal: true });
  constructor(private line: (text: string) => void, private corrupt: (reason: string) => void,
    private cap = LINE_BYTES) {}
  push(chunk: Buffer) {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start), stop = end < 0 ? chunk.length : end;
      const part = chunk.subarray(start, stop);
      if (!this.discarded) {
        if (this.size + part.length > this.cap) {
          this.chunks = []; this.size = 0; this.discarded = true; this.corrupt('line_too_large');
        } else { this.chunks.push(part); this.size += part.length; }
      }
      if (end < 0) return;
      if (!this.discarded) {
        const bytes = Buffer.concat(this.chunks, this.size);
        try { this.line(this.decoder.decode(bytes)); } catch { this.corrupt('invalid_utf8'); }
      }
      this.chunks = []; this.size = 0; this.discarded = false; start = end + 1;
    }
  }
  end() { if (this.size) this.corrupt('unterminated_line'); this.chunks = []; this.size = 0; }
}
