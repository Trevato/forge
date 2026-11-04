/**
 * Folding in, end to end (#8937): the autonomy tick's own sweep admits a
 * trusted source's pull and lands it by true merge, offline, with the check
 * and the boot proof still standing and the walls still sending a pull back
 * to a person; a ring of forges stops itself; and the doors refuse a stranger.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { addTrust, setFoldInStopped } from "../src/actions/trusted_sources.ts";
import { createApp, type App } from "../src/app.ts";
import { provideChecksForTest, type ChecksHandle } from "../src/checks/service.ts";
import { createSession } from "../src/core/sessions.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { ownHost, recordPullSource, takeable, viaOf } from "../src/core/trusted_sources.ts";
import { createUser, type User } from "../src/core/users.ts";
import { landingStrategy, sweepGreen } from "../src/crew/autonomy.ts";
import { runGitCapture } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve } from "../src/http/server.ts";
import { logLevel, setLogLevel } from "../src/kernel/log.ts";

interface Forge {
  readonly app: App;
  readonly alice: User;
  readonly repo: Repo;
  readonly gated: string[];
  readonly dir: string;
}

const FROM = "git.open-platform.sh";
const dirs: string[] = [];
const apps: App[] = [];
let level: ReturnType<typeof logLevel>;

async function forge(host: string): Promise<Forge> {
  const dir = await mkdtemp(join(tmpdir(), "forge-fold-"));
  dirs.push(dir);
  const app = createApp({ dataDir: dir, port: 0, host });
  apps.push(app);
  const a = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    isAdmin: true,
  });
  if (!a.ok) throw new Error(a.error);
  const gated: string[] = [];
  provideChecksForTest(app, {
    gate: async (_repo: Repo, _pull: Pull, commitOid: string) => {
      gated.push(commitOid);
      return { ok: true, error: "", lines: [] };
    },
    spareSlots: () => 0,
  } as unknown as ChecksHandle);
  const made = await createRepo(app, a.value, { name: "lib", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  const seeded = await commitToBranch(app, a.value, made.value, {
    message: "Start",
    files: [
      { path: "README.md", content: "# lib\n" },
      { path: "forge.json", content: JSON.stringify({ check: { run: "true", fast: "true" } }) },
    ],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  app.db.query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1").run(made.value.id, a.value.id);
  const trusted = addTrust(app, a.value, { host: FROM, account: "jmoran", until: "2099-12-02" });
  if (!trusted.ok) throw new Error(trusted.error);
  return { app, alice: a.value, repo: getRepoById(app.db, made.value.id)!, gated, dir };
}

/** A pull from `source` (the follow's stamp), written by an outsider so only trust can land it; its check `state`, if any. */
async function pullFrom(
  f: Forge,
  branch: string,
  file: string,
  source: { host: string; account: string; via?: string[] },
  check: "ok" | "failed" | "none" = "ok",
): Promise<Pull> {
  const pushed = await commitToBranch(f.app, f.alice, f.repo, {
    branch,
    base: "main",
    message: `Add ${file}`,
    files: [{ path: file, content: "export const n = 1;\n" }],
  });
  if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
  const opened = await openPull(f.app, f.alice, f.repo, { title: branch, baseBranch: "main", headBranch: branch });
  if (!opened.ok) throw new Error(String(opened.error));
  f.app.db.query("UPDATE issue SET origin_author = 'outsider' WHERE id = ?1").run(opened.value.id);
  recordPullSource(f.app.db, { pullId: opened.value.id, host: source.host, account: source.account, via: source.via ?? [] });
  const pull = getPull(f.app.db, f.repo.id, opened.value.number)!;
  if (check !== "none") {
    const run = createRun(f.app.db, {
      repoId: f.repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(f.app.db, run.id);
    finishRun(f.app.db, run.id, { state: check, summary: check });
  }
  return pull;
}

const merged = (f: Forge, pull: Pull): boolean => getPull(f.app.db, f.repo.id, pull.number)!.mergedAt !== null;

async function mergeMessage(f: Forge): Promise<string> {
  const dir = repoDir(f.app.reposRoot, f.repo.ownerName, f.repo.name);
  return (await runGitCapture(["log", "-1", "--format=%B", "refs/heads/main"], { cwd: dir })).stdout;
}

beforeAll(() => {
  level = logLevel();
  setLogLevel("error");
});

afterAll(async () => {
  setLogLevel(level);
  for (const app of apps) await app.close?.();
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe("the tick's sweep admits a trusted source's pull", () => {
  let f: Forge;
  beforeAll(async () => {
    f = await forge("forge.test");
  });

  test("it lands by true merge, offline, with the check and the boot proof run and a credit trailer", async () => {
    const pull = await pullFrom(f, "t/fine", "src/fine.ts", { host: FROM, account: "jmoran" });
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("folding reached the network");
    }) as unknown as typeof fetch;
    try {
      expect(await sweepGreen(f.app, f.repo)).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(merged(f, pull)).toBe(true);
    expect(f.gated.length).toBe(1);
    const message = await mergeMessage(f);
    expect(message).toContain(`Landed-from: jmoran@${FROM}`);
    expect(viaOf(message)).toEqual([FROM, "forge.test"]);
    const dir = repoDir(f.app.reposRoot, f.repo.ownerName, f.repo.name);
    const parents = (await runGitCapture(["log", "-1", "--format=%P", "refs/heads/main"], { cwd: dir })).stdout.trim().split(" ");
    expect(parents.length).toBe(2);
  });

  test("a pull with no check yet, or a red one, goes back", async () => {
    const none = await pullFrom(f, "t/nocheck", "src/nocheck.ts", { host: FROM, account: "jmoran" }, "none");
    const red = await pullFrom(f, "t/red", "src/red.ts", { host: FROM, account: "jmoran" }, "failed");
    expect(await sweepGreen(f.app, f.repo)).toBe(0);
    expect(merged(f, none)).toBe(false);
    expect(merged(f, red)).toBe(false);
  });

  test("a pull touching the walls goes back to a person, green or not, with the reason on the ledger", async () => {
    const pull = await pullFrom(f, "t/wall", "src/crew/fold_walls.ts", { host: FROM, account: "jmoran" });
    expect(await sweepGreen(f.app, f.repo)).toBe(0);
    expect(merged(f, pull)).toBe(false);
    const row = f.app.db
      .query<{ answer: string; state: string }, [string]>("SELECT answer, state FROM decision WHERE kind = 'land' AND issue_id = ?1")
      .get(pull.id);
    expect(row?.answer).toBe("wall");
    expect(row?.state).toContain("permissions or the contract's walls");
  });

  test("a pull at a path nobody listed goes back too", async () => {
    const pull = await pullFrom(f, "t/root", "Makefile", { host: FROM, account: "jmoran" });
    expect(await sweepGreen(f.app, f.repo)).toBe(0);
    expect(merged(f, pull)).toBe(false);
  });

  test("a stranger's, the same name on another forge, waits for review", async () => {
    const pull = await pullFrom(f, "t/stranger", "src/stranger.ts", { host: "evil.example", account: "jmoran" });
    expect(await sweepGreen(f.app, f.repo)).toBe(0);
    expect(merged(f, pull)).toBe(false);
  });

  test("the kill switch holds a green trusted pull until folding resumes", async () => {
    const pull = await pullFrom(f, "t/stop", "src/stop.ts", { host: FROM, account: "jmoran" });
    setFoldInStopped(f.app, f.alice, true);
    expect(await sweepGreen(f.app, f.repo)).toBe(0);
    expect(merged(f, pull)).toBe(false);
    setFoldInStopped(f.app, f.alice, false);
    expect(await sweepGreen(f.app, f.repo)).toBe(1);
    expect(merged(f, pull)).toBe(true);
  });

  test("a lapsed trust is not honoured at the tick's own time", async () => {
    const pull = await pullFrom(f, "t/lapsed", "src/lapsed.ts", { host: FROM, account: "jmoran" });
    expect(await sweepGreen(f.app, f.repo, new Date("2100-01-01T00:00:00Z"))).toBe(0);
    expect(merged(f, pull)).toBe(false);
  });
});

describe("a ring of three forges", () => {
  test("each lands the work once and the third's hand-back to the first is refused", async () => {
    const ring = [await forge("a.test"), await forge("b.test"), await forge("c.test")];
    let via: string[] = [];
    let from = FROM;
    const taken: string[] = [];
    for (let hop = 0; hop < 6; hop++) {
      const f = ring[hop % 3]!;
      const self = ownHost(f.app.config);
      // What the follow checks before it opens anything.
      if (!takeable(via, self)) break;
      addTrust(f.app, f.alice, { host: from, account: "jmoran", until: "2099-12-02" });
      const pull = await pullFrom(f, `ring/${hop}`, `src/ring${hop}.ts`, { host: from, account: "jmoran", via });
      expect(await sweepGreen(f.app, f.repo)).toBe(1);
      expect(merged(f, pull)).toBe(true);
      via = viaOf(await mergeMessage(f));
      from = self;
      taken.push(self);
    }
    expect(taken).toEqual(["a.test", "b.test", "c.test"]);
    expect(via).toEqual([FROM, "a.test", "b.test", "c.test"]);
  });
});

describe("the doors", () => {
  test("a non-admin is refused every change; the review page labels a guest's pull Approve and a walled trusted one Merge", async () => {
    const f = await forge("doors.test");
    const bob = await createUser(f.app.db, { origin: "seed", trusted: true, username: "bob", email: "b@forge.local", password: "a-good-passphrase" });
    if (!bob.ok) throw new Error(bob.error);
    const servers = await serve(f.app);
    try {
      const as = (u: User) => ({ cookie: `forge_session=${createSession(f.app.db, u.id).token}`, origin: servers.url });
      const post = (path: string, u: User, body: string) =>
        fetch(`${servers.url}${path}`, {
          method: "POST",
          redirect: "manual",
          headers: { ...as(u), "content-type": "application/x-www-form-urlencoded" },
          body,
        });
      for (const [path, body] of [
        ["/settings/trusted", "account=zed&host=x.test&until=2099-01-01"],
        ["/settings/trusted/stop", "stop=1"],
        ["/settings/trusted/revert", `host=${FROM}&account=jmoran&confirm=1`],
        ["/settings/trusted/anything/remove", ""],
      ] as const) {
        const res = await post(path, bob.value, body);
        await res.arrayBuffer();
        expect(res.status).toBe(404);
      }
      const { listTrusted, foldInStopped } = await import("../src/core/trusted_sources.ts");
      expect(listTrusted(f.app.db).map((s) => s.account)).toEqual(["jmoran"]);
      expect(foldInStopped(f.app.db)).toBeUndefined();
      // The revert asks first: no tick, no reverts.
      const unasked = await post("/settings/trusted/revert", f.alice, `host=${FROM}&account=jmoran`);
      await unasked.arrayBuffer();
      expect(f.app.db.query("SELECT COUNT(*) AS n FROM event WHERE kind = 'trust.reverted'").get()).toEqual({ n: 0 });

      // Assisted, so a green pull waits on /review: a trusted source's that hit a wall is a person's plain Merge …
      f.app.db.query("UPDATE repo SET autonomy = 'assisted' WHERE id = ?1").run(f.repo.id);
      await pullFrom(f, "g/walled", "src/crew/autonomy.ts", { host: FROM, account: "jmoran" });
      const walled = await (await fetch(`${servers.url}/review`, { headers: as(f.alice) })).text();
      expect(walled).toContain("g/walled");
      expect(walled).toContain(">\n    Merge");
      expect(walled).not.toContain("Approve");
      // … and a guest's, from a source nobody trusts, says Approve and Decline.
      await pullFrom(f, "g/guest", "src/guest.ts", { host: "evil.example", account: "zed" });
      const both = await (await fetch(`${servers.url}/review`, { headers: as(f.alice) })).text();
      expect(both).toContain("Approve");
      expect(both).toContain("Decline");
    } finally {
      servers.stop();
    }
  });
});

describe("the landing reads the clock it is given", () => {
  test("a trusted source's pull merges while the trust holds, and squashes once it has lapsed", async () => {
    const f = await forge("clock.test");
    const pull = await pullFrom(f, "g/clock", "src/clock.ts", { host: FROM, account: "jmoran" });
    const dir = repoDir(f.app.reposRoot, f.repo.ownerName, f.repo.name);
    const base = (await runGitCapture(["rev-parse", "refs/heads/main"], { cwd: dir })).stdout.trim();
    expect(await landingStrategy(f.app, f.repo, pull, base, new Date("2099-12-01T00:00:00Z"))).toBe("merge");
    expect(await landingStrategy(f.app, f.repo, pull, base, new Date("2099-12-03T00:00:00Z"))).toBe("squash");
  });
});
