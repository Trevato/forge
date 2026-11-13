/**
 * The apps a spawn sends down stay linked to the parent's: the child's repository carries the
 * parent's whole history (the same commit ids), follows it as an ordinary upstream, takes its new
 * commits by fast-forward and never rewrites its own, reads a private one with a credential that
 * reads that repository and nothing else, can sever it in one action, and a child spawned before
 * the link existed is offered it by its parent and takes it only when its history agrees.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { childDirOf, spawnForge } from "../src/actions/spawn.ts";
import {
  checkUpstream,
  severUpstream,
} from "../src/actions/upstream_follow.ts";
import { createApp, type App } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import { followTokenCount, revokeFollowTokens } from "../src/core/proposal_token.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import {
  followAad,
  getFollow,
  putFollow,
} from "../src/core/upstream_follow.ts";
import { createUser, type User } from "../src/core/users.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { open as openSealed } from "../src/kernel/secret.ts";
import {
  appLinkLines,
  applyAppLinks,
  entriesOf,
  reconcileAppLinks,
  appTipsFor,
} from "../src/spawn/app_links.ts";
import {
  followParentNow,
  hearLandings,
  parseHints,
} from "../src/spawn/app_follow.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { mirrorOutbound, quietLogs } from "./helpers/globals.ts";
import { listPulls } from "../src/core/pulls.ts";
import { createSession } from "../src/core/sessions.ts";
import { severForge, setFollowMode } from "../src/actions/follow.ts";
import { sendBeat } from "../src/spawn/heartbeat.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { bootHostedChild, openChildren } from "../src/spawn/host.ts";
import { watchLandings } from "../src/spawn/app_follow.ts";
import { chmodSync } from "node:fs";
import { forgetKey } from "../src/kernel/secret.ts";
import { dropServed, refreshServed, servedRows, servedWindow } from "../src/spawn/clients.ts";
import { appLinkWords, reasonOf } from "../src/spawn/app_links.ts";

quietLogs();
mirrorOutbound({ allow: ["127.0.0.1"] });

const git = async (cwd: string, ...args: string[]) => {
  const r = await runGit(
    ["-c", "user.name=t", "-c", "user.email=t@x.invalid", ...args],
    { cwd },
  );
  if (!r.ok) throw new Error(r.error.stderr);
  return r.value.trim();
};

describe("apps sent down by a spawn follow their parent", () => {
  let dir = "";
  let parent: App;
  let servers: Servers;
  let address = "";
  let alice: User;
  let notes: Repo;
  let vault: Repo;
  let other: Repo;
  const open: App[] = [];

  const land = async (repo: Repo, path: string, content = `${path}\n`) => {
    const r = await commitToBranch(parent, alice, repo, {
      message: `parent: ${path}`,
      files: [{ path, content }],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  };
  const parentDir = (repo: Repo) =>
    repoDir(parent.reposRoot, repo.ownerName, repo.name);
  const tip = (cwd: string, branch = "main") =>
    git(cwd, "rev-parse", `refs/heads/${branch}`);
  const count = (cwd: string) =>
    git(cwd, "rev-list", "--count", "refs/heads/main");

  async function spawn(name: string, apps: string[]) {
    const r = await spawnForge(
      parent,
      alice,
      { name, org: name, apps, carryBriefs: false, carrySubscriptions: false },
      {
        catalog: apps.map((ref) => ({ ref, readable: true, bytes: 1000, forgeJsonBytes: 0 })), briefs: [], subscriptions: [] },
      {
        placement: hostedPlacement({ host: "root.test" }),
        request: new Request("https://root.test/x", {
          method: "POST",
          headers: { origin: "https://root.test" },
        }),
        url: new URL("https://root.test/x"),
      },
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const dataDir = childDirOf(parent, r.value.bodyId);
    const child = createApp({ dataDir, port: 0 });
    open.push(child);
    return { child, dataDir, bodyId: r.value.bodyId };
  }
  const childRepo = (child: App, org: string, name: string) =>
    getRepo(child.db, org, name)!;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-app-links-"));
    parent = createApp({
      dataDir: join(dir, "parent"),
      port: 0,
      host: "root.test",
    });
    servers = await serve(parent);
    // The parent's public address, as the child follows it.
    address = servers.url.replace("localhost", "127.0.0.1");
    Object.assign(parent.config, { url: address });
    const u = await createUser(parent.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "a@x.test",
      isAdmin: true,
    });
    if (!u.ok) throw new Error("user");
    alice = u.value;
    for (const [name, visibility] of [
      ["notes", "public"],
      ["vault", "private"],
      ["other", "private"],
    ] as const) {
      const made = await createRepo(parent, alice, { name, visibility });
      if (!made.ok) throw new Error("repo");
      if (name === "notes") notes = made.value;
      else if (name === "vault") vault = made.value;
      else other = made.value;
    }
    for (const r of [notes, vault, other]) {
      await land(r, "README.md", `# ${r.name}\n`);
      await land(r, "a.txt");
      await land(r, "b.txt");
    }
  }, 120_000);

  afterAll(async () => {
    for (const a of open) a.close();
    await servers.stop();
    parent.close();
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  });

  describe("a child born with its apps", () => {
    let kid: Awaited<ReturnType<typeof spawn>>;

    test("each app has the parent's whole history and is linked to its upstream, taking updates", async () => {
      kid = await spawn("kid", ["alice/notes", "alice/vault"]);
      for (const [name, repo] of [
        ["notes", notes],
        ["vault", vault],
      ] as const) {
        const mine = repoDir(kid.child.reposRoot, "kid", name);
        expect(await count(mine)).toBe(await count(parentDir(repo)));
        expect(await tip(mine)).toBe(await tip(parentDir(repo)));
        const f = getFollow(
          kid.child.db,
          childRepo(kid.child, "kid", name).id,
        )!;
        expect(f.enabled).toBe(true);
        expect(f.mode).toBe("take-updates");
        expect(f.via).toBe("parent");
        expect(f.url).toBe(`${address}/alice/${name}.git`);
        expect(f.branch).toBe("main");
        expect(f.severedAt).toBeNull();
      }
      // A public app needs no credential; a private one carries a sealed one, never in the clear.
      expect(
        getFollow(kid.child.db, childRepo(kid.child, "kid", "notes").id)!
          .credentialEnc,
      ).toBe("");
      const sealed = getFollow(
        kid.child.db,
        childRepo(kid.child, "kid", "vault").id,
      )!.credentialEnc;
      expect(sealed.startsWith("v2:")).toBe(true);
      expect(
        await Bun.file(join(kid.dataDir, "parent.json")).text(),
      ).not.toContain("forge_");
      expect(followTokenCount(parent.db, vault.id, "kid")).toBe(1);
      expect(followTokenCount(parent.db, notes.id, "kid")).toBe(0);
      const entries = entriesOf(
        await Bun.file(join(kid.dataDir, "parent.json")).json(),
      );
      expect(
        entries.map((e) => [e.upstream, e.appliedAt !== undefined]),
      ).toEqual([
        ["alice/notes", true],
        ["alice/vault", true],
      ]);
    }, 240_000);

    test("when the parent's app lands a commit the child's main moves to the same commit, with no pull", async () => {
      await land(notes, "c.txt");
      const r = await checkUpstream(
        kid.child,
        childRepo(kid.child, "kid", "notes"),
      );
      expect(r.ok && r.value.outcome).toBe("forwarded");
      const mine = repoDir(kid.child.reposRoot, "kid", "notes");
      expect(await tip(mine)).toBe(await tip(parentDir(notes)));
      expect(await count(mine)).toBe(await count(parentDir(notes)));
      expect(
        listPulls(kid.child.db, childRepo(kid.child, "kid", "notes").id, {
          state: "open",
        }),
      ).toHaveLength(0);
      const taken = listEvents(kid.child.db, {
        repoId: childRepo(kid.child, "kid", "notes").id,
        kind: "forge.updates_taken",
      });
      expect(taken.length).toBe(1);
      // Looking again says nothing new.
      const again = await checkUpstream(
        kid.child,
        childRepo(kid.child, "kid", "notes"),
      );
      expect(again.ok && again.value.outcome).toBe("none");
    });

    test("a private app is fetched with the sealed credential, and the credential reads that repository and nothing else", async () => {
      await land(vault, "c.txt");
      const repo = childRepo(kid.child, "kid", "vault");
      const r = await checkUpstream(kid.child, repo);
       if (!r.ok) throw new Error(`${r.error}: ${JSON.stringify(getFollow(kid.child.db, repo.id))}`);
      expect(r.value.outcome).toBe("forwarded");
      expect(await tip(repoDir(kid.child.reposRoot, "kid", "vault"))).toBe(
        await tip(parentDir(vault)),
      );

      const token = openSealed(
        kid.dataDir,
        getFollow(kid.child.db, repo.id)!.credentialEnc,
        followAad(repo.id),
      );
      expect(token.ok).toBe(true);
      const secret = token.ok ? token.value : "";
      const auth = {
        authorization: `Basic ${Buffer.from(`follow:${secret}`).toString("base64")}`,
      };
      const get = (path: string) =>
        fetch(`${address}${path}`, { headers: auth });
      expect(
        (await get("/alice/vault.git/info/refs?service=git-upload-pack"))
          .status,
      ).toBe(200);
      // Another private repository of the same owner is not readable with it.
      expect(
        (await get("/alice/other.git/info/refs?service=git-upload-pack"))
          .status,
      ).not.toBe(200);
      // It cannot push, and it cannot open a pull.
      expect(
        (await get("/alice/vault.git/info/refs?service=git-receive-pack"))
          .status,
      ).toBe(403);
      const pull = await fetch(
        `${address}/api/v1/repos/alice/vault/pulls`,
        {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({
            title: "x",
            head: "child/kid/x",
            base: "main",
          }),
        },
      );
      expect(pull.status).toBe(403);
      // Without it the private repository is not readable.
      expect(
        (
          await fetch(
            `${address}/alice/vault.git/info/refs?service=git-upload-pack`,
          )
        ).status,
      ).not.toBe(200);
    });

    test("the parent's page lists the apps it sent and that the child follows them", async () => {
      const child = (
        await (await import("../src/actions/spawn.ts")).listChildren(parent)
      ).find((c) => c.name === "kid")!;
      const lines = await appLinkLines(parent, child);
      expect(lines.map((l) => [l.upstream, l.state, l.mode])).toEqual([
        ["alice/notes", "following", "take-updates"],
        ["alice/vault", "following", "take-updates"],
      ]);
      expect(lines.find((l) => l.upstream === "alice/vault")!.credential).toBe(
        true,
      );
      // The heartbeat answer tells a child in a cell of its own where each stands.
      expect(await appTipsFor(parent, "kid")).toEqual({
        "kid/notes": await tip(parentDir(notes)),
        "kid/vault": await tip(parentDir(vault)),
      });
    });

    test("a child with a commit of its own keeps its history: the parent's commits come as a pull, the branch is never rewritten", async () => {
      const repo = childRepo(kid.child, "kid", "notes");
      const owner = await kid.child.db
        .query<
          { id: string },
          []
        >("SELECT id FROM user WHERE username = 'alice'")
        .get();
      const mine = repoDir(kid.child.reposRoot, "kid", "notes");
      const c = await commitToBranch(
        kid.child,
        { id: owner!.id } as User,
        repo,
        { message: "kid: own", files: [{ path: "own.txt", content: "own\n" }] },
      );
      if (!c.ok) throw new Error(JSON.stringify(c.error));
      const own = await tip(mine);
      await land(notes, "d.txt");
      const r = await checkUpstream(kid.child, repo);
      expect(r.ok && r.value.outcome).toBe("proposed");
      expect(await tip(mine)).toBe(own);
      const pulls = listPulls(kid.child.db, repo.id, { state: "open" });
      expect(pulls).toHaveLength(1);
      expect(pulls[0]!.title).toContain("Upstream: 1 new commit");
      // The parent's commits are all still there, under the same ids.
      expect(
        await git(
          mine,
          "rev-list",
          "--count",
          `refs/heads/main..refs/upstream-follow/main`,
        ),
      ).toBe("1");
    });

    test("the child's tick looks at a hint from the parent and a hint of a tip it already has does nothing", async () => {
      expect(
        parseHints({
          "kid/notes": "a".repeat(40),
          "bad name": "b".repeat(40),
          x: 1,
        }),
      ).toEqual({ "kid/notes": "a".repeat(40) });
      await hearLandings(kid.child, {
        "kid/notes": await tip(parentDir(notes)),
      });
      expect(await followParentNow(kid.child)).toBeGreaterThanOrEqual(1);
    });

    test("one sever ends the link on both sides: the credential is gone, nothing is fetched, the parent revokes its own", async () => {
      const repo = childRepo(kid.child, "kid", "vault");
      const owner = await kid.child.db
        .query<
          { id: string },
          []
        >("SELECT id FROM user WHERE username = 'alice'")
        .get();
      const before = await tip(repoDir(kid.child.reposRoot, "kid", "vault"));
      const sealed = getFollow(kid.child.db, repo.id)!.credentialEnc;
      const token = openSealed(kid.dataDir, sealed, followAad(repo.id));
      const secret = token.ok ? token.value : "";
      const cut = await severUpstream(
        kid.child,
        { id: owner!.id, isAdmin: true, kind: "user" } as unknown as User,
        repo,
      );
      expect(cut.ok).toBe(true);
      const row = getFollow(kid.child.db, repo.id)!;
      expect(row.enabled).toBe(false);
      expect(row.credentialEnc).toBe("");
      expect(row.severedAt).not.toBeNull();
      const entries = entriesOf(
        await Bun.file(join(kid.dataDir, "parent.json")).json(),
      );
      expect(
        entries.find((e) => e.upstream === "alice/vault")!.severedAt,
      ).toBeDefined();
      // No further fetches.
      await land(vault, "d.txt");
      const next = await checkUpstream(kid.child, repo);
      expect(!next.ok && next.error).toBe("off");
      expect(await tip(repoDir(kid.child.reposRoot, "kid", "vault"))).toBe(
        before,
      );
      // The parent ends the credential it minted, and says the child severed.
      expect(followTokenCount(parent.db, vault.id, "kid")).toBe(1);
      const done = await reconcileAppLinks(parent, true);
      expect(done["kid"]?.revoked).toEqual(["alice/vault"]);
      expect(followTokenCount(parent.db, vault.id, "kid")).toBe(0);
      const child = (
        await (await import("../src/actions/spawn.ts")).listChildren(parent)
      ).find((c) => c.name === "kid")!;
      const lines = await appLinkLines(parent, child);
      expect(lines.find((l) => l.upstream === "alice/vault")!.state).toBe(
        "severed",
      );
      expect(lines.find((l) => l.upstream === "alice/notes")!.state).toBe(
        "following",
      );
      const auth = {
        authorization: `Basic ${Buffer.from(`follow:${secret}`).toString("base64")}`,
      };
      expect(
        (
          await fetch(
            `${address}/alice/vault.git/info/refs?service=git-upload-pack`,
            { headers: auth },
          )
        ).status,
      ).not.toBe(200);
      // A pass again offers nothing back: the sever stands.
      expect(await reconcileAppLinks(parent, true)).toEqual({});
    });
  });

  describe("what the child's owner and the parent's owner see and do", () => {
    let web: Awaited<ReturnType<typeof spawn>>;
    let childServers: Servers;
    let cookie = "";
    let admin: User;

    test("the repository page says where it comes from and offers the one sever; severing is one press", async () => {
      web = await spawn("web", ["alice/notes"]);
      childServers = await serve(web.child);
      const made = await seedAdmin(web.child, { username: "carol", email: "r@x.test" });
      if (!made.ok) throw new Error(`admin: ${made.error}`);
      admin = made.value;
      cookie = `forge_session=${createSession(web.child.db, admin.id).token}`;
      const base = childServers.url;
      const about = async () => (await fetch(`${base}/web/notes`, { headers: { cookie } })).text();
      const page = await about();
      expect(page).toContain("data-from-parent");
      expect(page).toContain(`${address.replace(/^https?:\/\//, "")}/alice/notes`);
      expect(page).toContain("takes its updates");
      expect(page).toContain("/web/notes/settings/upstream/sever");
      const refused = await fetch(`${base}/web/notes/settings/upstream/sever`, { method: "POST", headers: { cookie, origin: "https://evil.example" }, redirect: "manual" });
      expect(refused.status).toBe(403);
      const cut = await fetch(`${base}/web/notes/settings/upstream/sever`, { method: "POST", headers: { cookie, origin: base }, redirect: "manual" });
      expect(cut.status).toBe(303);
      const repo = childRepo(web.child, "web", "notes");
      expect(getFollow(web.child.db, repo.id)!.severedAt).not.toBeNull();
      const after = await about();
      expect(after).toContain("data-severed");
      expect(after).not.toContain("data-from-parent");
      // Cutting again is no error, and the day stands.
      const day = getFollow(web.child.db, repo.id)!.severedAt;
      expect((await severForge(web.child, admin, repo)).ok).toBe(true);
      expect(getFollow(web.child.db, repo.id)!.severedAt).toBe(day);
    }, 240_000);

    test("the follow mode is the one setting: take-updates, tell-me, or dont-follow, which severs", async () => {
      const again = await spawn("mode", ["alice/notes"]);
      const repo = childRepo(again.child, "mode", "notes");
      const made = await seedAdmin(again.child, { username: "carol", email: "r@x.test" });
      if (!made.ok) throw new Error(`admin: ${made.error}`);
      const set = await setFollowMode(again.child, made.value, repo, "tell-me");
      expect(set.ok && set.value).toBe("tell-me");
      expect(getFollow(again.child.db, repo.id)!.mode).toBe("tell-me");
      // A tell-me app proposes instead of moving its branch.
      await land(notes, "mode.txt");
      const r = await checkUpstream(again.child, repo);
      expect(r.ok && r.value.outcome).toBe("proposed");
      expect(await tip(repoDir(again.child.reposRoot, "mode", "notes"))).not.toBe(await tip(parentDir(notes)));
      const off = await setFollowMode(again.child, made.value, repo, "dont-follow");
      expect(off.ok).toBe(true);
      expect(getFollow(again.child.db, repo.id)!.severedAt).not.toBeNull();
      const more = await setFollowMode(again.child, made.value, repo, "take-updates");
      expect(!more.ok && more.error).toBe("severed");
    }, 240_000);

    test("the parent's list of forges says which apps it sent and whether each is still followed", async () => {
      const mine = `forge_session=${createSession(parent.db, alice.id).token}`;
      const res = await fetch(`${address}/forges`, { headers: { cookie: mine } });
      const html = (await res.text()).replace(/\s+/g, " ");
      expect(html).toContain('data-app-link="severed"');
      expect(html).toContain("alice/notes: severed by its owner");
    }, 60_000);

    test("a heartbeat's answer tells a child in a cell where its apps stand, and the child looks at once", async () => {
      const beat = await spawn("beat", ["alice/notes"]);
      await land(notes, "beat.txt");
      const repo = childRepo(beat.child, "beat", "notes");
      expect(await tip(repoDir(beat.child.reposRoot, "beat", "notes"))).not.toBe(await tip(parentDir(notes)));
      expect(await sendBeat(beat.child)).toBe(true);
      expect(await tip(repoDir(beat.child.reposRoot, "beat", "notes"))).toBe(await tip(parentDir(notes)));
      expect(getFollow(beat.child.db, repo.id)!.behind).toBe(0);
    }, 240_000);

    const until = async (check: () => Promise<boolean>, ms = 15_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await check()) return true;
        await Bun.sleep(100);
      }
      return false;
    };

    test("a child woken in the parent's process takes what it missed, and an app landing reaches it at once, with no person and no clock", async () => {
      const born = await spawn("wake", ["alice/notes"]);
      born.child.close();
      open.splice(open.indexOf(born.child), 1);
      await land(notes, "while-asleep.txt");
      await bootHostedChild(parent, "wake");
      const hosted = openChildren(parent).find((c) => c.name === "wake")!.app;
      const mine = repoDir(hosted.reposRoot, "wake", "notes");
      expect(await until(async () => (await tip(mine)) === (await tip(parentDir(notes))))).toBe(true);
      // Now awake: the next landing is passed to it by the parent, the moment it lands.
      const off = watchLandings(parent);
      try {
        await land(notes, "while-awake.txt");
        expect(await until(async () => (await tip(mine)) === (await tip(parentDir(notes))))).toBe(true);
        expect(await count(mine)).toBe(await count(parentDir(notes)));
      } finally {
        off();
      }
    }, 120_000);

    afterAll(async () => {
      await childServers?.stop();
    });
  });

  describe("a child spawned before the link existed", () => {
    /** What a child looked like then: the apps listed, no follow row, no offer. */
    async function bare(name: string) {
      const born = await spawn(name, ["alice/notes", "alice/vault"]);
      born.child.db.query("DELETE FROM repo_upstream").run();
      for (const r of [notes, vault]) revokeFollowTokens(parent.db, r.id, name);
      const doc = (await Bun.file(
        join(born.dataDir, "parent.json"),
      ).json()) as Record<string, unknown>;
      await Bun.write(
        join(born.dataDir, "parent.json"),
        JSON.stringify({
          ...doc,
          apps: [
            { repo: `${name}/notes`, upstream: "alice/notes" },
            { repo: `${name}/vault`, upstream: "alice/vault" },
          ],
        }),
      );
      return born;
    }

    test("the parent offers the link, the child takes it when its history holds the parent's commit, and says so", async () => {
      const old = await bare("old");
      // The parent has moved on since the spawn.
      await land(notes, "later.txt");
      const done = await reconcileAppLinks(parent, true);
      expect(done["old"]?.offered).toEqual(["alice/notes", "alice/vault"]);
      expect(followTokenCount(parent.db, vault.id, "old")).toBe(1);
      // Nothing is linked until the child applies it; the plain credential is only in its own file.
      expect(
        getFollow(old.child.db, childRepo(old.child, "old", "notes").id),
      ).toBeUndefined();
      const applied = await applyAppLinks(old.child);
      expect(applied.linked).toEqual(["old/notes", "old/vault"]);
      expect(applied.refused).toEqual([]);
      const f = getFollow(
        old.child.db,
        childRepo(old.child, "old", "vault").id,
      )!;
      expect([f.enabled, f.mode, f.via]).toEqual([
        true,
        "take-updates",
        "parent",
      ]);
      expect(f.credentialEnc.startsWith("v2:")).toBe(true);
      expect(
        await Bun.file(join(old.dataDir, "parent.json")).text(),
      ).not.toContain("forge_");
      const said = listEvents(old.child.db, {
        repoId: childRepo(old.child, "old", "notes").id,
        kind: "repo.upstream_follow",
      });
      expect(JSON.stringify(said.at(-1)!.payload)).toContain(
        "old/notes now follows alice/notes on",
      );
      expect(JSON.stringify(said.at(-1)!.payload)).toContain("Sever it");
      // It catches up with what it missed: fast-forward to the parent's tip.
      expect(await followParentNow(old.child)).toBe(2);
      expect(await tip(repoDir(old.child.reposRoot, "old", "notes"))).toBe(
        await tip(parentDir(notes)),
      );
      // Idempotent: the parent offers nothing again, the child applies nothing again.
      expect(await reconcileAppLinks(parent, true)).toEqual({});
      expect((await applyAppLinks(old.child)).linked).toEqual([]);
    }, 240_000);

    test("a child whose key file the forge refuses does not stop its other apps or other children, says why once by name, and links when the key is fixed", async () => {
      const stiff = await spawn("stiff", ["alice/notes", "alice/vault"]);
      const fine = await bare("fine");
      // What an older child could carry: a key file the forge refuses to open (mode 660).
      stiff.child.db.query("DELETE FROM repo_upstream").run();
      revokeFollowTokens(parent.db, notes.id, "stiff");
      revokeFollowTokens(parent.db, vault.id, "stiff");
      const doc = (await Bun.file(join(stiff.dataDir, "parent.json")).json()) as Record<string, unknown>;
      await Bun.write(
        join(stiff.dataDir, "parent.json"),
        JSON.stringify({ ...doc, apps: [{ repo: "stiff/notes", upstream: "alice/notes" }, { repo: "stiff/vault", upstream: "alice/vault" }] }),
      );
      forgetKey(stiff.dataDir);
      chmodSync(join(stiff.dataDir, "secret.key"), 0o660);
      const warned: string[] = [];
      const log = stiff.child.log as unknown as { warn: (...a: unknown[]) => void };
      const was = log.warn;
      log.warn = (...a: unknown[]) => void warned.push(JSON.stringify(a));
      try {
        await reconcileAppLinks(parent, true);
        const first = await applyAppLinks(stiff.child, "stiff");
        // The public app is linked; the private one waits, and the others are unaffected.
        expect(first.linked).toEqual(["stiff/notes"]);
        expect(getFollow(stiff.child.db, childRepo(stiff.child, "stiff", "vault").id)).toBeUndefined();
        expect((await applyAppLinks(fine.child, "fine")).linked).toEqual(["fine/notes", "fine/vault"]);
        await applyAppLinks(stiff.child, "stiff");
        await applyAppLinks(stiff.child, "stiff");
        // Said once, by name, with no path in it.
        expect(warned).toHaveLength(1);
        expect(warned[0]).toContain('"forge":"stiff"');
        expect(warned[0]).toContain("mode 660; it must be 600");
        expect(warned[0]).not.toContain(stiff.dataDir);
      } finally {
        log.warn = was;
      }
      // The parent's list says which app and why, from the child's own record.
      const kid = (await (await import("../src/actions/spawn.ts")).listChildren(parent)).find((c) => c.name === "stiff")!;
      const lines = await appLinkLines(parent, kid);
      expect(lines.find((l) => l.upstream === "alice/notes")!.state).toBe("following");
      const vaultLine = lines.find((l) => l.upstream === "alice/vault")!;
      expect(vaultLine.state).toBe("failed");
      expect(vaultLine.why).toBe("its secret key file is mode 660; it must be 600");
      expect(appLinkWords(vaultLine)).toBe("alice/vault: could not offer the link: its secret key file is mode 660; it must be 600");
      // Fixed on the host, the next pass links it, and the failure is gone from the record.
      chmodSync(join(stiff.dataDir, "secret.key"), 0o600);
      forgetKey(stiff.dataDir);
      expect((await applyAppLinks(stiff.child, "stiff")).linked).toEqual(["stiff/vault"]);
      const after = (await appLinkLines(parent, kid)).find((l) => l.upstream === "alice/vault")!;
      expect(after.state).toBe("following");
      expect(entriesOf(await Bun.file(join(stiff.dataDir, "parent.json")).json()).every((e) => e.failed === undefined)).toBe(true);
    }, 240_000);

    test("a reason has no path in it", () => {
      expect(reasonOf(new Error("/data/children/hosted-26d4fc08-aaaa/secret.key is mode 660; it must be 0600 — fix the permissions and restart"))).toBe(
        "its secret key file is mode 660; it must be 600",
      );
      expect(reasonOf(new Error("cannot open /data/children/x/forge.db now"))).toBe("cannot open <file> now");
    });

    test("the /forges list is served from memory: a change on disk shows at the next pass, not on the request", async () => {
      servedWindow.ms = 60_000;
      try {
        dropServed(parent);
        const before = await servedRows(parent);
        const row = before.find((r) => r.name === "kid")!;
        expect(row.appLinks!.find((l) => l.upstream === "alice/notes")!.state).toBe("following");
        // The child severs on its own disk; a request reads nothing of it.
        const dir = childDirOf(parent, (await (await import("../src/actions/spawn.ts")).listChildren(parent)).find((c) => c.name === "kid")!.bodyId);
        const doc = (await Bun.file(join(dir, "parent.json")).json()) as Record<string, unknown>;
        const apps = entriesOf(doc).map((e) => (e.upstream === "alice/notes" ? { ...e, severedAt: new Date().toISOString() } : e));
        await Bun.write(join(dir, "parent.json"), JSON.stringify({ ...doc, apps }));
        const during = await servedRows(parent);
        expect(during).toBe(before);
        // The pass (the minute's clock) reads it; the next request serves that.
        await refreshServed(parent, { probe: false });
        const after = (await servedRows(parent)).find((r) => r.name === "kid")!;
        expect(after.appLinks!.find((l) => l.upstream === "alice/notes")!.state).toBe("severed");
      } finally {
        servedWindow.ms = 0;
      }
    });

    test("a repository that only shares the name is never linked", async () => {
      const odd = await bare("odd");
      // Its notes is somebody's own, unrelated history under the same name.
      const mine = repoDir(odd.child.reposRoot, "odd", "notes");
      const root = await git(
        mine,
        "-c",
        "user.name=t",
        "commit-tree",
        "-m",
        "unrelated",
        "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      );
      await git(mine, "update-ref", "refs/heads/main", root);
      await reconcileAppLinks(parent, true);
      const applied = await applyAppLinks(odd.child);
      expect(applied.refused).toEqual(["odd/notes"]);
      expect(applied.linked).toEqual(["odd/vault"]);
      expect(
        getFollow(odd.child.db, childRepo(odd.child, "odd", "notes").id),
      ).toBeUndefined();
      const child = (
        await (await import("../src/actions/spawn.ts")).listChildren(parent)
      ).find((c) => c.name === "odd")!;
      expect(
        (await appLinkLines(parent, child)).find(
          (l) => l.upstream === "alice/notes",
        )!.state,
      ).toBe("not-linked");
      // Not offered again, and the refused app's credential-less offer is not retried.
      expect(await reconcileAppLinks(parent, true)).toEqual({});
    }, 240_000);

    test("a repository whose owner pointed it elsewhere, or severed before, is left as it is", async () => {
      const own = await bare("own");
      const repo = childRepo(own.child, "own", "notes");
      putFollow(own.child.db, {
        repoId: repo.id,
        url: "https://elsewhere.test/x/notes.git",
        branch: "main",
        enabled: true,
        byId: "u",
        originId: "",
      });
      await reconcileAppLinks(parent, true);
      const applied = await applyAppLinks(own.child);
      expect(applied.linked).toEqual(["own/vault"]);
      expect(getFollow(own.child.db, repo.id)!.url).toBe(
        "https://elsewhere.test/x/notes.git",
      );
      expect(getFollow(own.child.db, repo.id)!.via).toBe("");
    }, 240_000);
  });
});
