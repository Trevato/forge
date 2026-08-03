/**
 * The one thrown error type in the forge. A throw means a defect — a broken
 * invariant, a bug — never an expected failure. Expected failures travel as
 * `Result` values (see result.ts). If you can branch on it, don't throw it.
 */

// Symbol.for survives duplicate module instances (bundle + test double-load),
// where `instanceof` silently breaks.
const marker = Symbol.for("forge.error");

export class ForgeError extends Error {
  /** Stable machine-readable code, e.g. "git.spawn_failed". */
  readonly code: string;
  override readonly cause?: unknown;
  private readonly [marker] = true;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "ForgeError";
    this.code = code;
    if (options?.cause !== undefined) this.cause = options.cause;
  }

  static isInstance(error: unknown): error is ForgeError {
    return typeof error === "object" && error !== null && marker in error;
  }
}

/** Throw a defect. Reads as a statement: `defect("db.corrupt", …)`. */
export function defect(code: string, message: string, cause?: unknown): never {
  throw new ForgeError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}
