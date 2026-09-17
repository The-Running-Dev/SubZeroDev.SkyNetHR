import { RpcError } from './peer.js';

export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RpcError(-32602, 'Expected object');
  return value as JsonObject;
}
export function text(p: JsonObject, key: string, fallback?: string): string {
  const value = p[key] ?? fallback;
  if (typeof value !== 'string') throw new RpcError(-32602, `Expected string: ${key}`);
  return value;
}
export function optionalText(p: JsonObject, key: string): string | null { return p[key] == null ? null : text(p, key); }
export function integer(p: JsonObject, key: string, fallback?: number, max = Number.MAX_SAFE_INTEGER, min = 0): number {
  const value = p[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new RpcError(-32602, `Invalid integer: ${key}`);
  return value;
}
export function strings(p: JsonObject, key: string, fallback?: string[]): string[] {
  const value = p[key] ?? fallback;
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new RpcError(-32602, `Expected string array: ${key}`);
  return value as string[];
}
export function bool(p: JsonObject, key: string, fallback = false): boolean {
  const value = p[key] ?? fallback;
  if (typeof value !== 'boolean') throw new RpcError(-32602, `Expected boolean: ${key}`);
  return value;
}
export function choice<T extends string>(p: JsonObject, key: string, choices: readonly T[], fallback?: T): T {
  const value = text(p, key, fallback);
  if (!choices.includes(value as T)) throw new RpcError(-32602, `Invalid value: ${key}`);
  return value as T;
}
