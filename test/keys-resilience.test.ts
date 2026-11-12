/**
 * /resilience: the nightly jobs' Output links are data-nav rows; j/k, Enter, Esc and the field guard
 * run on the real rendered page (#10794). The protection rows hold no link, so they stay out.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { JOBS } from "../src/nightly/jobs.ts";
import { runPath } from "../src/nightly/output.ts";
import { quietLogs } from "./helpers/globals.ts";
import { expectListKeys, mainOf } from "./helpers/shell-page.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-keys-resilience-"));
  app = createApp({ dataDir: root, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  servers = await serve(app);
  const r = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
}, 60_000);

afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const get = async (path: string) => (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();

test("each nightly job is one data-nav row; protections are not", async () => {
  const text = await get("/resilience");
  expect(text.match(/data-nav/g)?.length).toBe(JOBS.length);
  const protections = text.slice(text.indexOf('id="protections-h"'));
  expect(protections).not.toContain("data-nav");
});

test("j/k focus a nightly row, Enter opens its output, Esc on that page returns, fields are left alone", async () => {
  const text = await get("/resilience");
  const hrefs = JOBS.map((j) => runPath(j.name));
  const job = JOBS[0]!;
  await expectListKeys({
    path: "/resilience",
    html: mainOf(text),
    hrefs,
    opened: { path: runPath(job.name), body: mainOf(await get(runPath(job.name))) },
  });
});
