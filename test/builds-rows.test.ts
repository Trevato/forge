import { afterAll, beforeAll, expect, test } from "bun:test";
import { adminCookie } from "./helpers/admin.ts";
import { buildsList } from "../src/web/pages/builds.ts";
import type { BuildNode } from "../src/core/lineage.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let token = "";
const send = (path: string, method = "GET", body?: unknown) =>
  fetch(`${servers.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-builds-rows-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  await seedAdmin(app, { username: "dev", email: "d@f.dev", password: "rows-pass-1" });
  token = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "dev", password: "rows-pass-1", name: "c", scope: "rw" }),
  })
    .then((r) => r.json())
    .then((j) => (j as { token: string }).token);
  await send("/api/v1/repos", "POST", { name: "lib", visibility: "public" });
});
afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("builds: no builds is a sentence, a pin is a row in a list, and no .card", async () => {
  const empty = await (await fetch(`${servers.url}/dev/lib/builds`)).text();
  expect(empty).toContain("<h2");
  expect(empty).toContain("No builds yet.");
  expect(empty).not.toMatch(/class="card/);

  const c = await send("/api/v1/repos/dev/lib/contents", "POST", { branch: "main", message: "one", files: [{ path: "a.txt", content: "x\n" }] });
  const made = (await c.json()) as { commitOid?: string; oid?: string; sha?: string };
  const oid = made.commitOid ?? made.oid ?? made.sha;
  expect((await send("/api/v1/repos/dev/lib/builds", "POST", { label: "v1", sha: oid })).ok).toBe(true);

  const list = await (await fetch(`${servers.url}/dev/lib/builds`)).text();
  expect(list).toMatch(/<ul class="list builds">/);
  expect(list).toMatch(/<li data-depth="0">[\s\S]*?class="row"[\s\S]*?>v1</);
  expect(list).toContain("Screenshots");
  expect(list).not.toMatch(/class="card/);
  expect(list).not.toContain("build-row");
});

test("builds: a writer's rows carry Preview in a post form and Delete as a link to /-/confirm; the trail is one quiet group", () => {
  const node = {
    pin: { label: "v1", oid: "a".repeat(40), note: "v1", source: "commit", pinnedBy: "dev", pinnedAt: 0 },
    depth: 0,
    edge: "git",
  } as unknown as BuildNode;
  const out = buildsList("/dev/lib", [node], true, true, true).toString();
  expect(out).toMatch(/<form method="post" action="\/dev\/lib\/builds\/preview"[\s\S]*?<button[^>]*>[\s\S]*?Preview/);
  expect(out).toMatch(/<a class="small build-del" href="\/-\/confirm\?to=[^"]*delete"/);
  expect(out).not.toMatch(/class="card/);
  const read = buildsList("/dev/lib", [node], false, false, false).toString();
  expect(read).not.toContain("Preview");
  expect(read).not.toContain("/-/confirm");
});

test("builds/new: the pin form is the issue form's markup", async () => {
  const cookie = await adminCookie(app, { username: "ed", email: "e@f.dev", password: "rows-pass-2" });
  const form = await (await fetch(`${servers.url}/dev/lib/builds/new`, { headers: { cookie } })).text();
  expect(form).toContain('<h1 class="mt">Pin a build</h1>');
  expect(form).toContain("narrow-wide");
  expect(form).toContain('class="form-actions"');
  expect(form).toMatch(/<a\s[^>]*data-variant="link"[^>]*>Cancel<\/a/);
  expect(form).not.toMatch(/class="card/);
});
