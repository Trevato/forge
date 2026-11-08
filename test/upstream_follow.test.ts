/**
 * A repository's upstream setting (#3442, layer 1): stored as a row, https
 * or http only, and an admin's to read. Layer 2: its check — one at a time,
 * the vetted address, a token only to its exact https origin.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { createRepo } from "../src/actions/repos.ts";
import { listRuns } from "../src/core/runs.ts";
import { updateRepoSettings } from "../src/core/repos.ts";
import { listIssues } from "../src/core/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { landingStrategy } from "../src/crew/autonomy.ts";
import { conflictFilesOf, convergeFollowing } from "../src/crew/runner.ts";
import { taskPrompt } from "../src/crew/brief.ts";
import { audienceFilter } from "../src/core/event_audience.ts";
import { listEvents } from "../src/core/events.ts";
import { provideChecksForTest, type ChecksHandle } from "../src/checks/service.ts";
import { landIfGreen } from "../src/crew/autonomy.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { getPull, listPulls } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { checkDue, checkUpstream, mayCarryCredential } from "../src/actions/upstream_follow.ts";
import { createOrigin } from "../src/core/origins.ts";
import { runGit } from "../src/git/env.ts";
import { REMOTE_PROTOCOLS } from "../src/git/remote-env.ts";
import { repoDir } from "../src/git/repos.ts";
import { MIRROR_REFUSED, provideMirrorOutboundForTest, vettedEnv } from "../src/origins/git-mirror.ts";
import { mirrorOutbound } from "./helpers/globals.ts";
import {
  getFollow,
  listFollowing,
  noteCheck,
  putFollow,
  upstreamUrl,
} from "../src/core/upstream_follow.ts";

let dataDir = "";
let app: App;
let alice: User;
let guest: User;
let repo: Repo;
let target: Repo;
let dir = "";

const getRepoByIdFor = (id: string): Repo => getRepoById(app.db, id)!;

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-upstream-follow-"));
  app = createApp({ dataDir, port: 0 });
  const user = (username: string, extra: object = {}) =>
    createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      ...extra,
    });
  alice = ok(await user("alice", { adminIfFirst: true }));
  guest = ok(await user("guest"));
  repo = ok(await createRepo(app, alice, { name: "square", visibility: "public" }));
});

afterAll(async () => {
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("upstreamUrl", () => {
  test("https and http are accepted", () => {
    expect(upstreamUrl("https://example.com/a/b.git")).toBe("https://example.com/a/b.git");
    expect(upstreamUrl("http://example.com/a/b")).toBe("http://example.com/a/b");
  });

  for (const bad of [
    "git://example.com/a/b.git",
    "ssh://git@example.com/a/b.git",
    "file:///etc/passwd",
    "https://user:pw@example.com/a/b",
    "https://user@example.com/a/b",
    "ext::sh -c id",
    "example.com/a/b",
    "",
  ])
    test(`refuses ${JSON.stringify(bad)}`, () => {
      expect(upstreamUrl(bad)).toBeUndefined();
    });

  test("putFollow will not store one either", () => {
    expect(() =>
      putFollow(app.db, {
        repoId: repo.id,
        url: "git://example.com/a/b.git",
        branch: "main",
        enabled: true,
        byId: alice.id,
        originId: "",
      }),
    ).toThrow();
    expect(getFollow(app.db, repo.id)).toBeUndefined();
  });
});

describe("the follow row", () => {
  test("written, read, listed when on, and a new address forgets the last reading", () => {
    const put = (url: string, enabled: boolean) =>
      putFollow(app.db, { repoId: repo.id, url, branch: "main", enabled, byId: alice.id, originId: "" });
    const first = put("https://example.com/a/b.git", false);
    expect([first.url, first.enabled, first.checking, first.checkedAt]).toEqual([
      "https://example.com/a/b.git",
      false,
      null,
      null,
    ]);
    expect(listFollowing(app.db)).toEqual([]);
    put("https://example.com/a/b.git", true);
    noteCheck(app.db, repo.id, { at: "2026-10-21T00:00:00.000Z", tip: "abc", behind: 3, error: "" });
    expect(getFollow(app.db, repo.id)).toMatchObject({ enabled: true, tip: "abc", behind: 3 });
    expect(listFollowing(app.db).map((f) => f.repoId)).toEqual([repo.id]);
    expect(put("https://example.com/c/d.git", true)).toMatchObject({
      checkedAt: null,
      tip: "",
      behind: 0,
    });
  });
});

describe("who hears of it", () => {
  test("a guest's events do not carry the URL; an admin's do", () => {
    const secret = "https://private.example.com/secret/repo.git";
    app.bus.append({
      kind: "repo.upstream_follow",
      repoId: repo.id,
      actorId: alice.id,
      payload: { url: secret, enabled: true },
    });
    const seen = (viewer: User) =>
      JSON.stringify(listEvents(app.db, { repoId: repo.id }).filter(audienceFilter(app.db, viewer)));
    expect(seen(alice)).toContain(secret);
    expect(seen(guest)).not.toContain(secret);
  });
});

describe("checking an upstream (layer 2)", () => {
  beforeAll(async () => {
    target = ok(await createRepo(app, alice, { name: "checked", visibility: "public" }));
    dir = repoDir(app.reposRoot, target.ownerName, target.name);
  });
  // Given back as found: a bare `{}` here refused loopback to every file
  // after this one in its shard (#7686).
  mirrorOutbound({ allow: ["127.0.0.1"] });
  /** A server that records every request and answers with `refs` as a dumb-http `info/refs`. */
  function upstream(refs: () => string, delayMs = 0) {
    const seen: Request[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        seen.push(req);
        if (delayMs > 0) await Bun.sleep(delayMs);
        return new URL(req.url).pathname.endsWith("/info/refs")
          ? new Response(refs(), { headers: { "content-type": "text/plain" } })
          : new Response("no", { status: 404 });
      },
    });
    return { seen, server, url: `http://127.0.0.1:${server.port}/o/r.git` };
  }

  const follow = (url: string, originId = "") =>
    putFollow(app.db, { repoId: target.id, url, branch: "main", enabled: true, byId: alice.id, originId });

  describe("one check at a time", () => {
    test("a second caller while one runs is refused", async () => {
      const up = upstream(() => "", 150);
      try {
        follow(up.url);
        const [a, b] = await Promise.all([checkUpstream(app, target), checkUpstream(app, target)]);
        expect(!b.ok && b.error).toBe("busy");
        expect(a.ok).toBe(false);
        expect(!a.ok && a.error).not.toBe("busy");
        // The claim is let go: the next one runs.
        const c = await checkUpstream(app, target);
        expect(!c.ok && c.error).not.toBe("busy");
      } finally {
        up.server.stop(true);
      }
    });
  });

  describe("the vetted address", () => {
    test("is pinned in git's environment, with only https and http", async () => {
      const env = ok(await vettedEnv("http://127.0.0.1:8123/o/r.git", {}, REMOTE_PROTOCOLS));
      expect(env["GIT_ALLOW_PROTOCOL"]).toBe("https:http");
      const entries = Object.entries(env).filter(([, v]) => v === "127.0.0.1:8123:127.0.0.1");
      expect(entries.length).toBe(1);
      expect(env[entries[0]![0].replace("VALUE", "KEY")]).toBe("http.curloptResolve");
    });

    test("a private host is refused unless trusted, and nothing is fetched", async () => {
      provideMirrorOutboundForTest({});
      const up = upstream(() => "");
      try {
        follow(up.url);
        const r = await checkUpstream(app, target);
        expect(!r.ok && r.error).toBe("unreadable");
        expect(getFollow(app.db, target.id)?.error).toBe(MIRROR_REFUSED);
        expect(up.seen.length).toBe(0);
      } finally {
        provideMirrorOutboundForTest({ allow: ["127.0.0.1"] });
        up.server.stop(true);
      }
    });
  });

  describe("the credential", () => {
    test("goes only to the same scheme, host and port, over https", () => {
      const web = "https://git.example.com";
      expect(mayCarryCredential("https://git.example.com/a/b.git", web)).toBe(true);
      expect(mayCarryCredential("http://git.example.com/a/b.git", web)).toBe(false);
      expect(mayCarryCredential("https://git.example.com:8443/a/b.git", web)).toBe(false);
      expect(mayCarryCredential("https://evil.example.com/a/b.git", web)).toBe(false);
      expect(mayCarryCredential("https://git.example.com.evil.com/a", web)).toBe(false);
      expect(mayCarryCredential("https://git.example.com/a", "http://git.example.com")).toBe(false);
      expect(mayCarryCredential("not a url", web)).toBe(false);
    });

    test("an http upstream on a connected host is fetched with no Authorization", async () => {
      const up = upstream(() => "");
      try {
        const origin = ok(
          createOrigin(app.db, dataDir, {
            userId: alice.id,
            kind: "forgejo",
            apiUrl: `http://127.0.0.1:${up.server.port}/api/v1`,
            webUrl: `http://127.0.0.1:${up.server.port}`,
            login: "alice",
            token: "s3cret-token",
          }),
        );
        follow(up.url, origin.id);
        await checkUpstream(app, target);
        expect(up.seen.length).toBeGreaterThan(0);
        for (const req of up.seen) expect(req.headers.get("authorization")).toBeNull();
      } finally {
        up.server.stop(true);
      }
    });
  });

  describe("what a check records", () => {
    test("the upstream tip and how far behind, and the one pull it opens", async () => {
      const git = async (args: string[]) => ok(await runGit(args, { cwd: dir, env: ident })).trim();
      const ident = {
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@x",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@x",
      };
      const empty = await git(["hash-object", "-t", "tree", "-w", "--stdin"]).catch(() => "");
      const tree = empty || "4b825dc642cb9eb9a060e54bf8d69288fbee4904";
      const c1 = await git(["commit-tree", tree, "-m", "one"]);
      const c2 = await git(["commit-tree", tree, "-p", c1, "-m", "two"]);
      await git(["update-ref", `refs/heads/${target.defaultBranch}`, c1]);
      // Already staged, so the check reads the tip and has nothing to fetch.
      await git(["update-ref", "refs/upstream-follow/main", c2]);
      const up = upstream(() => `${c2}\trefs/heads/main\n`);
      try {
        follow(up.url);
        const r = ok(await checkUpstream(app, target));
        expect(r).toMatchObject({ tip: c2, behind: 1, outcome: "proposed" });
        const row = getFollow(app.db, target.id)!;
        expect(row.tip).toBe(c2);
        expect(row.behind).toBe(1);
        expect(row.error).toBe("");
        expect(row.pendingId).not.toBeNull();
        expect(row.opened).toBe(1);
      } finally {
        up.server.stop(true);
      }
    });
  });

  describe("proposing (layer 3)", () => {
    const ident = {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@x",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@x",
    };
    /** A fresh repository whose main holds a file, and an upstream tip staged on top of it. */
    async function staged(name: string, mainText: string, upText: string) {
      const r = ok(await createRepo(app, alice, { name, visibility: "public" }));
      const d = repoDir(app.reposRoot, r.ownerName, r.name);
      const git = async (args: string[], input?: string) =>
        ok(await runGit(args, { cwd: d, env: ident, ...(input === undefined ? {} : { stdin: input }) })).trim();
      const commit = async (text: string, parent?: string) => {
        const blob = await git(["hash-object", "-w", "--stdin"], text);
        const tree = await git(["mktree"], `100644 blob ${blob}\tf.txt\n`);
        return git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", text]);
      };
      const base = await commit("base\n");
      const main = mainText === "base\n" ? base : await commit(mainText, base);
      const up = await commit(upText, base);
      await git(["update-ref", `refs/heads/${r.defaultBranch}`, main]);
      await git(["update-ref", "refs/upstream-follow/main", up]);
      const srv = upstream(() => `${up}\trefs/heads/main\n`);
      putFollow(app.db, { repoId: r.id, url: srv.url, branch: "main", enabled: true, byId: alice.id, originId: "" });
      return { r, d, up, srv, git, main, branch: `upstream/${up.slice(0, 7)}` };
    }

    test("a clean merge pushes upstream/<tip7> and opens one pull; a second check opens nothing", async () => {
      const t = await staged("clean", "base\n", "new\n");
      try {
        const first = ok(await checkUpstream(app, t.r));
        expect(first.outcome).toBe("proposed");
        expect(await t.git(["rev-parse", `refs/heads/${t.branch}`])).toBe(t.up);
        const row = getFollow(app.db, t.r.id)!;
        expect(row.opened).toBe(1);
        expect(row.error).toBe("");
        const second = ok(await checkUpstream(app, t.r));
        expect(second.pull).toBe(first.pull);
        expect(getFollow(app.db, t.r.id)!.opened).toBe(1);
        expect(getFollow(app.db, t.r.id)!.pendingId).toBe(row.pendingId);
      } finally {
        t.srv.server.stop(true);
      }
    });

    test("the landing gate lands an upstream pull as a merge: the upstream's tip stays an ancestor of main", async () => {
      const t = await staged("lands", "base\n", "new\n");
      try {
        // Main moved too, so a merge and a squash cannot be told apart by a fast-forward.
        const blob = await t.git(["hash-object", "-w", "--stdin"], "base\n");
        const tree = await t.git(["mktree"], `100644 blob ${blob}\tf.txt\n100644 blob ${blob}\tg.txt\n`);
        const main = await t.git(["commit-tree", tree, "-p", t.main, "-m", "ours"]);
        await t.git(["update-ref", `refs/heads/${t.r.defaultBranch}`, main]);
        const opened = ok(await checkUpstream(app, t.r));
        const pull = getPull(app.db, t.r.id, opened.pull!)!;
        app.db.query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1").run(t.r.id, alice.id);
        const run = createRun(app.db, {
          repoId: t.r.id,
          kind: "check",
          issueId: pull.id,
          env: `pull-${pull.number}`,
          commitOid: pull.headOid,
          reason: "pull",
        });
        claimRun(app.db, run.id);
        finishRun(app.db, run.id, { state: "ok", summary: "check passed" });
        provideChecksForTest(app, { gate: async () => ({ ok: true, error: "", lines: [] }) } as unknown as ChecksHandle);
        const fresh = getRepoByIdFor(t.r.id);
        expect(await landIfGreen(app, fresh, getPull(app.db, t.r.id, pull.number)!)).toBe(true);
        expect(getPull(app.db, t.r.id, pull.number)!.mergedAt).not.toBeNull();
        const isAncestor = (await runGit(["merge-base", "--is-ancestor", t.up, `refs/heads/${t.r.defaultBranch}`], { cwd: t.d })).ok;
        expect(isAncestor).toBe(true);
        expect(await t.git(["rev-list", "--parents", "-n1", `refs/heads/${t.r.defaultBranch}`])).toContain(t.up);
        const after = ok(await checkUpstream(app, t.r));
        expect([after.behind, after.outcome]).toEqual([0, "none"]);
      } finally {
        t.srv.server.stop(true);
      }
    });

    test("a later tip moves the open pull instead of opening another", async () => {
      const t = await staged("moving", "base\n", "new\n");
      try {
        const first = ok(await checkUpstream(app, t.r));
        const blob = await t.git(["hash-object", "-w", "--stdin"], "newer\n");
        const tree = await t.git(["mktree"], `100644 blob ${blob}\tf.txt\n`);
        const next = await t.git(["commit-tree", tree, "-p", t.up, "-m", "newer"]);
        await t.git(["update-ref", "refs/upstream-follow/main", next]);
        t.srv.server.stop(true);
        const srv = upstream(() => `${next}\trefs/heads/main\n`);
        putFollow(app.db, { repoId: t.r.id, url: srv.url, branch: "main", enabled: true, byId: alice.id, originId: "" });
        try {
          const second = ok(await checkUpstream(app, t.r));
          expect(second.pull).toBe(first.pull);
          expect(getFollow(app.db, t.r.id)!.opened).toBe(1);
          const branch = `upstream/${next.slice(0, 7)}`;
          expect(await t.git(["rev-parse", `refs/heads/${branch}`])).toBe(next);
          const pull = getPull(app.db, t.r.id, first.pull!)!;
          expect([pull.headBranch, pull.headOid]).toEqual([branch, next]);
          expect(await t.git(["rev-parse", `refs/pull/${pull.number}/head`])).toBe(next);
          expect(pull.title).toBe("Upstream: 2 new commits on main");
          expect(pull.body).toContain(next.slice(0, 7));
          expect(pull.body).not.toContain(t.up.slice(0, 7));
        } finally {
          srv.server.stop(true);
        }
      } finally {
        t.srv.server.stop(true);
      }
    });

    test("a closed proposal for the same tip is not reopened", async () => {
      const t = await staged("closed", "base\n", "new\n");
      try {
        const first = ok(await checkUpstream(app, t.r));
        app.db.query("UPDATE issue SET state = 'closed' WHERE repo_id = ?1 AND number = ?2").run(t.r.id, first.pull!);
        const again = ok(await checkUpstream(app, t.r));
        expect(again.pull).toBe(first.pull);
        expect(getFollow(app.db, t.r.id)!.opened).toBe(1);
        expect(listPulls(app.db, t.r.id, { state: "all" }).length).toBe(1);
      } finally {
        t.srv.server.stop(true);
      }
    });

    test("a planted upstream/<tip7> fails the check, opens nothing and is left as it was", async () => {
      const t = await staged("squat", "base\n", "new\n");
      try {
        const planted = await t.git(["rev-parse", `${t.up}^`]);
        await t.git(["update-ref", `refs/heads/${t.branch}`, planted]);
        const r = await checkUpstream(app, t.r);
        expect(!r.ok && r.error).toBe("squatted");
        expect(getFollow(app.db, t.r.id)!.error).not.toBe("");
        expect(getFollow(app.db, t.r.id)!.opened).toBe(0);
        expect(getFollow(app.db, t.r.id)!.pendingId).toBeNull();
        expect(await t.git(["rev-parse", `refs/heads/${t.branch}`])).toBe(planted);
      } finally {
        t.srv.server.stop(true);
      }
    });

    /** A conflicting head with a builder on the crew; autonomy as given. */
    async function clash(name: string, autonomy: "off" | "assisted") {
      const t = await staged(name, "ours\n", "theirs\n");
      const bot = ok(await createAgent(app, alice, { username: `bot-${name}`, brief: "Be brief." }));
      expect(addToCrew(app, alice, getRepoById(app.db, t.r.id)!, `bot-${name}`).ok).toBe(true);
      updateRepoSettings(app.db, t.r, { autonomy, autonomyBy: alice.id });
      const runs = () => listRuns(app.db, t.r.id, { kind: "agent", limit: 50 }).filter((r) => r.reason === "converge");
      return { ...t, bot, runs };
    }

    test("a conflicting head starts one converge run; a second check of it starts none", async () => {
      const t = await clash("once", "assisted");
      try {
        expect(ok(await checkUpstream(app, t.r)).outcome).toBe("conflict");
        expect(t.runs().length).toBe(1);
        const run = t.runs()[0]!;
        expect(run.summary).toBe("upstream moved: f.txt");
        const issue = listIssues(app.db, t.r.id, { state: "all" }).filter((i) => i.title.startsWith("Upstream: conflict at "));
        expect(issue.length).toBe(1);
        expect(issue[0]!.title).toBe(`Upstream: conflict at ${t.up.slice(0, 7)}`);
        expect(issue[0]!.body).toContain("f.txt");
        expect(issue[0]!.body).toContain("Bring the work in.");
        expect(issue[0]!.body).toContain("is not a resolution");
        ok(await checkUpstream(app, t.r));
        ok(await checkUpstream(app, t.r));
        expect(t.runs().length).toBe(1);
        expect(getFollow(app.db, t.r.id)!.error).toBe("conflict");
        // The builder's brief names the upstream, the staged head and the files.
        const prompt = taskPrompt({
          agent: t.bot,
          repo: getRepoById(app.db, t.r.id)!,
          issue: issue[0]!,
          branch: "bot/1-upstream",
          forgeUrl: "http://forge.test",
          isApp: false,
          resuming: false,
          reason: "converge",
          comments: [],
          reviews: [],
          reviewComments: [],
          since: issue[0]!.createdAt,
          conflictFiles: ["f.txt"],
          following: { parent: t.srv.url, branch: "main", ref: "refs/upstream-follow/main", upstream: true },
        });
        expect(prompt).toContain(t.srv.url);
        expect(prompt).toContain("git fetch origin refs/upstream-follow/main && git merge FETCH_HEAD");
        expect(prompt).toContain("never rebase, squash or cherry-pick");
        expect(prompt).toContain("Bring the work in: never `-s ours`");
        expect(prompt).toContain('"f.txt"');
      } finally {
        t.srv.server.stop(true);
      }
    });

    test("the runner picks the upstream brief for an Upstream: issue and strips the summary prefix", async () => {
      const t = await clash("runner", "assisted");
      try {
        ok(await checkUpstream(app, t.r));
        const repo = getRepoById(app.db, t.r.id)!;
        const issue = listIssues(app.db, t.r.id, { state: "all" }).find((i) => i.title.startsWith("Upstream: "))!;
        expect(convergeFollowing(app, repo, issue, t.bot.user)).toEqual({
          parent: t.srv.url,
          branch: "main",
          ref: "refs/upstream-follow/main",
          upstream: true,
        });
        // An ordinary issue on a repository with no forge parent gets no upstream brief.
        expect(convergeFollowing(app, repo, { ...issue, title: "Fix the thing" }, t.bot.user)).toBeUndefined();
        expect(conflictFilesOf(t.runs()[0]!.summary)).toEqual(["f.txt"]);
        expect(conflictFilesOf("upstream moved: a.txt, b/c.txt")).toEqual(["a.txt", "b/c.txt"]);
        expect(conflictFilesOf("parent moved: x")).toEqual(["x"]);
        expect(conflictFilesOf("main moved: y")).toEqual(["y"]);
      } finally {
        t.srv.server.stop(true);
      }
    });

    test("a pull carrying the staged upstream lands as a merge; an ordinary pull squashes", async () => {
      const t = await staged("landing", "base\n", "new\n");
      try {
        const proposed = ok(await checkUpstream(app, t.r));
        const upstreamPull = getPull(app.db, t.r.id, proposed.pull!)!;
        expect(await landingStrategy(app, t.r, upstreamPull, t.main)).toBe("merge");

        const blob = await t.git(["hash-object", "-w", "--stdin"], "mine\n");
        const tree = await t.git(["mktree"], `100644 blob ${blob}\tg.txt\n`);
        const own = await t.git(["commit-tree", tree, "-p", t.main, "-m", "own"]);
        await t.git(["update-ref", "refs/heads/own-work", own]);
        const opened = ok(await openPull(app, alice, t.r, { title: "own", body: "", baseBranch: t.r.defaultBranch, headBranch: "own-work" }));
        expect(await landingStrategy(app, t.r, opened, t.main)).toBe("squash");
      } finally {
        t.srv.server.stop(true);
      }
    });

    test("with autonomy off the conflict is only noted on the row", async () => {
      const t = await clash("quiet", "off");
      try {
        expect(ok(await checkUpstream(app, t.r)).outcome).toBe("conflict");
        expect(getFollow(app.db, t.r.id)!.error).toBe("conflict");
        expect(t.runs().length).toBe(0);
        expect(listIssues(app.db, t.r.id, { state: "all" }).length).toBe(0);
      } finally {
        t.srv.server.stop(true);
      }
    });

    test("a conflicting merge is recorded as conflict and opens nothing", async () => {
      const t = await staged("clash", "ours\n", "theirs\n");
      try {
        const r = ok(await checkUpstream(app, t.r));
        expect(r.outcome).toBe("conflict");
        const row = getFollow(app.db, t.r.id)!;
        expect([row.error, row.opened, row.pendingId]).toEqual(["conflict", 0, null]);
        expect((await runGit(["rev-parse", "--verify", "-q", `refs/heads/${t.branch}`], { cwd: t.d })).ok).toBe(false);
      } finally {
        t.srv.server.stop(true);
      }
    });
  });

  test("the clock checks a due following once and leaves a fresh one alone", async () => {
    const up = upstream(() => "");
    try {
      follow(up.url);
      await checkDue(app, Date.now() + 31 * 60_000);
      const seen = up.seen.length;
      expect(seen).toBeGreaterThan(0);
      // Just checked: not due again.
      await checkDue(app, Date.now());
      expect(up.seen.length).toBe(seen);
    } finally {
      up.server.stop(true);
    }
  });
});
