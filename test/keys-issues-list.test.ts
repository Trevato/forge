/** The issues list joins the shell's j/k row traversal (#10736): one data-nav per issue, none on the empty page. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { forgeHttp, type ForgeHttp } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { expectListKeys, mainOf, navHrefs } from "./helpers/shell-page.ts";

quietLogs();
let dataDir = "";
let app: App;
let http: ForgeHttp;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-keys-issues-"));
  app = createApp({ dataDir, port: 0 });
  http = forgeHttp(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const full = await createRepo(app, admin.value, { name: "full", visibility: "public", description: "" });
  const bare = await createRepo(app, admin.value, { name: "bare", visibility: "public", description: "" });
  if (!full.ok || !bare.ok) throw new Error("repo");
  for (const title of ["First", "Second", "Third"]) {
    const made = createIssue(app.db, { repoId: full.value.id, authorId: admin.value.id, title, kind: "issue" });
    if (!made.ok) throw new Error(String(made.error));
  }
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = async (path: string) => (await http.handle(new Request(`http://forge.test${path}`))).text();

test("each issue is one data-nav link; j/k focus it, Enter opens it, Esc comes back, fields keep their keys", async () => {
  const markup = mainOf(await get("/alice/full/issues"));
  const hrefs = await navHrefs(markup);
  expect(hrefs).toEqual(["/alice/full/issues/3", "/alice/full/issues/2", "/alice/full/issues/1"]);
  await expectListKeys({ path: "/alice/full/issues", html: markup, hrefs, opened: { path: hrefs[0]!, body: "<main>thread</main>" } });
});

test("the empty list draws no data-nav", async () => {
  expect(await get("/alice/bare/issues")).not.toContain("data-nav");
});
