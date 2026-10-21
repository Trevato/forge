/** `GET /apps/new` names session, orgs, agents, planner and render in Server-Timing, and stays fast (#3681). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgentRow } from "../src/core/agents.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { planningAvailable } from "../src/crew/plan.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-new-app-timing-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const mk = async (username: string, admin = false) => {
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: admin,
    });
    if (!u.ok) throw new Error(u.error);
    return u.value;
  };
  await mk("alice", true);
  proveAll(app);
  for (let i = 0; i < 50; i++) {
    const a = await mk(`bot${i}`);
    createAgentRow(app.db, { userId: a.id, model: "m", brief: "b" });
  }
  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("GET /apps/new names its phases", async () => {
  const res = await fetch(`${servers.url}/apps/new`, { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("bot49");
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  for (const name of ["app", "session", "orgs", "agents", "planner", "render"])
    expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
});

test("GET /apps/new reports its own time as a number, with 50 agents", async () => {
  const res = await fetch(`${servers.url}/apps/new`, { headers: { cookie } });
  await res.text();
  const dur = /(?:^|, )app;dur=([\d.]+)/.exec(res.headers.get("server-timing") ?? "");
  expect(Number.isFinite(Number(dur?.[1]))).toBe(true);
});

test("the planner lookup is remembered; FORGE_APP_PLAN=0 still switches it off", () => {
  const which = Bun.which;
  let calls = 0;
  (Bun as { which: unknown }).which = (b: string) => (calls++, which(b));
  try {
    const name = "forge-no-such-planner-3681";
    expect(planningAvailable(name)).toBe(false);
    expect(planningAvailable(name)).toBe(false);
    expect(calls).toBe(1);
    process.env["FORGE_APP_PLAN"] = "0";
    expect(planningAvailable("sh")).toBe(false);
  } finally {
    delete process.env["FORGE_APP_PLAN"];
    (Bun as { which: unknown }).which = which;
  }
});
