/** Home's Now pages speak the home page's language (#9904): one heading, a plain list, no card boxes. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { NOW_HOLDS, NOW_STAGES, NOW_WORDS, readNowRows } from "../src/flow/now_rows.ts";
import { promote } from "./helpers/members.ts";

let dir: string;
let app: App;
let servers: Servers;
let cookie: string;
const get = (path: string) => fetch(servers.url + path, { headers: { cookie }, redirect: "manual" });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-now-lang-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const r = await createUser(app.db, { origin: "seed", trusted: true, username: "root", allowReserved: true, email: "root@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!r.ok) throw new Error(r.error);
  promote(app.db, r.value);
  cookie = `forge_session=${createSession(app.db, r.value.id).token}`;
  const repo = await createRepo(app, r.value, { name: "notes", visibility: "public" });
  if (!repo.ok) throw new Error("repo");
  const made = createIssue(app.db, { repoId: repo.value.id, authorId: r.value.id, title: "Checked <pull>", kind: "pull" });
  if (!made.ok) throw new Error(made.error);
  app.db.query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?, 'main', 'h', 'b', 'h')").run(made.value.id);
  app.db
    .query("INSERT INTO run (id, repo_id, kind, issue_id, env, state, reason) VALUES (?, ?, 'check', ?, '', 'running', '')")
    .run(crypto.randomUUID(), repo.value.id, made.value.id);
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("every Now page has one h1 and no card", async () => {
  for (const stage of NOW_STAGES) {
    const html = await (await get(`/now/${stage}`)).text();
    expect(html.match(/<h1[ >]/g)?.length, stage).toBe(1);
    expect(html, stage).not.toContain('class="card');
    expect(html, stage).not.toContain("card-body");
  }
});

test("a stage with rows lists them plainly, as many as home counts, escaped", async () => {
  const html = await (await get("/now/check")).text();
  const total = readNowRows(app.db, "check").total;
  expect(total).toBeGreaterThan(0);
  const start = html.indexOf('<ul class="list setting-list">');
  expect(start).toBeGreaterThan(-1);
  const mine = html.slice(start, html.indexOf("</ul>", start));
  expect(mine.match(/<li/g)?.length).toBe(total);
  expect(html).toContain("Checked &lt;pull&gt;");
});

test("an empty stage says so in one line", async () => {
  const stage = NOW_STAGES.find((s) => readNowRows(app.db, s).total === 0)!;
  expect(stage).toBeDefined();
  const html = await (await get(`/now/${stage}`)).text();
  expect(html).toContain(`<p class="muted">Nothing in ${NOW_WORDS[stage].toLowerCase()} right now.</p>`);
  expect(html.split(NOW_HOLDS[stage]).length - 1).toBe(1);
  expect(html).not.toContain('class="empty"');
  expect(html).not.toContain("<ul class=\"list");
});
