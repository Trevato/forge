export type ConfigKind = "json" | "yaml" | "toml";
export type ConfigCheck =
  | { ok: true }
  | { ok: false; line?: number; column?: number; message: string };

/** Which parser reads a path, by extension; null for any other file. */
export function configKind(path: string): ConfigKind | null {
  const m = /\.(json|ya?ml|toml)$/i.exec(path);
  if (!m) return null;
  const ext = m[1]!.toLowerCase();
  return ext === "json" ? "json" : ext === "toml" ? "toml" : "yaml";
}

const parsers: Record<ConfigKind, (text: string) => unknown> = {
  json: (t) => JSON.parse(t),
  yaml: (t) => Bun.YAML.parse(t),
  toml: (t) => Bun.TOML.parse(t),
};

function messageOf(err: unknown): string {
  const m = err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err);
  return m.split("\n")[0]!.slice(0, 200);
}

function failsWith(kind: ConfigKind, text: string, message: string): boolean {
  try {
    parsers[kind](text);
    return false;
  } catch (err) {
    return messageOf(err) === message;
  }
}

/** Past this size a broken file is reported without a position: finding it costs parses. */
export const LOCATE_MAX_CHARS = 64_000;

/** Smallest n in [lo, hi] with `fails(n)`, by bisection (about log2 parses); hi when none is seen. */
function firstFailing(lo: number, hi: number, fails: (n: number) => boolean): number {
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fails(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** JSON and YAML errors carry no position of ours: bisect for the shortest prefix that fails the same way. */
function locate(kind: ConfigKind, text: string, message: string): { line: number; column: number } | null {
  if (text.length > LOCATE_MAX_CHARS) return null;
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  const lineEnd = (k: number) => (k < starts.length ? starts[k]! - 1 : text.length);
  const line = firstFailing(1, starts.length, (k) => failsWith(kind, text.slice(0, lineEnd(k)), message));
  const start = starts[line - 1]!;
  const end = lineEnd(line);
  const n = firstFailing(start + 1, Math.max(start + 1, end), (m) => failsWith(kind, text.slice(0, m), message));
  return { line, column: n - start };
}

/** Whether `text` parses as `kind`; when not, the 1-based line and column where it breaks. */
export function checkConfig(kind: ConfigKind, text: string): ConfigCheck {
  try {
    parsers[kind](text);
    return { ok: true };
  } catch (err) {
    const message = messageOf(err);
    if (kind === "toml") {
      const pos = (err as { position?: { line?: unknown; column?: unknown } }).position;
      if (typeof pos?.line === "number" && typeof pos.column === "number")
        return { ok: false, line: pos.line, column: pos.column, message };
    }
    return { ok: false, ...(locate(kind, text, message) ?? {}), message };
  }
}
