/** /board/returns speaks the home page's language (#9896): one h1, each part a plain section under an h2, no card. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { recordOutsideSpend } from "../src/core/outside_spend.ts";
import { createRun } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dir = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-returns-lang-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "a@f.dev", password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error("user");
  cookie = `forge_session=${createSession(app.db, u.value.id).token}`;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const main = (page: string): string => page.slice(page.indexOf("<main"), page.indexOf("</main>"));

test("the owner's /board/returns: one h1, plain sections under h2s in order, no card", async () => {
  const res = await fetch(`${servers.url}/board/returns`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const page = main(await res.text());
  expect(page.match(/<h1[\s>]/g)?.length).toBe(1);
  expect(page).not.toContain('class="card');
  expect(page).not.toContain("card-body");
  const heads = [...page.matchAll(/<section class="stack" aria-labelledby="[^"]+">\s*<h2 [^>]*>([^<]+)<\/h2>/g)].map((m) => m[1]);
  expect(heads).toEqual(["Where it went", "What did not land, and why", "What cost the most", "A run"]);
});

test("?days= still widens the window and a stranger is still turned away", async () => {
  const res = await fetch(`${servers.url}/board/returns?days=30`, { headers: { cookie } });
  expect(await res.text()).toContain("30 days");
  const anon = await fetch(`${servers.url}/board/returns`, { redirect: "manual" });
  expect(anon.status).not.toBe(200);
});

test("with a pillar and an outside report: every part is a plain section, in order, A run last", async () => {
  const alice = getUserByName(app.db, "alice")!;
  const made = await createRepo(app, alice, { name: "mill", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const repo = made.value;
  const work = openIssue(app, alice, repo, { title: "Some work" });
  const umbrella = openIssue(app, alice, repo, { title: "P1 Ship: it" });
  if (!work.ok || !umbrella.ok) throw new Error("issues");
  addDependency(app.db, umbrella.value, work.value, alice.id);
  const r = createRun(app.db, { repoId: repo.id, kind: "agent", issueId: work.value.id, actorId: alice.id, reason: "assigned" });
  app.db
    .query("UPDATE run SET state = 'failed', cost_usd = 2.5, summary = 'failed', started_at = ?2, finished_at = ?3 WHERE id = ?1")
    .run(r.id, new Date(Date.now() - 600_000).toISOString(), new Date().toISOString());
  recordOutsideSpend(app.db, {
    repoId: repo.id, issueId: null, reporterId: alice.id, who: "the build team",
    model: "", tokensIn: 1000, tokensOut: 200, usd: 3.25, note: "",
  });
  const res = await fetch(`${servers.url}/board/returns`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const page = main(await res.text());
  expect(page.match(/<h1[\s>]/g)?.length).toBe(1);
  expect(page).not.toContain('class="card');
  expect(page).not.toContain("card-body");
  const heads = [...page.matchAll(/<section class="stack" aria-labelledby="[^"]+">\s*<h2 [^>]*>([^<]+)<\/h2>/g)].map((m) => m[1]);
  expect(heads).toEqual([
    "Where it went",
    "What did not land, and why",
    "By pillar",
    "What cost the most",
    "Reported from outside",
    "A run",
  ]);
  expect(page).toContain("the build team");
});
