/**
 * Expected failures as values. A plain discriminated union — no classes, no
 * combinator zoo. If a caller can reasonably handle a failure, return it;
 * if the program is broken, throw a ForgeError instead (see error.ts).
 */

import { ForgeError } from "./error.ts";

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = Error> = Ok<T> | Err<E>;

export function ok(): Ok<void>;
export function ok<T>(value: T): Ok<T>;
export function ok<T>(value?: T): Ok<T | undefined> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** Run `fn`, catching throws into an Err. For fencing off code you don't own. */
export function trap<T>(fn: () => T): Result<T, unknown> {
  try {
    return ok(fn());
  } catch (error) {
    return err(error);
  }
}

export async function trapAsync<T>(
  fn: () => Promise<T>,
): Promise<Result<T, unknown>> {
  try {
    return ok(await fn());
  } catch (error) {
    return err(error);
  }
}

export function map<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U,
): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

export function andThen<T, U, E, F>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, F>,
): Result<U, E | F> {
  return result.ok ? fn(result.value) : result;
}

/**
 * Assert success and take the value. Reaching an Err here is by definition a
 * defect — only unwrap where failure is structurally impossible or fatal.
 */
export function unwrap<T, E>(result: Result<T, E>, context?: string): T {
  if (result.ok) return result.value;
  throw new ForgeError("result.unwrap", context ?? "unwrapped an Err", {
    cause: result.error,
  });
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}
