/**
 * Muting a repository from the home's needs-you (#1597): its asks leave the
 * viewer's home, `/api/v1/asks` (and so the inbox and the phone, which read
 * `askLinesFor`) and On you; they still exist, and still count on the
 * repository's own page. Unmuting brings them back.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getIssueById } from "../src/core/issues.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { mutedRepos } from "../src/core/interactions.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { askCountFor, askLinesFor, repoAsks } from "../src/web/studio/asks.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-mute-passphrase";

describe("muting a repository's asks", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let cookie = "";
  let bobCookie = "";
  let repo: Repo;
  let pullId = "";

  const headers = (c: string) => ({ cookie: `${c}; forge_mode=studio`, origin: servers.url });
  const post = (c: string, path: string, fields: [string, string][]) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      headers: headers(c),
      body: new URLSearchParams(fields),
      redirect: "manual",
    });
  const onYou = async () =>
    await fetch(`${servers.url}/live/on-you`, { headers: headers(cookie) }).then((r) => r.text());
  const apiAsks = async () => {
    const token = createToken(app.db, alice.id, "ro", "ro").token;
    const res = await fetch(`${servers.url}/api/v1/asks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return ((await res.json()) as { rows: unknown[] }).rows;
  };
  const home = async () =>
    await fetch(`${servers.url}/`, { headers: headers(cookie) }).then((r) => r.text());

  const signIn = async (username: string) => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: PASSWORD }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-asks-mute-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const name of ["alice", "bob"]) {
      const made = await createUser(app.db, {
        trusted: true,
        username: name,
        email: `${name}@forge.local`,
        password: PASSWORD,
        adminIfFirst: name === "alice",
      });
      if (!made.ok) throw new Error(made.error);
      if (name === "alice") alice = made.value;
      else bob = made.value;
    }
    cookie = await signIn("alice");
    bobCookie = await signIn("bob");
    await createAgent(app, alice, { username: "bot" });
    const made = await createRepo(app, alice, { name: "muted", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# muted\n" }],
    });
    addToCrew(app, alice, repo, "bot");
    await commitToBranch(app, alice, repo, {
      branch: "bot/1",
      base: "main",
      message: "Muted work",
      files: [{ path: "F.md", content: "1\n" }],
    });
    const opened = await openPull(app, getUserByName(app.db, "bot")!, repo, {
      title: "Muted work",
      body: "",
      baseBranch: "main",
      headBranch: "bot/1",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    pullId = opened.value.id;
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pullId,
      env: `pull-${opened.value.number}`,
      commitOid: opened.value.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "ok" });
    expect(assignIssue(app, alice, repo, getIssueById(app.db, pullId)!, alice).ok).toBe(true);
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the home offers the chip, and a muted repository's pull leaves every list", async () => {
    expect(askLinesFor(app.db, alice)).toHaveLength(1);
    expect(await apiAsks()).toHaveLength(1);
    expect(await onYou()).toContain("Muted work");
    const page = await home();
    expect(page).toContain('action="/asks/mute"');
    expect(page).toContain(`value="${repo.id}"`);

    const res = await post(cookie, "/asks/mute", [["repo", repo.id]]);
    expect(res.status).toBe(303);
    expect(mutedRepos(app.db, alice.id).has(repo.id)).toBe(true);
    // Idempotent: twice is the same as once.
    await post(cookie, "/asks/mute", [["repo", repo.id]]);
    expect(
      app.db.query("SELECT COUNT(*) AS n FROM interaction WHERE viewer_id = ?1 AND kind = 'muted'").get(alice.id),
    ).toEqual({ n: 1 });

    expect(await onYou()).not.toContain("Muted work");
    expect(await apiAsks()).toHaveLength(0);
    expect(askLinesFor(app.db, alice)).toHaveLength(0);
    expect(askCountFor({ app, auth: { user: alice } } as never, alice)).toBe(0);
    // Said, never silent: the home names what it is holding back.
    const muted = await home();
    expect(muted).not.toContain('action="/asks/mute"');
    expect(muted).toContain("Listen again");
  });

  test("the ask still exists and still counts on the repository's own page", async () => {
    expect(repoAsks(app.db, alice, repo)).toEqual({ count: 1, muted: true });
    // The repository's page is the app's once it is one.
    expect(createAppRecord(app.db, { repoId: repo.id, slug: "muted", access: "public" }).ok).toBe(true);
    const page = await fetch(`${servers.url}/alice/muted`, { headers: headers(cookie) });
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain('id="repo-asks"');
    expect(text).toContain("(muted from your home)");
  });

  test("another person's mute is theirs alone, and a repository they cannot read is refused", async () => {
    expect(mutedRepos(app.db, bob.id).has(repo.id)).toBe(false);
    const bad = await post(bobCookie, "/asks/mute", [["repo", "nope"]]);
    expect(bad.status).toBe(404);
    const secret = await createRepo(app, alice, { name: "secret", visibility: "private" });
    if (!secret.ok) throw new Error(String(secret.error));
    const hidden = await post(bobCookie, "/asks/mute", [["repo", secret.value.id]]);
    expect(hidden.status).toBe(404);
    expect(mutedRepos(app.db, bob.id).size).toBe(0);
    const odd = await post(cookie, "/asks/mute", [["repo", "../x"]]);
    expect(odd.status).toBe(404);
    // A mutation from another origin is refused.
    const cross = await fetch(`${servers.url}/asks/mute`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.example" },
      body: new URLSearchParams({ repo: repo.id }),
      redirect: "manual",
    });
    expect(cross.status).toBeGreaterThanOrEqual(400);
  });

  test("listening again brings the asks back", async () => {
    const res = await post(cookie, "/asks/listen", [["repo", repo.id]]);
    expect(res.status).toBe(303);
    expect(mutedRepos(app.db, alice.id).has(repo.id)).toBe(false);
    expect(await apiAsks()).toHaveLength(1);
    expect(await onYou()).toContain("Muted work");
    expect(repoAsks(app.db, alice, repo)).toEqual({ count: 1, muted: false });
  });
});
