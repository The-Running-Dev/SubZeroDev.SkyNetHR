import { realpath as realpathCb } from 'node:fs';
import { platform } from 'node:process';
import type { JailError, ResolvedPath, Result } from '../contract/index.js';

// `fs.promises.realpath` is a JS re-implementation that does not resolve Windows 8.3
// short names. `realpath.native` calls the OS (GetFinalPathNameByHandleW on Windows),
// which resolves symlinks, junctions, 8.3 short names and case in one step.
function realpathNative(candidate: string): Promise<string> {
  return new Promise((resolve, reject) => {
    realpathCb.native(candidate, 'utf8', (err, resolved) => {
      if (err) reject(err);
      else resolve(resolved);
    });
  });
}

const isWindows = platform === 'win32';

// GetFinalPathNameByHandleW returns the `\\?\`-prefixed extended form; normalise it
// away so comparisons and anything downstream see an ordinary path. Exported so config
// can canonicalise workspace roots with the same normalisation candidates get here.
export function stripExtendedPrefix(p: string): string {
  if (p.startsWith('\\\\?\\UNC\\')) return '\\\\' + p.slice(8);
  if (p.startsWith('\\\\?\\')) return p.slice(4);
  return p;
}

function normaliseForCompare(p: string): string {
  const stripped = stripExtendedPrefix(p);
  const withSeparators = isWindows ? stripped.replace(/\//g, '\\') : stripped;
  return isWindows ? withSeparators.toLowerCase() : withSeparators;
}

function isInsideRoot(resolved: string, root: string): boolean {
  const a = normaliseForCompare(resolved);
  const b = normaliseForCompare(root);
  const sep = isWindows ? '\\' : '/';
  const rootWithSep = b.endsWith(sep) ? b : b + sep;
  return a === b || a.startsWith(rootWithSep);
}

// True when the two paths are equal or one contains the other, under the same
// normalisation `isInsideRoot` uses. This is the one containment predicate in the server;
// callers must not hand-roll their own.
//
// Both parameters are `ResolvedPath` rather than `string`, and that is the whole
// enforcement of "both arguments must already be jail-resolved": only this module mints
// the brand, so a caller cannot reach this with a path the jail never proved. Widening it
// to `string` makes that sentence a comment instead of a check.
export function pathsOverlap(a: ResolvedPath, b: ResolvedPath): boolean {
  return isInsideRoot(a, b) || isInsideRoot(b, a);
}

export async function resolveInsideRoot(
  candidate: string,
  roots: readonly ResolvedPath[],
): Promise<Result<ResolvedPath, JailError>> {
  let resolved: string;
  try {
    resolved = stripExtendedPrefix(await realpathNative(candidate));
  } catch (err) {
    return {
      ok: false,
      error: { code: 'unresolvable', candidate, detail: (err as Error).message },
    };
  }

  for (const root of roots) {
    if (isInsideRoot(resolved, root)) {
      return { ok: true, value: resolved as ResolvedPath };
    }
  }

  return {
    ok: false,
    error: { code: 'outside_workspace_root', candidate, roots: roots as readonly string[] },
  };
}
