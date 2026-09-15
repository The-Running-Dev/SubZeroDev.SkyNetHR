// Splits a byte stream into newline-delimited JSON lines. Buffers as raw bytes, never
// as a string, so a multi-byte UTF-8 character split across two chunks decodes
// correctly once its bytes are reassembled — decoding chunk-by-chunk would corrupt it.
export class NdjsonSplitter {
  #buffered: Buffer = Buffer.alloc(0);

  // Feeds one chunk (of any size, including a single byte) and returns every complete
  // line it produced, in order. Blank lines are dropped. The trailing partial line, if
  // any, is held for the next push.
  push(chunk: Buffer): string[] {
    this.#buffered = this.#buffered.length === 0 ? chunk : Buffer.concat([this.#buffered, chunk]);

    const lines: string[] = [];
    let start = 0;
    for (;;) {
      const nl = this.#buffered.indexOf(0x0a, start);
      if (nl === -1) break;
      const line = this.#buffered.subarray(start, nl).toString('utf8');
      if (line.length > 0) lines.push(line);
      start = nl + 1;
    }
    this.#buffered = start === 0 ? this.#buffered : Buffer.from(this.#buffered.subarray(start));
    return lines;
  }
}
