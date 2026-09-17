// Identifiers become path components. Display filenames never pass through here
// and are never used to construct a path (I49).
export function isSafePathSegment(name: string): boolean {
  return name.length > 0 && name !== '.' && name !== '..' &&
    !/[\\/\u0000:]/u.test(name) && !/[. ]$/u.test(name) &&
    !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name) &&
    name.normalize('NFC') === name;
}
