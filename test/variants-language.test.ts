/** A variants deck speaks the home page's language: sections, not cards (#9958). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

let dataDir = "";
let app: App, servers: Servers, alice: User, repo: Repo, cookie = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-variants-lang-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const r = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", allowReserved: true,
    email: "alice@f.dev", password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!r.ok) throw new Error(r.error);
  alice = r.value;
  promote(app.db, alice);
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const c = await createRepo(app, alice, { name: "garden", visibility: "public" });
  if (!c.ok) throw new Error(JSON.stringify(c));
  repo = c.value;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

function group(name: string, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const issue = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title: `${name} ${i}`, kind: "pull" });
    if (!issue.ok) throw new Error(issue.error);
    app.db
      .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, variant_group) VALUES (?1, 'main', ?2, 'a', 'b', ?3)`)
      .run(issue.value.id, `${name}-${i}`, name);
    out.push(issue.value.number);
  }
  return out;
}
const main = (page: string) => page.slice(page.indexOf("<main"), page.indexOf("</main>"));
const get = async (g: string) =>
  main(await (await fetch(`${servers.url}/alice/garden/variants/${g}`, { headers: { cookie } })).text());

test("a deck is plain sections with their forms, no card", async () => {
  const nums = group("plain", 2);
  app.db
    .query(`INSERT INTO app (id, repo_id, slug, access, preview_data) VALUES (?1, ?2, 'garden', 'public', 'copy')`)
    .run(crypto.randomUUID(), repo.id);
  const m = await get("plain");
  expect(m).not.toContain('class="card');
  expect((m.match(/class="variant-card"/g) ?? []).length).toBe(2);
  // the preview is a block whose head sits on one .bar line, not a card
  expect((m.match(/data-preview-block/g) ?? []).length).toBe(2);
  expect(m).toMatch(/<section\s+class="settings-block"\s+data-preview-block\s*>\s*<div class="bar">[\s\S]*?<h2>Preview<\/h2>/);
  for (const n of nums) {
    expect(m).toContain(`action="/alice/garden/variants/plain/${n}/like"`);
    expect(m).toContain(`action="/alice/garden/variants/plain/${n}/dislike"`);
  }
});

test("the all-decided state is one line, no card", async () => {
  const nums = group("done", 2);
  app.db.query("UPDATE issue SET state = 'closed' WHERE repo_id = ?1 AND number IN (?2, ?3)").run(repo.id, nums[0]!, nums[1]!);
  const m = await get("done");
  expect(m).not.toContain('class="card');
  expect(m).toContain("Every variant is decided.");
});

test("like still records through the plain form post", async () => {
  const [n] = group("likes", 2);
  const r = await fetch(`${servers.url}/alice/garden/variants/likes/${n}/like`, {
    method: "POST", headers: { cookie, origin: servers.url }, body: new URLSearchParams(), redirect: "manual",
  });
  expect(r.status).toBe(303);
  const rows = app.db
    .query("SELECT answer FROM decision WHERE kind = 'lean' AND issue_id = (SELECT id FROM issue WHERE repo_id = ?1 AND number = ?2)")
    .all(repo.id, n!);
  expect(rows.length).toBe(1);
});
