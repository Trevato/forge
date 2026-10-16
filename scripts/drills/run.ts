/**
 * `bun scripts/drills/run.ts <domain> --forge <url>`: walks an operator
 * through a standby drill. It prints the fault to cause, waits for Enter,
 * polls `/api/v1/health` and `/` once a second keeping each distinct line the
 * forge says while unhealthy, and when the forge is healthy again posts what
 * it saw and how long it took to `POST /api/v1/drills` (`FORGE_TOKEN` from
 * the environment). If the forge never comes back within the ceiling it posts
 * nothing. Zero dependencies; it never shells out.
 */

import { DOMAINS } from "../../src/kernel/domains.ts";

export interface DrillRun {
  domain: string;
  forge: string;
  token: string;
  /** Wait for the operator's Enter. */
  enter: () => Promise<void>;
  /** One output line. */
  say: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  intervalMs?: number;
  ceilingMs?: number;
}

const SEEN_MAX = 8_000;
const DEFAULT_CEILING_MS = 3_600_000;

/** Every string in a JSON value, or the text's own lines when it is not JSON. */
function linesOf(text: string, contentType: string): string[] {
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

interface Look {
  healthy: boolean;
  health: string[];
  board: string[];
}

async function look(forge: string, token: string): Promise<Look> {
  const get = async (path: string): Promise<{ ok: boolean; lines: string[]; json: unknown }> => {
    try {
      const res = await fetch(`${forge}${path}`, {
        headers: { authorization: `Bearer ${token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      const type = res.headers.get("content-type") ?? "";
      const text = await res.text();
      let json: unknown = null;
      if (type.includes("json")) {
        try { json = JSON.parse(text); } catch { /* not JSON */ }
      }
      return { ok: res.status < 400, lines: linesOf(text, type), json };
    } catch {
      return { ok: false, lines: [], json: null };
    }
  };
  const [h, b] = await Promise.all([get("/api/v1/health"), get("/")]);
  const reported = (h.json as { ok?: unknown } | null)?.ok === true;
  return { healthy: h.ok && b.ok && reported, health: h.lines, board: b.lines };
}

/** A line with its numbers blanked, so a clock or a counter is not a new line. */
const shape = (l: string): string => l.replace(/\d+/g, "#");

const cap = (lines: Iterable<string>): string => [...lines].join("\n").slice(0, SEEN_MAX);

/** Runs the drill; resolves to the process exit code. */
export async function runDrill(run: DrillRun): Promise<number> {
  const domain = DOMAINS.find((d) => d.key === run.domain);
  if (!domain) {
    run.say(`unknown domain "${run.domain}"; one of: ${DOMAINS.map((d) => d.key).join(", ")}`);
    return 1;
  }
  if (domain.drill.name === null) {
    run.say(`${domain.key} has no drill: ${domain.drill.why}`);
    return 1;
  }
  const now = run.now ?? Date.now;
  const sleep = run.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const intervalMs = run.intervalMs ?? 1_000;
  const ceilingMs = run.ceilingMs ?? DEFAULT_CEILING_MS;

  run.say(`Drill ${domain.drill.name} for ${domain.name}.`);
  run.say(`Cause this fault: ${domain.breaks}`);
  run.say(`The forge should be back within ${domain.backMinutes} minutes. Press Enter when you have caused it.`);
  await run.enter();

  const started = now();
  const health = new Map<string, string>();
  const board = new Map<string, string>();
  let sawDown = false;
  for (;;) {
    const seen = await look(run.forge, run.token);
    if (seen.healthy && sawDown) break;
    if (!seen.healthy) {
      sawDown = true;
      for (const l of seen.health) if (!health.has(shape(l))) { health.set(shape(l), l); run.say(`health: ${l}`); }
      for (const l of seen.board) if (!board.has(shape(l))) { board.set(shape(l), l); run.say(`board: ${l}`); }
    }
    if (now() - started >= ceilingMs) {
      const ceilingS = Math.round(ceilingMs / 1000);
      run.say(`The forge did not come back within the ceiling of ${ceilingS}s; nothing was posted.`);
      run.say(JSON.stringify({ domain: domain.key, backSeconds: null, posted: false, ceilingSeconds: ceilingS }));
      return 0;
    }
    await sleep(intervalMs);
  }

  const backSeconds = Math.max(0, Math.round((now() - started) / 1000));
  const body = { domain: domain.key, seen: { health: cap(health.values()), board: cap(board.values()) }, backSeconds };
  let res: Response;
  try {
    res = await fetch(`${run.forge}/api/v1/drills`, {
      method: "POST",
      headers: { authorization: `Bearer ${run.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    run.say(`could not post the result: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const text = await res.text();
  let reply: Record<string, unknown> = {};
  try { reply = JSON.parse(text) as Record<string, unknown>; } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = typeof reply.message === "string" ? reply.message : typeof reply.error === "string" ? reply.error : text.slice(0, 200);
    run.say(`the forge refused the result (${res.status}): ${msg}`);
    return 1;
  }
  const verdict = (reply.verdict ?? reply) as { green?: unknown; why?: unknown };
  run.say(`${verdict.green === true ? "GREEN" : "RED"}: ${String(verdict.why ?? "")}`);
  run.say(JSON.stringify({ domain: domain.key, backSeconds, posted: true, result: reply }));
  return 0;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--forge");
  const forge = at >= 0 ? args[at + 1] : undefined;
  const domain = args.find((a, i) => !a.startsWith("--") && i !== at + 1);
  const token = process.env.FORGE_TOKEN ?? "";
  if (!domain || !forge || !/^https?:\/\//.test(forge) || token === "") {
    console.error("usage: FORGE_TOKEN=… bun scripts/drills/run.ts <domain> --forge <url>");
    process.exit(2);
  }
  const code = await runDrill({
    domain,
    forge: forge.replace(/\/+$/, ""),
    token,
    say: (l) => console.log(l),
    enter: async () => {
      for await (const _ of console) break;
    },
  });
  process.exit(code);
}
