/**
 * The issue page's sections speak one heading: every `.card-head` on a
 * rendered issue is an icon then an `<h2>`, and nothing else. A section
 * that drops its icon, or puts its title in the body, fails here. The
 * labels and assignee cards are one function for the issue and pull pages,
 * so the heading held here is the pull page's too.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { savePicture } from "../src/core/note_pictures.ts";
import { createSession } from "../src/core/sessions.ts";
import { saveTeam } from "../src/core/teams.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { getRepoById } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

/** Every card heading in a page, as `[icon-reference, title]`, or the raw markup when it is not that shape. */
function headings(page: string): (string | [string, string])[] {
  const out: (string | [string, string])[] = [];
  for (const m of page.matchAll(/<div class="card-head">([\s\S]*?)<\/div>/g)) {
    const inner = m[1]!.replace(/\s+/g, " ").trim();
    if (!/<h2[\s>]/.test(inner)) continue; // the byline's head is not a section heading
    const shape = /^<svg[^>]*><use href="[^"]*#i-([A-Za-z]+)"\/><\/svg> <h2>([^<]+)<\/h2>$/.exec(inner);
    out.push(shape ? [shape[1]!, shape[2]!] : inner);
  }
  return out;
}

describe("the issue page's section headings", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let repoId = "";
  const cookie = () => `forge_session=${createSession(app.db, alice.id).token}`;
  const get = async (path: string) =>
    (await fetch(`${servers.url}/alice/garden${path}`, { headers: { cookie: cookie() } })).text();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-issue-page-rows-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const r = await createRepo(app, alice, { name: "garden", visibility: "private" });
    if (!r.ok) throw new Error(String(r.error));
    repoId = r.value.id;
    const seeded = await commitToBranch(app, alice, r.value, {
      message: "seed",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    saveTeam(app.db, "design", { charter: "design", dial: 1, members: [] });
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a sealed issue's private-work card has the same heading", async () => {
    const repo = getRepoById(app.db, repoId)!;
    const o = openIssue(app, alice, repo, { title: "A hole", sealed: true });
    if (!o.ok) throw new Error(o.error);
    const found = headings(await get(`/issues/${o.value.number}`));
    expect(found.filter((h) => typeof h === "string")).toEqual([]);
    expect(found.map((h) => (typeof h === "string" ? h : h[1]))).toContain("Fix it privately");
  });

  test("every section carries an icon and an h2, the same way", async () => {
    const repo = getRepoById(app.db, repoId)!;
    const o = openIssue(app, alice, repo, { title: "A chart" });
    if (!o.ok) throw new Error(o.error);
    const issue = o.value;
    const branch = "fix";
    const c = await commitToBranch(app, alice, repo, {
      branch,
      base: "main",
      message: branch,
      files: [{ path: "fix.md", content: "x\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const p = await openPull(app, alice, repo, {
      title: branch,
      body: `Closes #${issue.number}`,
      baseBranch: "main",
      headBranch: branch,
    });
    if (!p.ok) throw new Error(String(p.error));
    createRun(app.db, { repoId: repo.id, kind: "agent", issueId: issue.id, env: "main", commitOid: p.value.headOid, reason: "issue" } as never);
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    app.db
      .query("INSERT INTO app_note (id, app_id, repo_id, issue_number, visitor, name, hidden, created_at) VALUES ('note1abcdefgh','a',?1,?2,'v','n',0,?3)")
      .run(repo.id, issue.number, new Date().toISOString());
    const saved = savePicture(app.db, dataDir, { id: "note1abcdefgh", repoId: repo.id, issueNumber: issue.number }, "png", png);
    expect(saved).toBe(true);

    const found = headings(await get(`/issues/${issue.number}`));
    const titles = found.map((h) => (typeof h === "string" ? h : h[1]));
    for (const want of ["Runs", "Closes with", "Picture of the page", "Depends on", "Labels", "Assignee", "Teams"])
      expect(titles).toContain(want);
    // No heading is anything but icon + h2.
    expect(found.filter((h) => typeof h === "string")).toEqual([]);
  });
});
