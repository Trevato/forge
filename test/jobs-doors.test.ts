/**
 * Durable job runs through the forge's doors (#11596): the page, the API and
 * the MCP tool read the runs from the app itself, signed as a timer's delivery
 * is, and steer them with Cancel and Retry; a writer only. The app here is the
 * template's own runtime (`src/jobs.ts` in `templates/app-template.json`) behind a fake reach that
 * checks the signature the way `once.ts`'s `fromForge` does. A job that failed
 * for good asks the owner once, however many wakes it had.
 */
import { createHmac } from "node:crypto";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { JOB_WORDS, BODY_MAX, jobReach, jobRows, readCapped, steerJob } from "../src/actions/jobs.ts";
import { scheduleLines } from "../src/actions/schedules.ts";
import { fireTimer, type Reach } from "../src/apps/timer_fire.ts";
import { TEMPLATE_DIR } from "./helpers/template-app.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { armTimer, dueTimers } from "../src/core/timers.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { jobsCommands, jobsScreen } from "../src/tui/screens/jobs.ts";
import type { Ctx as TuiCtx } from "../src/tui/app/app.ts";
import type { Session } from "../src/tui/session.ts";
import { promote } from "./helpers/members.ts";

// The app's runtime is the template's own file, as a new app carries it; tsc cannot see into it, so what these tests use is named here.
interface Run { id: string; key: string; status: string }
interface Jobs {
  job(name: string, fn: (ctx: any, input: any) => Promise<unknown>): unknown;
  start(name: string, input: unknown, key?: string): Promise<Run>;
  deliver(id: string, wake?: number): Promise<string>;
  get(id: string): Run | undefined;
  list(): Run[];
}
const { Jobs, jobsRoute } = (await import(`${TEMPLATE_DIR}/src/jobs.ts`)) as { Jobs: new (db: Database, o: unknown) => Jobs; jobsRoute: (j: Jobs, r: Request, u: URL, good: boolean) => Promise<Response> };

const KEY = "an-identity-key";
const DAY = 86_400_000;

describe("job runs over the page, the API and the MCP tool", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let cy: User;
  let dee: User;
  let repo: Repo;
  let appId: string;
  let ownerRw: string;
  let readerRo: string;
  let cookie: string;
  let jobs: Jobs;
  let appAsleep = false;
  const clock = Date.parse("2026-11-12T00:00:00Z");

  // The app: the template's jobs behind the signature check, no process.
  const reach: Reach = {
    ensure: async () => (appAsleep ? undefined : 4321),
    identityKey: () => KEY,
    fetch: (async (input: string | URL, init?: RequestInit) => {
      const req = new Request(String(input), init);
      const identity = req.headers.get("x-forge-identity") ?? "";
      const [who, signed, , expires] = identity.split("|");
      const good = createHmac("sha256", KEY).update(identity).digest("base64url") === req.headers.get("x-forge-signature") && who === "forge-timer" && signed === req.headers.get("idempotency-key") && Number(expires) > clock;
      return jobsRoute(jobs, req, new URL(req.url), good);
    }) as typeof fetch,
  };

  const call = (method: string, path: string, token: string | undefined, body?: unknown) =>
    fetch(`${servers.url}${path}`, { method, headers: { connection: "close", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-jobs-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    const make = async (username: string, adminIfFirst = false) => {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    await make("ada", true);
    cy = await make("cy");
    promote(app.db, cy);
    dee = await make("dee");
    const made = await createRepo(app, cy, { name: "shop", visibility: "public", description: "" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const row = insertApp(app.db, { repoId: repo.id, slug: "shop", access: "public" });
    if (!row.ok) throw new Error(row.error);
    appId = row.value.id;
    ownerRw = createToken(app.db, cy.id, "me", "rw").token;
    readerRo = createToken(app.db, dee.id, "me", "ro").token;
    const r = await fetch(`${servers.url}/signin`, { method: "POST", body: new URLSearchParams({ username: "cy", password: "a-good-passphrase" }), redirect: "manual" });
    cookie = `${(r.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=dev`;
    jobReach.override = reach;

    // The app's runs: one sleeping, one waiting, one failed for good.
    jobs = new Jobs(new Database(":memory:"), { now: () => clock, timers: { arm: async () => undefined, cancel: async () => undefined } });
    jobs.job("remind", async (ctx) => {
      await ctx.step("load", () => 1);
      await ctx.sleep("wait", { days: 3 });
    });
    jobs.job("order", async (ctx) => ctx.waitFor("reply", { event: "reply:1" }));
    jobs.job("pay", async (ctx) => ctx.step("charge", () => { throw new Error("card <b>declined</b>"); }, { retries: 0 }));
  }, 60_000);

  afterAll(async () => {
    jobReach.override = undefined;
    servers?.stop();
    app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a writer reads each run and where it is now; a reader and a guest are refused", async () => {
    const a = await jobs.start("remind", {}, "remind:1");
    const b = await jobs.start("order", {}, "order:1");
    const c = await jobs.start("pay", {}, "pay:1");
    for (const r of [a, b, c]) await jobs.deliver(r.id);
    const rows = await jobRows(app, cy, repo);
    expect(rows.ok && rows.value.map((r) => [r.key, r.now])).toEqual([
      ["pay:1", "failed at charge"],
      ["order:1", "waiting for reply:1"],
      ["remind:1", "sleeping until 2026-11-15 00:00 UTC"],
    ]);
    expect(await jobRows(app, dee, repo)).toEqual({ ok: false, error: "forbidden" });
    expect(await jobRows(app, undefined, repo)).toMatchObject({ ok: false });
    // The API says the same, to a writer, and 404s or refuses the rest.
    const api = await call("GET", "/api/v1/repos/cy/shop/jobs", ownerRw);
    expect(api.status).toBe(200);
    expect(((await api.json()) as { items: { key: string }[] }).items.map((i) => i.key)).toEqual(["pay:1", "order:1", "remind:1"]);
    expect((await call("GET", "/api/v1/repos/cy/shop/jobs", readerRo)).status).toBeGreaterThanOrEqual(403);
  });

  test("the page lists the runs with their errors escaped, Cancel on an unfinished run and Retry on a failed one", async () => {
    const page = await (await fetch(`${servers.url}/cy/shop/app/jobs`, { headers: { cookie, connection: "close" } })).text();
    expect(page).toContain("waiting for reply:1");
    expect(page).toContain("sleeping until 2026-11-15 00:00 UTC");
    expect(page).toContain("card &lt;b&gt;declined&lt;/b&gt;");
    expect(page).not.toContain("card <b>declined");
    expect(page).toContain("Retry from the failed step");
    expect(page.match(/>\s*Cancel\s*</g)?.length).toBe(2);
    // The app page links to it once a job holds a timer.
    expect(await (await fetch(`${servers.url}/cy/shop/app`, { headers: { cookie, connection: "close" } })).text()).not.toContain("See the job runs");
    armTimer(app.db, { appId, env: "production", key: "job:abc:1", path: "/jobs/run", at: clock + DAY, timeoutMs: 1000, retries: 0 }, clock);
    expect(await (await fetch(`${servers.url}/cy/shop/app`, { headers: { cookie, connection: "close" } })).text()).toContain("See the job runs");
  });

  test("Cancel and Retry steer the run through the API, the MCP tool and the page's form; a state that does not allow it is 422", async () => {
    const [pay, order] = [jobs.list().find((r) => r.key === "pay:1")!, jobs.list().find((r) => r.key === "order:1")!];
    expect((await call("POST", `/api/v1/repos/cy/shop/jobs/${order.id}/cancel`, readerRo)).status).toBeGreaterThanOrEqual(403);
    expect(jobs.get(order.id)?.status).toBe("waiting");
    expect((await call("POST", `/api/v1/repos/cy/shop/jobs/${order.id}/cancel`, ownerRw)).status).toBe(200);
    expect(jobs.get(order.id)?.status).toBe("cancelled");
    expect((await call("POST", `/api/v1/repos/cy/shop/jobs/${order.id}/cancel`, ownerRw)).status).toBe(422);
    expect((await call("POST", `/api/v1/repos/cy/shop/jobs/${order.id}/explode`, ownerRw)).status).toBe(422);

    const heard: string[] = [];
    const off = app.bus.subscribe((e) => heard.push(e.kind));
    const mcp = await call("POST", "/mcp", ownerRw, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "app_deploy", arguments: { repo: "cy/shop", action: "retry_job", name: pay.id } } });
    expect(JSON.stringify(await mcp.json())).not.toContain("isError\":true");
    expect(jobs.get(pay.id)?.status).toBe("running");
    off();
    expect(heard).toContain("schedule.steered");
    const listed = await call("POST", "/mcp", ownerRw, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "app_deploy", arguments: { repo: "cy/shop", action: "jobs" } } });
    expect(JSON.stringify(await listed.json())).toContain("remind:1");

    // The form on the page: the same-origin check holds and the run changes.
    const form = await fetch(`${servers.url}/cy/shop/app/jobs/${jobs.list().find((r) => r.key === "remind:1")!.id}/cancel`, { method: "POST", headers: { cookie, connection: "close", origin: servers.url }, redirect: "manual" });
    expect(form.status).toBe(303);
    expect(jobs.list().find((r) => r.key === "remind:1")?.status).toBe("cancelled");
    const foreign = await fetch(`${servers.url}/cy/shop/app/jobs/${pay.id}/cancel`, { method: "POST", headers: { cookie, connection: "close", origin: "https://evil.example" }, redirect: "manual" });
    expect(foreign.status).not.toBe(303);
  });

  test("Cancel and Retry are plain POST forms, so the page works with JavaScript off", async () => {
    const page = await (await fetch(`${servers.url}/cy/shop/app/jobs`, { headers: { cookie, connection: "close" } })).text();
    const forms = page.match(/<form method="post" action="[^"]*\/app\/jobs\/[^"]+\/(?:cancel|retry)">/g) ?? [];
    expect(forms.length).toBeGreaterThan(0);
    // A guest never sees the steering forms.
    expect(await (await fetch(`${servers.url}/cy/shop/app/jobs`, { headers: { connection: "close" } })).text()).not.toContain("/app/jobs/");
  });

  test("an answer past the byte cap is read as a stream, stopped, and called unreachable", async () => {
    const big = new Response(new ReadableStream({ pull: (c) => c.enqueue(new Uint8Array(400_000).fill(32)) }));
    expect(await readCapped(big, BODY_MAX)).toBeUndefined();
    expect(await readCapped(new Response('{"runs":[]}'), BODY_MAX)).toBe('{"runs":[]}');
    const saved = reach.fetch;
    (reach as { fetch: typeof fetch }).fetch = (async () => new Response(new ReadableStream({ pull: (c) => c.enqueue(new Uint8Array(400_000).fill(32)) }))) as unknown as typeof fetch;
    try {
      expect(await jobRows(app, cy, repo)).toEqual({ ok: false, error: "unreachable" });
    } finally {
      (reach as { fetch: typeof fetch }).fetch = saved;
    }
  });

  test("the terminal door lists the runs and cancels or retries them for a writer only", async () => {
    const session = (user: User | undefined) => ({ user, db: app.db, app }) as unknown as Session;
    const toasts: string[] = [];
    const ctx = { toast: (t: string) => toasts.push(t), invalidate() {}, push() {}, theme: {} } as unknown as TuiCtx;
    // The palette offers it to a writer once the app holds a job timer, and to no one else.
    expect(jobsCommands(session(cy), ctx, repo)).toHaveLength(1);
    expect(jobsCommands(session(dee), ctx, repo)).toEqual([]);
    expect(jobsCommands(session(undefined), ctx, repo)).toEqual([]);
    expect(jobsCommands(session(cy), ctx, undefined)).toEqual([]);

    const run = await jobs.start("remind", {}, "remind:tui");
    await jobs.deliver(run.id);
    expect(jobs.get(run.id)?.status).toBe("sleeping");
    const screen = jobsScreen(session(cy), ctx, repo);
    await screen.load?.(new AbortController().signal);
    // The newest run is the cursor's: c cancels it through the same action the page uses.
    screen.key?.({ key: "c" } as never);
    await new Promise((r) => setTimeout(r, 50));
    expect(jobs.get(run.id)?.status).toBe("cancelled");
    expect(toasts.at(-1)).toBe("remind remind:tui: cancelled.");
    // A cancelled run cannot be retried: the app's refusal is said in words.
    screen.key?.({ key: "t" } as never);
    await new Promise((r) => setTimeout(r, 50));
    expect(toasts.at(-1)).toBe(JOB_WORDS.not_now);

    // A reader's screen reads nothing and steers nothing.
    const readerToasts: string[] = [];
    const readerCtx = { toast: (t: string) => readerToasts.push(t), invalidate() {}, push() {}, theme: {} } as unknown as TuiCtx;
    const reader = jobsScreen(session(dee), readerCtx, repo);
    await reader.load?.(new AbortController().signal);
    reader.key?.({ key: "c" } as never);
    await new Promise((r) => setTimeout(r, 50));
    expect(readerToasts.at(-1)).toBeUndefined();
  });

  test("an app that does not answer is said so, not guessed at", async () => {
    appAsleep = true;
    expect(await jobRows(app, cy, repo)).toEqual({ ok: false, error: "unreachable" });
    expect(await steerJob(app, cy, repo, "abc", "cancel")).toEqual({ ok: false, error: "unreachable" });
    expect((await call("GET", "/api/v1/repos/cy/shop/jobs", ownerRw)).status).toBe(502);
    appAsleep = false;
  });

  test("a run that failed for good is recorded at once, not delivered again, and asks the owner once", async () => {
    const run = await jobs.start("pay", {}, "pay:2");
    const body = JSON.stringify({ run: run.id, wake: 1 });
    armTimer(app.db, { appId, env: "production", key: `job:${run.id}:1`, path: "/jobs/run", at: clock, body: new TextEncoder().encode(body), timeoutMs: 1000, retries: 3 }, clock);
    const [t] = dueTimers(app.db, clock).filter((x) => x.key === `job:${run.id}:1`);
    // The app would sign this delivery itself; here the forge's own signer is the one under test.
    await fireTimer(app.db, reach, t!, () => clock);
    expect(dueTimers(app.db, clock + 10 * DAY).some((x) => x.key === `job:${run.id}:1`)).toBe(false);
    const lines = scheduleLines(app, cy, clock);
    const mine = lines.filter((l) => l.items[0]!.startsWith("job:"));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.line).toContain('Step "charge" failed after 1 attempt: card <b>declined</b>');
    expect(scheduleLines(app, cy, clock)[0]!.items).toEqual(lines[0]!.items);
    expect(scheduleLines(app, dee, clock)).toEqual([]);
  });
});
