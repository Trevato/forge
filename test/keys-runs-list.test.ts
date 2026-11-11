/** The runs list joins the shell's j/k row traversal (#10736): one data-nav per run, none on the empty page. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { forgeHttp, type ForgeHttp } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { expectListKeys, mainOf, navHrefs } from "./helpers/shell-page.ts";

quietLogs();
let dataDir = "";
let app: App;
let http: ForgeHttp;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-keys-runs-"));
  app = createApp({ dataDir, port: 0 });
  http = forgeHttp(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const full = await createRepo(app, admin.value, { name: "full", visibility: "public", description: "" });
  const bare = await createRepo(app, admin.value, { name: "bare", visibility: "public", description: "" });
  if (!full.ok || !bare.ok) throw new Error("repo");
  for (let i = 0; i < 3; i++) {
    const id = createRun(app.db, { repoId: full.value.id, kind: "check" }).id;
    claimRun(app.db, id);
    finishRun(app.db, id, { state: "ok", summary: "fine" });
  }
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = async (path: string) => (await http.handle(new Request(`http://forge.test${path}`))).text();

test("each run is one data-nav link; j/k focus it, Enter opens it, Esc comes back, fields keep their keys", async () => {
  const markup = mainOf(await get("/alice/full/runs"));
  const hrefs = await navHrefs(markup);
  expect(hrefs.length).toBe(3);
  expect(new Set(hrefs).size).toBe(3);
  for (const href of hrefs) expect(href).toMatch(/^\/alice\/full\/runs\/\w+/);
  await expectListKeys({ path: "/alice/full/runs", html: markup, hrefs, opened: { path: hrefs[0]!, body: "<main>run</main>" } });
});

test("the empty list draws no data-nav", async () => {
  expect(await get("/alice/bare/runs")).not.toContain("data-nav");
});
