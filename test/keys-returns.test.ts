/** `/board/returns` joins the shell's j/k traversal (#10795): the costliest issues are data-nav rows; the figure rows are not links and stay out. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRun } from "../src/core/runs.ts";
import { forgeHttp, type ForgeHttp } from "../src/http/server.ts";
import { createSession } from "../src/core/sessions.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { expectListKeys, mainOf, navHrefs } from "./helpers/shell-page.ts";

quietLogs();
let dataDir = "";
let app: App;
let http: ForgeHttp;
let cookie = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-keys-returns-"));
  app = createApp({ dataDir, port: 0 });
  http = forgeHttp(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  cookie = `forge_session=${createSession(app.db, admin.value.id).token}`;
  const made = await createRepo(app, admin.value, { name: "mill", visibility: "public", description: "" });
  if (!made.ok) throw new Error("repo");
  for (const title of ["First work", "Second work"]) {
    const opened = openIssue(app, admin.value, made.value, { title });
    if (!opened.ok) throw new Error("issue");
    const id = createRun(app.db, { repoId: made.value.id, kind: "agent", issueId: opened.value.id, branch: "", actorId: admin.value.id, reason: "assigned" }).id;
    app.db.query("UPDATE run SET state='ok', cost_usd=1, started_at=?2, finished_at=?3 WHERE id=?1").run(id, new Date(Date.now() - 60_000).toISOString(), new Date().toISOString());
  }
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("each costliest issue is one data-nav link; j/k focus it, Enter opens it, Esc comes back, fields keep their keys", async () => {
  const res = await http.handle(new Request("http://forge.test/board/returns", { headers: { cookie } }));
  const markup = mainOf(await res.text());
  const hrefs = await navHrefs(markup);
  expect(hrefs.length).toBe(2);
  for (const href of hrefs) expect(href).toMatch(/^\/alice\/mill\/issues\/\d+$/);
  await expectListKeys({ path: "/board/returns", html: markup, hrefs, opened: { path: hrefs[0]!, body: "<main>issue</main>" } });
});
