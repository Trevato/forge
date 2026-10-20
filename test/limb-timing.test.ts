/** The limb preview page names session, repo, plan, pillars and render in Server-Timing (#3510). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getRepoById } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let number = 0;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-limb-timing-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  proveAll(app);
  const alice = { id: u.value.id, username: "alice" } as never;
  const made = await createRepo(app, alice, { name: "forge" });
  if (!made.ok) throw new Error(made.error);
  const repo = getRepoById(app.db, made.value.id)!;
  const opened = openIssue(app, u.value, repo, { title: "A limb" });
  if (!opened.ok) throw new Error(String(opened.error));
  number = opened.value.number;
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("GET /:owner/:name/milestones/:number/limb names its phases", async () => {
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
  const phases = async (action: string) => {
    const res = await fetch(
      `${servers.url}/alice/forge/milestones/${number}/limb?action=${action}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    await res.text();
    return (res.headers.get("server-timing") ?? "").split(", ");
  };
  const defer = await phases("defer");
  for (const name of ["app", "session", "repo", "plan", "render"])
    expect(defer.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
  expect(defer.find((p) => p.startsWith("pillars;"))).toBeUndefined();
  const resume = await phases("resume");
  expect(resume.find((p) => p.startsWith("pillars;"))).toMatch(/^pillars;dur=\d+\.\d$/);
  const replan = await phases("replan");
  for (const name of ["session", "repo", "plan", "render"])
    expect(replan.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
});
