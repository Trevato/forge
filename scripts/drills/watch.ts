/**
 * `watchDrill`: polls one URL until the forge is healthy again after having
 * been unhealthy, and returns each distinct line it said meanwhile. Pure: the
 * fetch and the sleep come in as arguments, nothing is read, posted or global.
 * Times are milliseconds: the clock you pass, or else polls made times the
 * interval. `watchPolls` is the loop for any poll that says healthy or not and
 * what each of its sources said; `watchDrill` is it over one URL.
 */

/** C0 and C1 control characters out (tab stays): the forge's words never drive the terminal. */
export const clean = (s: string): string => s.replace(/[\x00-\x08\x0a-\x1f\x7f-\x9f]/g, "");

/** Every string in a JSON value, or the text's own lines when it is not JSON. */
export function linesOf(text: string, contentType: string): string[] {
  return rawLinesOf(text, contentType).map(clean).filter((l) => l.trim() !== "");
}

function rawLinesOf(text: string, contentType: string): string[] {
  if (contentType.includes("json")) {
    try {
      const out: string[] = [];
      const walk = (v: unknown): void => {
        if (typeof v === "string") out.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === "object") Object.values(v).forEach(walk);
      };
      walk(JSON.parse(text));
      return out;
    } catch {
      /* fall through to plain lines */
    }
  }
  return text
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, "\n")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** A line with its numbers blanked, so a clock or a counter is not a new line. */
const shape = (l: string): string => l.replace(/\d+/g, "#");

/** The part of a Response that a watch reads. */
export interface Reply {
  status: number;
  text: () => Promise<string>;
  headers: { get: (name: string) => string | null };
}

/** What a fetch that threw is recorded as saying. */
export const UNREACHABLE = "unreachable";

/** One look at the forge: is it healthy, and what each source said (named by source). */
export interface Poll {
  healthy: boolean;
  said: Record<string, string[]>;
}

export interface Watch {
  poll: () => Promise<Poll>;
  /** Waits one interval. */
  sleep: (ms: number) => Promise<unknown>;
  /** The most polls to make before giving up. */
  limit: number;
  intervalMs?: number;
  /** Milliseconds on any clock; without it, time is the polls made times `intervalMs`. */
  now?: () => number;
  /** Gives up once this many milliseconds have passed, however few polls that took. */
  ceilingMs?: number;
  /** Called once with each new distinct line and its source, as it is first said. */
  onLine?: (line: string, source: string) => void;
}

export type Watched =
  | { timeout: false; startedAt: number; healthyAt: number; said: Record<string, string[]> }
  | { timeout: true; startedAt: number | null; said: Record<string, string[]> };

/** Polls until healthy again after having been unhealthy; keeps each distinct line said while unhealthy. */
export async function watchPolls(w: Watch): Promise<Watched> {
  const intervalMs = w.intervalMs ?? 1_000;
  const seen = new Map<string, Map<string, string>>();
  const said = (): Record<string, string[]> =>
    Object.fromEntries([...seen].map(([source, m]) => [source, [...m.values()]]));
  const began = w.now?.() ?? 0;
  let startedAt: number | null = null;
  for (let n = 0; n < w.limit; n++) {
    const look = await w.poll();
    const at = w.now ? w.now() - began : n * intervalMs;
    if (look.healthy && startedAt !== null) return { timeout: false, startedAt, healthyAt: at, said: said() };
    if (!look.healthy) {
      startedAt ??= at;
      for (const [source, lines] of Object.entries(look.said)) {
        const m = seen.get(source) ?? new Map<string, string>();
        seen.set(source, m);
        for (const l of lines) if (!m.has(shape(l))) { m.set(shape(l), l); w.onLine?.(l, source); }
      }
    }
    if (w.ceilingMs !== undefined && at >= w.ceilingMs) break;
    await w.sleep(intervalMs);
  }
  return { timeout: true, startedAt, said: said() };
}

export interface WatchDrill extends Omit<Watch, "poll" | "onLine"> {
  url: string;
  fetch: (url: string) => Promise<Reply>;
  onLine?: (line: string) => void;
}

export type WatchedDrill =
  | { timeout: false; startedAt: number; healthyAt: number; lines: string[] }
  | { timeout: true; startedAt: number | null; lines: string[] };

/** `watchPolls` over one URL: healthy is a status under 400, and the lines are its body's. */
export async function watchDrill(w: WatchDrill): Promise<WatchedDrill> {
  const poll = async (): Promise<Poll> => {
    try {
      const res = await w.fetch(w.url);
      if (res.status < 400) return { healthy: true, said: {} };
      let lines: string[] = [];
      try {
        lines = linesOf(await res.text(), res.headers.get("content-type") ?? "");
      } catch {
        /* an unreadable body is unhealthy and says nothing */
      }
      return { healthy: false, said: { "": lines } };
    } catch {
      return { healthy: false, said: { "": [UNREACHABLE] } };
    }
  };
  const { url: _url, fetch: _fetch, onLine, ...rest } = w;
  const r = await watchPolls({ ...rest, poll, ...(onLine && { onLine: (l: string) => onLine(l) }) });
  const lines = r.said[""] ?? [];
  return r.timeout
    ? { timeout: true, startedAt: r.startedAt, lines }
    : { timeout: false, startedAt: r.startedAt, healthyAt: r.healthyAt, lines };
}
