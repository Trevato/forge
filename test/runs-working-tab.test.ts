/**
 * The Runs page's Working tab lists only runs doing something now, and its
 * count is the flow report's building + review + checking on the same data;
 * queued runs say what they wait on, finished ones are not under Working (#7719).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { readPipeline } from "../src/flow/pipeline.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";

const page = async (query: string) =>
  await (
    await fetch(`${servers.url}/alice/shop/runs${query}`, { headers: { cookie } })
  ).text();
const rowCount = (body: string) => (body.match(/href="\/alice\/shop\/runs\/[^"]+"/g) ?? []).length;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-runs-working-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  const made = await createRepo(app, a.value, { name: "shop" });
  if (!made.ok) throw new Error(String(made.error));
  const repo = made.value;
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const make = (kind: "agent" | "check" | "deploy", state: string, reason = "") => {
    const run = createRun(app.db, { repoId: repo.id, kind, reason, env: kind === "deploy" ? "preview" : "" });
    app.db.query("UPDATE run SET state = ?1 WHERE id = ?2").run(state, run.id);
  };
  make("agent", "running", "assigned");
  make("agent", "running", "review");
  make("check", "running", "push");
  make("check", "queued", "push");
  make("agent", "queued", "assigned");
  make("deploy", "running");
  make("deploy", "ok");
  make("check", "ok", "push");
  make("agent", "failed", "assigned");
  make("agent", "ok", "assigned");
  const paused = createRun(app.db, {
    repoId: repo.id, kind: "check", reason: "push",
    notBefore: new Date(Date.now() + 3_600_000).toISOString(),
  });
  app.db.query("UPDATE run SET state = 'queued' WHERE id = ?1").run(paused.id);
  make("deploy", "queued");
});

afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("Working counts what the flow report counts as active, and nothing finished or queued", async () => {
  const stages = Object.fromEntries(readPipeline(app.db).map((s) => [s.key, s]));
  const active = ["building", "review", "checking"].reduce(
    (n, k) => n + (stages[k]?.active ?? 0),
    0,
  );
  expect(active).toBe(3);
  expect(rowCount(await page("?word=working&kind=check"))).toBe(1);
  expect(rowCount(await page("?word=working&kind=agent"))).toBe(2);
  expect(rowCount(await page("?word=working&kind=deploy"))).toBe(0);
  expect(rowCount(await page("?word=working&state=running"))).toBe(3);
  expect(rowCount(await page("?word=working&state=queued"))).toBe(0);
  expect(rowCount(await page("?word=working&state=ok"))).toBe(0);
  const body = await page("?word=working");
  expect(rowCount(body)).toBe(active);
  expect(body).not.toContain("waiting for");
});

test("a queued run says what it waits on", async () => {
  const body = await page("");
  expect(body).toContain("waiting for a builder");
  expect(body).toContain("waiting for a check slot");
});

test("a paused run and a queued deploy say what they wait on", async () => {
  const body = await page("?state=queued");
  expect(body).toContain("paused on a limit, resumes soon");
  expect(body).toContain("waiting for the deploy lane");
});
