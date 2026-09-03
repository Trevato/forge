/**
 * The bench: boot a real forge over a seeded data directory and time the
 * pages an agent fleet actually hammers.
 *
 *   bun run bench/seed.ts --data .bench/data
 *   bun run bench/run.ts  --data .bench/data
 *
 * Two numbers per endpoint, and the second one is the one that matters.
 * Latency (p50/p95) says how it feels today, on this machine, with this
 * cache warm. **Statements per request** says whether it will still feel
 * that way at ten times the size: a page that issues one query per row is a
 * page that is already broken and merely fast enough to hide it.
 *
 * The counter is a shim over `Database.query`/`prepare` that wraps every
 * statement it hands back, so it counts *executions* — not prepares, which
 * bun caches and which would report a per-row query as one.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { createApp, type App as Forge } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setLogLevel } from "../src/kernel/log.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { getUserByName } from "../src/core/users.ts";
import { createSession } from "../src/core/sessions.ts";
import type { SeedResult } from "./seed.ts";

// ---- the statement counter ----

export interface SqlCounter {
  /** Statements executed since the last `reset()`. */
  readonly count: number;
  /** The SQL executed since the last `reset()`, most frequent first. */
  top(n?: number): { sql: string; times: number }[];
  reset(): void;
  stop(): void;
}

const EXEC_METHODS = ["get", "all", "run", "values", "iterate"] as const;

/**
 * Count every statement execution on one database handle. Installed on the
 * instance, not the prototype, so two apps in one process stay independent.
 */
export function countStatements(db: Database): SqlCounter {
  let count = 0;
  const perSql = new Map<string, number>();
  const original = { query: db.query, prepare: db.prepare, exec: db.exec };

  const wrap = (statement: unknown, sql: string): unknown =>
    new Proxy(statement as object, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (
          typeof value === "function" &&
          (EXEC_METHODS as readonly (string | symbol)[]).includes(prop)
        ) {
          return (...args: unknown[]) => {
            count++;
            perSql.set(sql, (perSql.get(sql) ?? 0) + 1);
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  db.query = ((sql: string) =>
    wrap(original.query.call(db, sql), sql)) as typeof db.query;
  db.prepare = ((sql: string, ...rest: unknown[]) =>
    wrap(
      (original.prepare as (...a: unknown[]) => unknown).call(db, sql, ...rest),
      sql,
    )) as typeof db.prepare;
  db.exec = ((sql: string, ...rest: unknown[]) => {
    count++;
    perSql.set(sql, (perSql.get(sql) ?? 0) + 1);
    return (original.exec as (...a: unknown[]) => unknown).call(
      db,
      sql,
      ...rest,
    );
  }) as typeof db.exec;

  return {
    get count() {
      return count;
    },
    top(n = 5) {
      return [...perSql.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([sql, times]) => ({
          sql: sql.replace(/\s+/g, " ").trim(),
          times,
        }));
    },
    reset() {
      count = 0;
      perSql.clear();
    },
    stop() {
      db.query = original.query;
      db.prepare = original.prepare;
      db.exec = original.exec;
    },
  };
}

// ---- measurement ----

export interface Sample {
  readonly name: string;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
  readonly sql: number;
  readonly bytes: number;
  readonly status: number;
  readonly topSql: { sql: string; times: number }[];
}

const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0
    ? 0
    : (sorted[
        Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))
      ] ?? 0);

async function measure(
  name: string,
  iterations: number,
  counter: SqlCounter,
  run: () => Promise<{ status: number; bytes: number }>,
): Promise<Sample> {
  // Warm: the first hit pays for statement preparation and page cache.
  await run();
  const times: number[] = [];
  let status = 0;
  let bytes = 0;
  counter.reset();
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    const out = await run();
    times.push(performance.now() - started);
    status = out.status;
    bytes = out.bytes;
  }
  const sql = counter.count / iterations;
  const topSql = counter.top(3);
  times.sort((a, b) => a - b);
  return {
    name,
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    max: times[times.length - 1] ?? 0,
    sql,
    bytes,
    status,
    topSql,
  };
}

// ---- the run ----

interface Options {
  readonly dataDir: string;
  readonly iterations: number;
  readonly verbose: boolean;
}

function options(argv: readonly string[]): Options {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const dataDir = flag("data") ?? ".bench/data";
  const n = Number(flag("n"));
  return {
    dataDir,
    iterations: Number.isFinite(n) && n > 0 ? n : 30,
    verbose: argv.includes("--verbose"),
  };
}

export async function runBench(opts: Options): Promise<Sample[]> {
  setLogLevel("error");
  const seedPath = `${opts.dataDir}/bench-seed.json`;
  if (!existsSync(seedPath)) {
    throw new Error(
      `no seed at ${seedPath} — run: bun run bench/seed.ts --data ${opts.dataDir}`,
    );
  }
  const seed = (await Bun.file(seedPath).json()) as SeedResult;

  const forge: Forge = createApp({ dataDir: opts.dataDir, port: 0 });
  const counter = countStatements(forge.db);
  const servers: Servers = await serve(forge);
  const base = servers.url;
  const auth = { authorization: `Bearer ${seed.token}` };

  const hit =
    (path: string, headers: Record<string, string> = {}) =>
    async (): Promise<{ status: number; bytes: number }> => {
      const response = await fetch(`${base}${path}`, { headers });
      const body = await response.arrayBuffer();
      return { status: response.status, bytes: body.byteLength };
    };

  // A signed-in browser, so the visibility joins and the pin lookups run.
  const admin = getUserByName(forge.db, seed.users[0] ?? "bench0");
  const cookie =
    admin === undefined ? {} : { cookie: sessionCookie(forge, admin.id) };

  const [hotOwner, hotName] = (seed.hotRepo ?? "bench0/hot").split("/") as [
    string,
    string,
  ];
  const n = opts.iterations;
  const samples: Sample[] = [];

  const cases: [string, () => Promise<{ status: number; bytes: number }>][] = [
    ["GET /                        (dashboard)", hit("/", cookie)],
    ["GET /api/v1/repos            (list)", hit("/api/v1/repos", auth)],
    [
      `GET /${hotOwner}/${hotName}                (repo home)`,
      hit(`/${hotOwner}/${hotName}`, cookie),
    ],
    [
      `GET /…/issues?state=all      (list, 50)`,
      hit(`/${hotOwner}/${hotName}/issues?state=all`, cookie),
    ],
    [
      `GET /…/issues/${seed.heavyIssue}            (${200} comments)`,
      hit(`/${hotOwner}/${hotName}/issues/${seed.heavyIssue}`, cookie),
    ],
    [
      `GET /…/pulls/${seed.heavyPull}             (3000-line diff)`,
      hit(`/${hotOwner}/${hotName}/pulls/${seed.heavyPull}`, cookie),
    ],
    ["GET /search?q=lamp           (search)", hit("/search?q=lamp", cookie)],
    [
      "GET /api/v1/…/issues         (api list)",
      hit(
        `/api/v1/repos/${hotOwner}/${hotName}/issues?state=all&limit=50`,
        auth,
      ),
    ],
    [
      "GET /api/v1/…/pulls          (api list)",
      hit(
        `/api/v1/repos/${hotOwner}/${hotName}/pulls?state=all&limit=50`,
        auth,
      ),
    ],
    ["GET /api/v1/user/pins        (pins)", hit("/api/v1/user/pins", auth)],
  ];

  for (const [name, run] of cases) {
    samples.push(await measure(name, n, counter, run));
  }

  // The terminal's dashboard: not an HTTP request at all, so it is measured
  // where it lives — one headless session, painted to the first settled frame.
  samples.push(
    await measure(
      "TUI dashboard frame          (headless)",
      Math.min(n, 10),
      counter,
      async () => {
        const terminal = headlessTerminal(120, 40);
        const { app } = createForgeApp(
          forge,
          {
            sshUsername: "git",
            remoteAddress: "127.0.0.1",
            fingerprint: "SHA256:bench",
            ...(admin === undefined ? {} : { user: admin }),
          },
          { terminal, exitHooks: false },
        );
        app.start();
        const deadline = Date.now() + 10_000;
        while (app.busy && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 1));
        }
        app.frame();
        const text = app.screen.toText();
        app.stop();
        return { status: text.length > 0 ? 200 : 500, bytes: text.length };
      },
    ),
  );

  servers.stop();
  counter.stop();
  forge.close();
  return samples;
}

/** A real session row, so the bench exercises the cookie path the browser uses. */
function sessionCookie(forge: Forge, userId: string): string {
  return `forge_session=${createSession(forge.db, userId).token}`;
}

export function report(samples: readonly Sample[], verbose = false): string {
  const width = Math.max(...samples.map((s) => s.name.length));
  const head = `${"endpoint".padEnd(width)}   p50 ms   p95 ms   max ms   SQL/req   bytes  status`;
  const lines = [head, "-".repeat(head.length)];
  for (const s of samples) {
    lines.push(
      [
        s.name.padEnd(width),
        s.p50.toFixed(1).padStart(8),
        s.p95.toFixed(1).padStart(8),
        s.max.toFixed(1).padStart(8),
        s.sql.toFixed(1).padStart(9),
        String(s.bytes).padStart(7),
        String(s.status).padStart(7),
      ].join(" "),
    );
    if (verbose) {
      for (const { sql, times } of s.topSql) {
        lines.push(`    ${String(times).padStart(4)}× ${sql.slice(0, 110)}`);
      }
    }
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const opts = options(process.argv.slice(2));
  const samples = await runBench(opts);
  console.log(report(samples, opts.verbose));
  process.exit(0);
}
