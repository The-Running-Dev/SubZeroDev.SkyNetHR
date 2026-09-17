import type { Envelope, Frame } from '../../core/types.js';

export function wireEvent<T extends Envelope | Frame>(event: T): Omit<T, 'raw'> & { raw?: object } {
  const { raw, ...value } = event;
  if (raw == null) return value;
  return { ...value, raw: typeof raw === 'object' && !Array.isArray(raw) ? raw : { value: raw } };
}
