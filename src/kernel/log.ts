/**
 * Structured line logging. One line per event: timestamp, level, scope,
 * message, then `key=value` fields. Greppable over clever.
 */

export type LogFields = Record<string, string | number | boolean | undefined>;

/**
 * Shapes that are credentials wherever they appear. A log line is the most
 * common way a secret escapes a program — it survives rotation, ships to a
 * collector, and nobody reads it until it is too late. Cheap insurance, and
 * a test asserts a full connect-and-refresh cycle logs nothing matching it.
 */
const SECRETS =
  /(gh[pousr]_[A-Za-z0-9]{16,}|gto_[A-Za-z0-9_-]{16,}|forge_[A-Za-z0-9_-]{20,}|(?:access_token|refresh_token|client_secret|code_verifier|device_code|private_token)["'\s:=]+[A-Za-z0-9._~+/-]{8,}|(?:Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{16,}|(?:authorization|token|secret|password|passwd|api_?key)["'\\\s:=]+[A-Za-z0-9._~+/=-]{16,})/gi;

/** Replace anything credential-shaped with a marker. Exported for tests. */
export function redactSecrets(text: string): string {
  return text.replace(SECRETS, "[redacted]");
}

export interface Log {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

const order: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let threshold: LogLevel = "info";

/** Global floor; anything below it is dropped. @default "info" */
export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

/** The floor as it stands, so whoever lowers it can put it back. */
export function logLevel(): LogLevel {
  return threshold;
}

/** The most recent error lines kept in memory; older ones fall off. */
export const ERROR_RING = 100;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export interface ErrorLine {
  readonly at: string;
  readonly scope: string;
  readonly message: string;
}

const ring: ErrorLine[] = [];
/** scope → minute bucket → count: an hour of counts in at most 61 buckets per scope. */
const buckets = new Map<string, Map<number, number>>();

function prune(now: number): void {
  const floor = Math.floor((now - HOUR_MS) / MINUTE_MS);
  for (const [scope, minutes] of buckets) {
    for (const minute of minutes.keys()) if (minute <= floor) minutes.delete(minute);
    if (minutes.size === 0) buckets.delete(scope);
  }
}

function record(scope: string, message: string, now: number): void {
  ring.push({ at: new Date(now).toISOString(), scope, message });
  if (ring.length > ERROR_RING) ring.splice(0, ring.length - ERROR_RING);
  prune(now);
  const minutes = buckets.get(scope) ?? new Map<number, number>();
  const minute = Math.floor(now / MINUTE_MS);
  minutes.set(minute, (minutes.get(minute) ?? 0) + 1);
  buckets.set(scope, minutes);
}

/** Errors in the last hour, in total and per scope, and the newest lines first. */
export function recentErrors(
  limit = 5,
  now = Date.now(),
): { lastHour: number; byScope: Record<string, number>; latest: ErrorLine[] } {
  prune(now);
  const byScope: Record<string, number> = {};
  let lastHour = 0;
  for (const [scope, minutes] of buckets) {
    let n = 0;
    for (const c of minutes.values()) n += c;
    byScope[scope] = n;
    lastHour += n;
  }
  return { lastHour, byScope, latest: ring.slice(-limit).reverse() };
}

/** Forget everything kept. For tests. */
export function clearErrors(): void {
  ring.length = 0;
  buckets.clear();
}

export function createLog(scope: string): Log {
  const emit = (level: LogLevel, message: string, fields?: LogFields) => {
    if (order[level] < order[threshold]) return;
    let line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        const text = String(value);
        line += ` ${key}=${/[\s"=]/.test(text) ? JSON.stringify(text) : text}`;
      }
    }
    line = redactSecrets(line);
    if (level === "error") {
      const body = line.slice(line.indexOf(`[${scope}] `) + scope.length + 3);
      record(scope, body, Date.now());
    }
    console[level === "debug" ? "log" : level](line);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
