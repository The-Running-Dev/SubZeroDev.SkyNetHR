// Splits a byte stream into newline-delimited JSON lines. Buffers as raw bytes, never
// as a string, so a multi-byte UTF-8 character split across two chunks decodes
// correctly once its bytes are reassembled — decoding chunk-by-chunk would corrupt it.
export class NdjsonSplitter {
  #buffer: Buffer = Buffer.alloc(0);
  #size = 0;
  #overflowed = false;
  constructor(private cap = 64 * 1024 * 1024, private overflow: () => void = () => {},
    private options: { dropBlankLines?: boolean; decode?: (bytes: Buffer) => string } = {}) {}
  get pendingBytes() { return this.#size; }

  // Feeds one chunk (of any size, including a single byte) and returns every complete
  // line it produced, in order. Blank lines are dropped. The trailing partial line, if
  // any, is held for the next push.
  push(chunk: Buffer): string[] {
    const lines: string[] = [];
    let start = 0;
    if (this.#overflowed) return lines;
    while (start < chunk.length) {
      const nl = chunk.indexOf(0x0a, start), end = nl < 0 ? chunk.length : nl;
      const part = chunk.subarray(start, end);
      if (this.#size + part.length > this.cap) {
        this.#overflowed = true; this.#buffer = Buffer.alloc(0); this.#size = 0;
        // Complete preceding records in this chunk before reporting the overflow.
        queueMicrotask(this.overflow); return lines;
      }
      const needed = this.#size + part.length;
      if (needed > this.#buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(this.cap, Math.max(needed, this.#buffer.length * 2, 4096)));
        this.#buffer.copy(grown, 0, 0, this.#size); this.#buffer = grown;
      }
      part.copy(this.#buffer, this.#size); this.#size = needed;
      if (nl < 0) break;
      if (this.#size || this.options.dropBlankLines === false) {
        const bytes = this.#buffer.subarray(0, this.#size);
        lines.push(this.options.decode ? this.options.decode(bytes) : bytes.toString('utf8'));
      }
      this.#size = 0; start = nl + 1;
    }
    return lines;
  }
}
