/**
 * Structured line logging. One line per event: timestamp, level, scope,
 * message, then `key=value` fields. Greppable over clever.
 */

export type LogFields = Record<string, string | number | boolean | undefined>;

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
    console[level === "debug" ? "log" : level](line);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
