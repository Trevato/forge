/** An app's answers fragment names its phases in Server-Timing (#3515). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers, bearer = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-anstime-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const made = await createRepo(app, admin.value, { name: "notes", visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  const row = insertApp(app.db, { repoId: made.value.id, slug: "notes", access: "public" });
  if (!row.ok) throw new Error(row.error);
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

test("the answers fragment names session, repo, access, answers and render once each", async () => {
  const res = await fetch(`${servers.url}/alice/notes/app/answers`, { headers: { authorization: `Bearer ${bearer}` } });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("live-answers");
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  const names = parts.map((p) => p.split(";")[0]!);
  for (const n of ["session", "repo", "access", "answers", "render"]) {
    expect(names.filter((x) => x === n).length).toBe(1);
    const part = parts.find((p) => p.startsWith(`${n};`))!;
    expect(Number(/dur=([\d.]+)/.exec(part)?.[1])).not.toBeNaN();
  }
});
