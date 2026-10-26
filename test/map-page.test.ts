/** `/:owner/:name/map` draws open issues; `?done=1` draws the closed ones too (#6174). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { setIssueState } from "../src/core/issues.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const CLOSED = 2000;
const OPEN = 300;
let root = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-map-page-"));
  app = createApp({ dataDir: root, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  const alice = u.value;
  const made = await createRepo(app, alice, { name: "big", visibility: "private" });
  if (!made.ok) throw new Error(made.error);
  const repo = made.value;
  const open = [];
  for (let i = 0; i < OPEN; i++) {
    const o = await openIssue(app, alice, repo, { title: `Open work ${i}` });
    if (!o.ok) throw new Error(o.error);
    open.push(o.value);
  }
  for (let i = 0; i < CLOSED; i++) {
    const c = await openIssue(app, alice, repo, { title: `Closed work ${i}` });
    if (!c.ok) throw new Error(c.error);
    const dep = addDependency(app.db, open[i % OPEN]!, c.value, alice.id);
    if (!dep.ok) throw new Error(dep.error);
    setIssueState(app.db, c.value.id, "closed");
  }
  servers = await serve(app);
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}, 120_000);
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const get = async (path: string): Promise<string> => {
  const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return res.text();
};

test("the default map draws only open issues, under 400 KB, with a Show done link", async () => {
  const body = await get("/alice/big/map");
  expect(body).toContain("Open work 0");
  expect(body).not.toContain("Closed work");
  expect(Buffer.byteLength(body)).toBeLessThan(400 * 1024);
  expect(body).toContain(`<span class="badge" data-variant="outline" data-state="done">done <b>${CLOSED}</b></span>`);
  expect(body).toMatch(/<a\s+class="map-toggle"\s+href="\/alice\/big\/map\?done=1"\s*>Show done/);
  expect(body).not.toContain("Open only");
});

test("a closed blocker still frees what it held", async () => {
  const body = await get("/alice/big/map");
  expect(body).toMatch(/ready\s*<b>300<\/b>/);
});

test("?done=1 draws the closed issues and offers Open only", async () => {
  const body = await get("/alice/big/map?done=1");
  expect(body).toContain("Closed work 1999"); 
  expect(body).toMatch(/<a\s+class="map-toggle"\s+href="\/alice\/big\/map"\s*>Open only/);
  expect(body).not.toContain("Show done");
});
