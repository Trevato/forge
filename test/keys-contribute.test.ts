/** The real /contribute page: its welcomed issues are j/k rows (#10774). Focus marker, Enter, Esc, field guard; no row when none. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { expectListKeys, mainOf, navHrefs, shellPage } from "./helpers/shell-page.ts";

quietLogs();

let dir = "";
let app: App;
let servers: Servers;
let ownerId = "";
let repoId = "";
const page = async () => mainOf(await (await fetch(`${servers.url}/contribute`)).text());

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-keys-contribute-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  const repo = await createRepo(app, u.value, { name: "garden", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  ownerId = u.value.id;
  repoId = repo.value.id;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("with no welcomed issue the page draws no data-nav row", async () => {
  const html = await page();
  expect(html).toContain("No open issue carries");
  expect(html).not.toContain("data-nav");
});

test("each welcomed issue is a row: j/k focus it, Enter opens it, Esc on the issue returns, fields keep their keys", async () => {
  app.db.query("INSERT INTO label (id, repo_id, name) VALUES ('LBLW', ?1, 'help wanted')").run(repoId);
  for (const n of [1, 2]) {
    app.db.query("INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES (?1, ?2, ?3, 'issue', ?4, ?5)").run(`ISS${n}`, repoId, n, `tidy ${n}`, ownerId);
    app.db.query("INSERT INTO issue_label (issue_id, label_id) VALUES (?1, 'LBLW')").run(`ISS${n}`);
  }
  const html = await page();
  const hrefs = await navHrefs(html);
  expect(hrefs.sort()).toEqual(["/alice/garden/issues/1", "/alice/garden/issues/2"]);
  await expectListKeys({ path: "/contribute", html, hrefs: await navHrefs(html), opened: { path: hrefs[0]!, body: "<main>issue</main>" } });
  const p = await shellPage("/contribute", html);
  p.key("j");
  expect(p.doc.activeElement.getAttribute("tabindex")).toBe("-1");
});
