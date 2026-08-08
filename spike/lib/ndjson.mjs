/**
 * NDJSON line splitter.
 *
 * The one piece of this spike that is production-shaped, because getting it wrong is the
 * classic source of corrupt-event bugs: a chunk boundary lands mid-line and the naive
 * implementation either drops the fragment or parses it as truncated JSON.
 *
 * Contract: feeding a stream one byte at a time must produce exactly the same sequence of
 * values as feeding it in one chunk. See test/ndjson.test.mjs, and 30-slices.md S1.2.
 */

/**
 * @param {(err: Error, line: string) => void} [onParseError]
 * @returns {(chunk: Buffer | string) => unknown[]}
 */
export function createLineSplitter(onParseError) {
  let carry = '';

  return function push(chunk) {
    carry += chunk.toString('utf8');

    // Split on \n, keep the trailing fragment for the next chunk. A \n at the very end
    // yields a trailing '' which correctly becomes an empty carry.
    const parts = carry.split('\n');
    carry = parts.pop() ?? '';

    const out = [];
    for (const part of parts) {
      // Tolerate CRLF: the CLI is spawned with pipes, but a Windows shim can inject them.
      const line = part.trim();
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch (err) {
        // Never drop silently. The caller decides whether this is fatal.
        if (onParseError) onParseError(err, line);
        else throw err;
      }
    }
    return out;
  };
}
