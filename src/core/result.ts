/** Explicit success/failure for anything the player can get wrong. */
export type Result<T = void, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok(): Result<void>;
export function ok<T>(value: T): Result<T>;
export function ok<T>(value?: T): Result<T | void> {
  return { ok: true, value: value as T };
}

export function err<E = string>(error: E): Result<never, E> {
  return { ok: false, error };
}

export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok;
}

export function unwrap<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(`Unwrapped a failed Result: ${String(r.error)}`);
  return r.value;
}
