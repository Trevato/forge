/** An app's settings form, visitors and environment are plain sections, not cards (#9854). */
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
  dataDir = await mkdtemp(join(tmpdir(), "forge-asp-"));
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

const section = (page: string, id: string): string => {
  const from = page.indexOf(`<section class="settings-block" id="${id}"`);
  expect(from).toBeGreaterThan(-1);
  return page.slice(from, page.indexOf("</section>", from));
};

test("form, visitors and environment are settings blocks without a card", async () => {
  const res = await fetch(`${servers.url}/alice/notes/settings/app`, { headers: { authorization: `Bearer ${bearer}` } });
  const page = await res.text();
  expect(res.status).toBe(200);
  for (const id of ["app", "visitors", "environment"]) {
    const s = section(page, id);
    expect(s).not.toContain('class="card');
    expect(s).toMatch(/<h2>/);
  }
  expect(section(page, "app")).toContain('action="/alice/notes/settings/app"');
  expect(section(page, "app")).toContain('name="slug"');
  expect(section(page, "environment")).toContain('action="/alice/notes/settings/app/env"');
  expect(section(page, "environment")).toContain('name="value"');
});
