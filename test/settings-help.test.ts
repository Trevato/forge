/** A repository's Settings and App settings open each section on its control; the explanations sit behind one `?` (#11210). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { setMirrorTarget, deleteMirrorTarget } from "../src/core/migrate_mirror.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers, bearer = "", repoId = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-sethelp-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const made = await createRepo(app, admin.value, { name: "notes", visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  repoId = made.value.id;
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

const get = async (path: string) => {
  const res = await fetch(`${servers.url}${path}`, { headers: { authorization: `Bearer ${bearer}` } });
  expect(res.status).toBe(200);
  return res.text();
};

test("Settings keeps its explanations in the one help, open on ?help", async () => {
  const closed = await get("/alice/notes/settings");
  expect(closed.match(/data-page-help/g)?.length).toBe(1);
  expect(closed).not.toContain("data-page-help open");
  expect(closed).toContain("Opens a pull that adds the next");
  expect(closed.indexOf("Opens a pull that adds the next")).toBeGreaterThan(closed.indexOf("data-page-help"));
  expect(closed).not.toContain('<p class="muted">\n        Opens a pull');
  expect((await get("/alice/notes/settings?help")).includes("data-page-help open")).toBe(true);
});

test("App settings keeps traffic, environment, access and domains words in the one help", async () => {
  const page = await get("/alice/notes/settings/app");
  expect(page.match(/data-page-help/g)?.length).toBe(1);
  const help = page.slice(page.indexOf("data-page-help"), page.indexOf("</details>", page.indexOf("data-page-help")));
  for (const w of ["Counted by the beacon", "write-only", "read-only token", "publish the two records"]) {
    expect(help).toContain(w);
    expect(page.split(w).length - 1).toBe(1);
  }
  expect(await get("/alice/notes/settings/app?help")).toContain("data-page-help open");
});

test("the mirror warning sits once, beside Stop mirroring; a repository with no mirror or trail has neither entry", async () => {
  const bare = await get("/alice/notes/settings?help");
  expect(bare).not.toContain("Stopping leaves");
  expect(bare).not.toContain("Where this came from");
  expect(bare).not.toContain("Stop mirroring");
  const repo = { id: repoId };
  app.db.run("PRAGMA foreign_keys = OFF");
  setMirrorTarget(app.db, { repoId: repo.id, originId: "o1", fullName: "octo/notes", cloneUrl: "https://code.example/octo/notes.git", tips: {} });
  try {
    const page = await get("/alice/notes/settings");
    expect(page.split("Stopping leaves octo/notes as it is").length - 1).toBe(1);
    expect(page.indexOf("Stopping leaves")).toBeLessThan(page.indexOf("Stop mirroring"));
  } finally {
    deleteMirrorTarget(app.db, repo.id);
  }
});
