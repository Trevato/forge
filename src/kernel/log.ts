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
    console[level === "debug" ? "log" : level](line);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
