/** The capacity settings page names its phases in Server-Timing (#3506). */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { expectWork, requestStatements } from "./helpers/work.ts";

/** The `app` phase of Server-Timing (the handler's own time, not the proxy's), or NaN. Reported, never judged (#4429). */
function appMs(res: Response): number {
  const part = (res.headers.get("server-timing") ?? "").split(",").map((p) => p.trim()).find((p) => p.startsWith("app;"));
  return Number(/dur=([\d.]+)/.exec(part ?? "")?.[1] ?? "NaN");
}

/** The calls in a spawn spy that ran git, whatever the argv shape. */
function gitCalls(calls: unknown[][]): number {
  return calls.filter((c) => {
    const first = c[0];
    const argv = Array.isArray(first) ? first : (first as { cmd?: unknown } | undefined)?.cmd;
    return Array.isArray(argv) && /(^|\/)git$/.test(String(argv[0]));
  }).length;
}

let dataDir = "";
let app: App, servers: Servers, bearer = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-captime-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the capacity page names session, capacity, errors, refused and render once each", async () => {
  const res = await fetch(`${servers.url}/settings/capacity`, { headers: { authorization: `Bearer ${bearer}` } });
  const page = await res.text();
  expect(res.status).toBe(200);
  expect(page).toContain("Errors and refused calls");
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  const names = parts.map((p) => p.split(";")[0]!);
  for (const n of ["session", "capacity", "errors", "refused", "render"]) {
    expect(names.filter((x) => x === n).length).toBe(1);
    const part = parts.find((p) => p.startsWith(`${n};`))!;
    expect(Number(/dur=([\d.]+)/.exec(part)?.[1])).not.toBeNaN();
  }
});

test("render does not include the time already named as errors", async () => {
  const errors = app.signals.errors;
  const real = errors.recent.bind(errors);
  errors.recent = ((n: number) => {
    const until = performance.now() + 80;
    while (performance.now() < until);
    return real(n);
  }) as typeof errors.recent;
  try {
    const res = await fetch(`${servers.url}/settings/capacity`, { headers: { authorization: `Bearer ${bearer}` } });
    await res.text();
    const dur = (n: string) =>
      Number(new RegExp(`(?:^|, )${n};dur=([\\d.]+)`).exec(res.headers.get("server-timing") ?? "")?.[1]);
    expect(dur("errors")).toBeGreaterThanOrEqual(80);
    expect(dur("render")).toBeLessThan(dur("errors"));
  } finally {
    errors.recent = real;
  }
});

// A warm answer costs a fixed, small number of SQL statements (#9725): work is
// counted, not timed (#7824), so a regression — an N+1 over the settings or
// the change history, a lost cache — fails every run, not a lucky one.
// 59 warm today (one more with the week.use setting), 60 once a setting is away from its default; the rest is margin.
const WARM_STATEMENTS = 69; // +1: the header Talk count (#10327)

test("a warm capacity page costs a bounded number of statements, however many changes it lists", async () => {
  const url = `${servers.url}/settings/capacity`;
  const init = { headers: { authorization: `Bearer ${bearer}` } };
  await (await fetch(url, init)).text();
  const warm = await requestStatements(app.db, url, init);
  expectWork(warm, { max: WARM_STATEMENTS });
  const change = async (n: number) => {
    const res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: { ...init.headers, origin: servers.url, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ key: "queue.batch", value: String(n) }),
    });
    expect(res.status).toBe(303);
  };
  // A setting away from its default reads who changed it; after that, more
  // history costs nothing more: twelve changes and twenty-four cost the same.
  for (let n = 1; n <= 12; n++) await change((n % 7) + 1);
  const some = await requestStatements(app.db, url, init);
  for (let n = 13; n <= 24; n++) await change((n % 7) + 1);
  const more = await requestStatements(app.db, url, init);
  expectWork(some, { max: WARM_STATEMENTS });
  expect(more).toBe(some);
});

// The warm answer, read the way /search's is (#9740, #9715): the `app` phase
// is sent and reported, never judged; the 50 ms bound is held as work — a
// bounded statement count and no git spawned (#4429).
test("a warm capacity page sends its app phase, stays under the statement ceiling and spawns no git", async () => {
  const url = `${servers.url}/settings/capacity`;
  const init = { headers: { authorization: `Bearer ${bearer}` } };
  const first = await fetch(url, init);
  expect(first.status).toBe(200);
  await first.text();
  const spawn = spyOn(Bun, "spawn");
  const spawnSync = spyOn(Bun, "spawnSync");
  try {
    const second = await fetch(url, init);
    const page = await second.text();
    expect(second.status).toBe(200);
    expect(page).toContain("Errors and refused calls");
    expect(appMs(second)).not.toBeNaN();
    expectWork(await requestStatements(app.db, url, init), { max: WARM_STATEMENTS });
    expectWork(gitCalls(spawn.mock.calls) + gitCalls(spawnSync.mock.calls), { max: 0 });
  } finally {
    spawn.mockRestore();
    spawnSync.mockRestore();
  }
});
