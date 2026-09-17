import { LINE_BYTES } from './writer.js';
import { NdjsonSplitter } from '../../providers/ndjson.js';

// Byte accounting happens before decoding and before allocating a combined line.
export class RpcReader {
  private splitter: NdjsonSplitter;
  constructor(private line: (text: string) => void, private corrupt: (reason: string) => void,
    cap = LINE_BYTES) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    this.splitter = new NdjsonSplitter(cap, () => corrupt('line_too_large'), { dropBlankLines: false, decode: bytes => decoder.decode(bytes) });
  }
  push(chunk: Buffer) {
    let lines: string[];
    try { lines = this.splitter.push(chunk); } catch { this.corrupt('invalid_utf8'); return; }
    for (const line of lines) this.line(line);
  }
  end() { if (this.splitter.pendingBytes) this.corrupt('unterminated_line'); }
}
