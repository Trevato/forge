/**
 * A repository follows several sources (#9003): the trust list shows its date
 * and how long is left; a source of a trusted account opens one stamped pull
 * and moves it as the source moves; a conflict goes to the crew once; a big
 * first fold waits for the crew's review. Sources are read from a fake
 * Forgejo (a dumb-http `info/refs`), with the tip staged as a fetch leaves it.
 */
import { promote } from "./helpers/members.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { addFollowSources, parseSourceLine, removeFollowSource } from "../src/actions/follow_sources.ts";
import { openPull } from "../src/actions/pulls.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addTrust } from "../src/actions/trusted_sources.ts";
import { checkDue, checkSource } from "../src/actions/upstream_follow.ts";
import { landingStrategy, reviewed, sweepGreen } from "../src/crew/autonomy.ts";
import { provideChecksForTest, type ChecksHandle } from "../src/checks/service.ts";
import { lastWaits } from "../src/crew/waits.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { id as newId } from "../src/kernel/id.ts";
import { createApp, type App } from "../src/app.ts";
import { sourcesScreen } from "../src/tui/screens/sources.ts";
import type { Ctx, Screen } from "../src/tui/app/app.ts";
import type { Session } from "../src/tui/session.ts";
import { listSources, openConflictOf, sourceRef } from "../src/core/follow_sources.ts";
import { listIssues } from "../src/core/issues.ts";
import { getPull } from "../src/core/pulls.ts";
import { recordProvenance } from "../src/core/provenance.ts";
import { getRepoById, updateRepoSettings } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import {
  adoptResolution,
  BIG_FOLD_COMMITS,
  foldsIn,
  isTrusted,
  leftWords,
  needsCrewReview,
  pullSourceOf,
  trustSource,
} from "../src/core/trusted_sources.ts";
import { createUser, type User } from "../src/core/users.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve } from "../src/http/server.ts";
import { mirrorOutbound, quietLogs } from "./helpers/globals.ts";
import { askForReviews } from "./helpers/reviews.ts";

quietLogs();
mirrorOutbound({ allow: ["127.0.0.1"] });

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

let dataDir = "";
let app: App;
let alice: User;
let guest: User;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-sources-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
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
});

afterAll(async () => {
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("a trust shows its date and what is left", () => {
  const now = new Date("2026-11-03T01:26:00Z");

  test("a date-only entry is active, not already lapsed", () => {
    const made = trustSource(app.db, { host: "git.open-platform.sh", account: "jmoran", until: "2026-12-02", setBy: "alice" }, now);
    if (typeof made === "string") throw new Error(made);
    expect(made.until).toBe("2026-12-02T23:59:59.999Z");
    expect(isTrusted(app.db, "git.open-platform.sh", "jmoran", now)).toBe(true);
    expect(leftWords(made.until, now)).toBe("29 days left");
  });

  test("the words for the last day, and for an end that has passed", () => {
    expect(leftWords("2026-11-03T20:00:00.000Z", now)).toBe("less than a day left");
    expect(leftWords("2026-11-04T23:59:59.999Z", now)).toBe("1 day left");
    expect(leftWords("2026-11-02T23:59:59.999Z", now)).toBe("lapsed");
    expect(leftWords("nonsense", now)).toBe("lapsed");
  });

  for (const bad of ["", "tomorrow", "12/02/2026", "2026-12-02T10:00:00Z", "2026-02-31", "2026-13-01", "2026-00-10"])
    test(`refuses ${JSON.stringify(bad)}`, () => {
      expect(trustSource(app.db, { host: "h.test", account: "x", until: bad, setBy: "t" }, now)).toBe("bad_date");
    });

  test("the settings page says the date and the days left, never 'just now'", async () => {
    ok(addTrust(app, alice, { host: "forge-apps.benjivers.com", account: "benjivers", until: "2099-12-02" }));
    const servers = await serve(app);
    try {
      const res = await fetch(`${servers.url}/settings/trusted`, {
        headers: { cookie: `forge_session=${createSession(app.db, alice.id).token}` },
      });
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).toContain("2099-12-02");
      expect(text).toMatch(/\(\d+ days left\)/);
      expect(text).not.toContain("just now");
    } finally {
      servers.stop();
    }
  });
});

describe("the add form's lines", () => {
  test("an address, a branch, an account", () => {
    expect(ok(parseSourceLine("https://git.open-platform.sh/jmoran/forge-jay.git"))).toEqual({
      url: "https://git.open-platform.sh/jmoran/forge-jay.git",
      branch: "main",
      account: "",
    });
    expect(ok(parseSourceLine("forge-apps.benjivers.com/apps/foundry.git dev as Benjivers"))).toEqual({
      url: "https://forge-apps.benjivers.com/apps/foundry.git",
      branch: "dev",
      account: "benjivers",
    });
  });
  for (const bad of ["", "git://x.test/a/b", "ssh://git@x.test/a/b", "https://u:p@x.test/a/b", "https://x.test/a/b main extra", "https://x.test/a/b as"])
    test(`refuses ${JSON.stringify(bad)}`, () => {
      expect(parseSourceLine(bad).ok).toBe(false);
    });
  test("a branch git would take for a flag is refused", () => {
    expect(parseSourceLine("https://x.test/a/b --upload-pack=x")).toEqual({ ok: false, error: "invalid_branch" });
  });
});

describe("following several sources", () => {
  const ident = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@x" };

  /** A fake Forgejo: answers `info/refs` for each path with the tip it is given. */
  function forgejo(tips: Map<string, string>, hold?: Promise<void>) {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        await hold;
        const url = new URL(req.url);
        const path = url.pathname.replace(/\/info\/refs$/, "");
        const tip = tips.get(path);
        return url.pathname.endsWith("/info/refs") && tip !== undefined
          ? new Response(`${tip}\trefs/heads/main\n`, { headers: { "content-type": "text/plain" } })
          : new Response("no", { status: 404 });
      },
    });
    return { server, host: `127.0.0.1:${server.port}`, url: (path: string) => `http://127.0.0.1:${server.port}${path}` };
  }

  /** A repository whose main holds src/f.txt = `mainText`, and a commit tree builder. */
  async function repoWith(name: string, mainText: string) {
    const r = ok(await createRepo(app, alice, { name, visibility: "public" }));
    askForReviews(app.db, r.id);
    const d = repoDir(app.reposRoot, r.ownerName, r.name);
    const git = async (args: string[], input?: string) =>
      ok(await runGit(args, { cwd: d, env: ident, ...(input === undefined ? {} : { stdin: input }) })).trim();
    const commit = async (text: string, parent?: string) => {
      const blob = await git(["hash-object", "-w", "--stdin"], text);
      const inner = await git(["mktree"], `100644 blob ${blob}\tf.txt\n`);
      const tree = await git(["mktree"], `040000 tree ${inner}\tsrc\n`);
      return git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", text]);
    };
    const base = await commit("base\n");
    const main = mainText === "base\n" ? base : await commit(mainText, base);
    await git(["update-ref", `refs/heads/${r.defaultBranch}`, main]);
    return { r, d, git, commit, base };
  }

  /** Follow `path` on the fake forge and stage `tip` as a fetch of it would have. */
  async function follow(t: Awaited<ReturnType<typeof repoWith>>, f: ReturnType<typeof forgejo>, path: string, tip: string) {
    const line = `${f.url(path)} main`;
    const added = ok(addFollowSources(app, alice, getRepoById(app.db, t.r.id)!, line));
    const source = ok(added[0]!.result);
    await t.git(["update-ref", sourceRef(source.id), tip]);
    return source;
  }

  test("several sources are added in one action, one line each; a bad line is named and the rest still follow", async () => {
    const t = await repoWith("many", "base\n");
    const done = ok(
      addFollowSources(
        app,
        alice,
        t.r,
        [
          "https://git.open-platform.sh/jmoran/forge-jay.git",
          "https://git.open-platform.sh/tdobbertin-espo/forge.git main",
          "git://nope.test/a/b",
          "https://git.open-platform.sh/jmoran/forge-jay.git",
          "https://forge-apps.benjivers.com/apps/foundry.git main as benjivers",
        ].join("\n"),
      ),
    );
    expect(done.map((d) => (d.result.ok ? "ok" : d.result.error))).toEqual(["ok", "ok", "invalid_url", "exists", "ok"]);
    const have = listSources(app.db, t.r.id);
    expect(have.length).toBe(3);
    expect(have[2]!.account).toBe("benjivers");
  });

  test("only a repository admin adds or removes; only a forge admin names the account", () => {
    const r = getRepoById(app.db, listSources(app.db, getRepoByName("many")).at(0)!.repoId)!;
    expect(addFollowSources(app, guest, r, "https://x.test/a/b")).toEqual({ ok: false, error: "not_found" });
    expect(addFollowSources(app, undefined, r, "https://x.test/a/b")).toEqual({ ok: false, error: "not_found" });
    const first = listSources(app.db, r.id)[0]!;
    expect(removeFollowSource(app, guest, r, first.id)).toEqual({ ok: false, error: "not_found" });
    expect(removeFollowSource(app, alice, r, first.id).ok).toBe(true);
    expect(listSources(app.db, r.id).length).toBe(2);
  });

  const pullCount = (repoId: string): number =>
    app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM issue WHERE repo_id = ?1 AND kind = 'pull'").get(repoId)!.n;

  function getRepoByName(name: string): string {
    return app.db.query<{ id: string }, [string]>("SELECT id FROM repo WHERE name = ?1").get(name)!.id;
  }

  test("a trusted account's new commit opens one stamped pull; the next moves it; a guest's pull is stamped and waits", async () => {
    const t = await repoWith("fold", "base\n");
    const up = await t.commit("new\n", t.base);
    const tips = new Map([["/jmoran/forge-jay.git", up]]);
    const f = forgejo(tips);
    try {
      ok(addTrust(app, alice, { host: f.host, account: "jmoran", until: "2099-01-01" }));
      const source = await follow(t, f, "/jmoran/forge-jay.git", up);
      const first = ok(await checkSource(app, getRepoById(app.db, t.r.id)!, source));
      expect(first.outcome).toBe("proposed");
      const pull = getPull(app.db, t.r.id, first.pull!)!;
      expect(pull.title).toContain("1 new commit");
      expect(pullSourceOf(app.db, pull.id)).toMatchObject({ host: f.host, account: "jmoran" });
      expect(foldsIn(app.db, pull.id)).toBe(true);
      expect(needsCrewReview(app.db, pull.id)).toBe(false);

      // The source moves: the same pull follows it.
      const up2 = await t.commit("newer\n", up);
      tips.set("/jmoran/forge-jay.git", up2);
      await t.git(["update-ref", sourceRef(source.id), up2]);
      const second = ok(await checkSource(app, getRepoById(app.db, t.r.id)!, listSources(app.db, t.r.id)[0]!));
      expect(second.pull).toBe(first.pull);
      expect(getPull(app.db, t.r.id, first.pull!)!.headOid).toBe(up2);
      expect(listSources(app.db, t.r.id)[0]!.opened).toBe(1);
      expect(await t.git(["rev-parse", `refs/pull/${first.pull}/head`])).toBe(up2);

      // Another account on the same forge is a guest: a pull, stamped, never folded in.
      const other = await repoWith("guestfold", "base\n");
      const gup = await other.commit("theirs\n", other.base);
      tips.set("/stranger/x.git", gup);
      const gs = await follow(other, f, "/stranger/x.git", gup);
      const g = ok(await checkSource(app, getRepoById(app.db, other.r.id)!, gs));
      const gpull = getPull(app.db, other.r.id, g.pull!)!;
      expect(pullSourceOf(app.db, gpull.id)?.account).toBe("stranger");
      expect(foldsIn(app.db, gpull.id)).toBe(false);
    } finally {
      f.server.stop(true);
    }
  });

  test("two sources of one repository open a pull each, and the clock checks both", async () => {
    const t = await repoWith("two", "base\n");
    const a = await t.commit("a\n", t.base);
    const b = await t.commit("b\n", t.base);
    const f = forgejo(new Map([["/jmoran/a.git", a], ["/benji/b.git", b]]));
    try {
      const sa = await follow(t, f, "/jmoran/a.git", a);
      const sb = await follow(t, f, "/benji/b.git", b);
      expect(sa.id).not.toBe(sb.id);
      await checkDue(app);
      const after = listSources(app.db, t.r.id);
      expect(after.map((s) => s.opened)).toEqual([1, 1]);
      expect(new Set(after.map((s) => s.pendingId)).size).toBe(2);
    } finally {
      f.server.stop(true);
    }
  });

  test("a first fold of many commits is one pull that the crew reviews, not a flood", async () => {
    const t = await repoWith("big", "base\n");
    let tip = t.base;
    for (let n = 0; n < BIG_FOLD_COMMITS; n++) tip = await t.commit(`c${n}\n`, tip);
    const f = forgejo(new Map([["/jmoran/big.git", tip]]));
    try {
      ok(addTrust(app, alice, { host: f.host, account: "jmoran", until: "2099-01-01" }));
      const s = await follow(t, f, "/jmoran/big.git", tip);
      const r = ok(await checkSource(app, getRepoById(app.db, t.r.id)!, s));
      expect(r.behind).toBe(BIG_FOLD_COMMITS);
      const pull = getPull(app.db, t.r.id, r.pull!)!;
      expect(needsCrewReview(app.db, pull.id)).toBe(true);
      // Trusted, but big: the crew's review stands before it lands; a small fold of the same source passes.
      const crewPull = { ...pull, authorIsAgent: true };
      expect(foldsIn(app.db, pull.id)).toBe(true);
      expect(await reviewed(app, getRepoById(app.db, t.r.id)!, crewPull)).toBe("hold");
      app.db.query("UPDATE pull_source SET big = 0 WHERE pull_id = ?1").run(pull.id);
      expect(await reviewed(app, getRepoById(app.db, t.r.id)!, crewPull)).toBe("pass");
      app.db.query("UPDATE pull_source SET big = 1 WHERE pull_id = ?1").run(pull.id);
      expect(pullCount(t.r.id)).toBe(1);
      ok(await checkSource(app, getRepoById(app.db, t.r.id)!, listSources(app.db, t.r.id)[0]!));
      expect(pullCount(t.r.id)).toBe(1);
    } finally {
      f.server.stop(true);
    }
  });

  /** `n` commits on `parent`, all of one tree (`text`): a long history built in `n` spawns. */
  async function chain(t: Awaited<ReturnType<typeof repoWith>>, parent: string, n: number, text: string) {
    const ref = `refs/tmp/chain-${chains++}`;
    let stream = "";
    for (let i = 0; i < n; i++)
      stream +=
        `commit ${ref}\ncommitter t <t@x> ${1_700_000_000 + i} +0000\ndata 2\nc${i % 10}\n` +
        (i === 0 ? `from ${parent}\n` : "") +
        `M 100644 inline src/f.txt\ndata ${text.length}\n${text}\n`;
    ok(await runGit(["fast-import", "--quiet"], { cwd: t.d, env: ident, stdin: stream }));
    const tip = await t.git(["rev-parse", ref]);
    await t.git(["update-ref", "-d", ref]);
    return tip;
  }
  let chains = 0;

  test("a first fold 120 commits ahead is one pull however many polls race for it, and later commits move that pull", async () => {
    const t = await repoWith("flood", "base\n");
    const tip = await chain(t, t.base, 120, "new\n");
    const served = new Map([["/jmoran/flood.git", tip]]);
    let release!: () => void;
    const f = forgejo(served, new Promise<void>((go) => (release = go)));
    try {
      ok(addTrust(app, alice, { host: f.host, account: "jmoran", until: "2099-01-01" }));
      const s = await follow(t, f, "/jmoran/flood.git", tip);
      const repo = getRepoById(app.db, t.r.id)!;
      // A person's check, the clock and a second click all arrive together.
      // The fake forge holds every answer until all three checks have started.
      const started = [checkSource(app, repo, s), checkSource(app, repo, s), checkDue(app)] as const;
      release();
      const [one, two] = await Promise.all(started);
      expect([one.ok, two.ok].sort()).toEqual([false, true]);
      expect(one.ok ? two : one).toEqual({ ok: false, error: "busy" });
      expect(pullCount(t.r.id)).toBe(1);
      const again = ok(await checkSource(app, repo, listSources(app.db, t.r.id)[0]!));
      expect(again.behind).toBe(120);
      expect(pullCount(t.r.id)).toBe(1);
      const pull = getPull(app.db, t.r.id, again.pull!)!;
      expect(pullSourceOf(app.db, pull.id)).toMatchObject({ host: f.host, account: "jmoran" });
      expect(needsCrewReview(app.db, pull.id)).toBe(true);

      // Later commits on the source update that pull while it is open.
      const more = await chain(t, tip, 3, "newer\n");
      served.set("/jmoran/flood.git", more);
      await t.git(["update-ref", sourceRef(s.id), more]);
      const moved = ok(await checkSource(app, repo, listSources(app.db, t.r.id)[0]!));
      expect(moved.pull).toBe(again.pull);
      expect(getPull(app.db, t.r.id, moved.pull!)!.headOid).toBe(more);
      expect(pullCount(t.r.id)).toBe(1);
      expect(needsCrewReview(app.db, pull.id)).toBe(true);
    } finally {
      f.server.stop(true);
    }
  });

  test("a trusted source's big first fold that conflicts opens no pull: the crew resolves it, reviews it, and it lands by true merge", async () => {
    const t = await repoWith("bigclash", "ours\n");
    const tip = await chain(t, t.base, 120, "theirs\n");
    const f = forgejo(new Map([["/jmoran/bigclash.git", tip]]));
    try {
      ok(addTrust(app, alice, { host: f.host, account: "jmoran", until: "2099-01-01" }));
      const bot = ok(await createAgent(app, alice, { username: "bot-bigclash", brief: "Be brief." }));
      expect(addToCrew(app, alice, getRepoById(app.db, t.r.id)!, "bot-bigclash").ok).toBe(true);
      updateRepoSettings(app.db, t.r, { autonomy: "assisted", autonomyBy: alice.id });
      askForReviews(app.db, t.r.id);
      const s = await follow(t, f, "/jmoran/bigclash.git", tip);
      const r = getRepoById(app.db, t.r.id)!;
      const found = ok(await checkSource(app, r, s));
      expect(found.outcome).toBe("conflict");
      expect(found.behind).toBe(120);
      // No pull, so no no-review path; one issue for the crew.
      expect(pullCount(t.r.id)).toBe(0);
      const issues = listIssues(app.db, t.r.id, { state: "all" }).filter((i) => i.title.startsWith("Upstream: conflict at "));
      expect(issues.length).toBe(1);
      // A second poll of the same head asks nobody again.
      ok(await checkSource(app, r, listSources(app.db, t.r.id)[0]!));
      expect(pullCount(t.r.id)).toBe(0);
      expect(listIssues(app.db, t.r.id, { state: "all" }).filter((i) => i.title.startsWith("Upstream: conflict at ")).length).toBe(1);

      // The crew's resolution merges the source's head, so its commits are ancestors of the pull.
      const mainOid = await t.git(["rev-parse", `refs/heads/${r.defaultBranch}`]);
      const resolved = await t.git(["commit-tree", `${tip}^{tree}`, "-p", mainOid, "-p", tip, "-m", "resolve"]);
      await t.git(["update-ref", "refs/heads/bot/resolve", resolved]);
      const mine = ok(await openPull(app, bot.user, r, { title: "Resolve", body: `Closes #${issues[0]!.number}`, baseBranch: r.defaultBranch, headBranch: "bot/resolve" }));
      expect(needsCrewReview(app.db, mine.id)).toBe(true);
      // Trusted, yet held for the crew's review rather than passed on its check.
      expect(foldsIn(app.db, mine.id)).toBe(true);
      expect(await reviewed(app, getRepoById(app.db, t.r.id)!, mine)).toBe("hold");
      expect(await landingStrategy(app, getRepoById(app.db, t.r.id)!, mine, mainOid)).toBe("merge");

      // The crew's reviewer approves and its check is green: it lands.
      provideChecksForTest(app, {
        gate: async () => ({ ok: true, error: "", lines: [] }),
        spareSlots: () => 0,
      } as unknown as ChecksHandle);
      const run = createRun(app.db, { repoId: t.r.id, kind: "check", issueId: mine.id, env: `pull-${mine.number}`, commitOid: mine.headOid, reason: "pull" });
      claimRun(app.db, run.id);
      finishRun(app.db, run.id, { state: "ok", summary: "ok" });
      app.db
        .query("INSERT INTO review (id, issue_id, author_id, state, commit_oid, created_at) VALUES (?1, ?2, ?3, 'approved', ?4, ?5)")
        .run(newId(), mine.id, alice.id, mine.headOid, new Date().toISOString());
      app.db.query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1").run(t.r.id, alice.id);
      const landed = await sweepGreen(app, getRepoById(app.db, t.r.id)!);
      expect([landed, lastWaits(t.r.id)]).toEqual([1, { queued: 1 }]);
      expect(getPull(app.db, t.r.id, mine.number)!.mergedAt).not.toBeNull();

      // A true merge: the source's commits are ancestors of main, so merging main into
      // the source's tip is a fast-forward (the tip is the merge base), never a conflict.
      const after = await t.git(["rev-parse", `refs/heads/${r.defaultBranch}`]);
      expect((await t.git(["rev-list", "--parents", "-n", "1", after])).split(" ").length).toBe(3);
      await t.git(["merge-base", "--is-ancestor", tip, after]);
      expect(await t.git(["merge-base", tip, after])).toBe(tip);
      expect(await t.git(["merge-base", "--is-ancestor", mainOid, after]).then(() => true)).toBe(true);
    } finally {
      f.server.stop(true);
    }
  });

  test("a conflict goes to the crew once; the crew's resolving pull carries the source, and only an agent's", async () => {
    const t = await repoWith("clash", "ours\n");
    const up = await t.commit("theirs\n", t.base);
    const f = forgejo(new Map([["/jmoran/clash.git", up]]));
    try {
      ok(addTrust(app, alice, { host: f.host, account: "jmoran", until: "2099-01-01" }));
      const bot = ok(await createAgent(app, alice, { username: "bot-clash", brief: "Be brief." }));
      expect(addToCrew(app, alice, getRepoById(app.db, t.r.id)!, "bot-clash").ok).toBe(true);
      updateRepoSettings(app.db, t.r, { autonomy: "assisted", autonomyBy: alice.id });
      const s = await follow(t, f, "/jmoran/clash.git", up);
      const r = getRepoById(app.db, t.r.id)!;
      expect(ok(await checkSource(app, r, s)).outcome).toBe("conflict");
      const issues = listIssues(app.db, t.r.id, { state: "all" }).filter((i) => i.title.startsWith("Upstream: conflict at "));
      expect(issues.length).toBe(1);
      expect(openConflictOf(app.db, s.id)).toBe(true);

      // The source moves on while the conflict is open: no second issue.
      const up2 = await t.commit("theirs again\n", up);
      await t.git(["update-ref", sourceRef(s.id), up2]);
      await checkSource(app, r, listSources(app.db, t.r.id)[0]!);
      expect(listIssues(app.db, t.r.id, { state: "all" }).filter((i) => i.title.startsWith("Upstream: conflict at ")).length).toBe(1);

      // A guest's pull that says it closes the issue gains nothing; the agent's does.
      const resolved = await t.commit("resolved\n", up);
      await t.git(["update-ref", "refs/heads/bot/resolve", resolved]);
      await t.git(["update-ref", "refs/heads/guest/resolve", resolved]);
      const mine = ok(await openPull(app, bot.user, r, { title: "Resolve", body: `Closes #${issues[0]!.number}`, baseBranch: r.defaultBranch, headBranch: "bot/resolve" }));
      expect(foldsIn(app.db, mine.id)).toBe(true);
      expect(pullSourceOf(app.db, mine.id)).toMatchObject({ host: f.host, account: "jmoran" });
      expect(needsCrewReview(app.db, mine.id)).toBe(true);
      // A reader who is a member: a guest sends only from a fork of their own.
      promote(app.db, guest);
      const theirs = await openPull(app, guest, r, { title: "Sneak", body: `Closes #${issues[0]!.number}`, baseBranch: r.defaultBranch, headBranch: "guest/resolve" });
      if (!theirs.ok) throw new Error(theirs.error);
      expect(foldsIn(app.db, theirs.value.id)).toBe(false);
      expect(pullSourceOf(app.db, theirs.value.id)).toBeUndefined();
      // A read changes nothing: an unstamped agent pull is not adopted by asking; adoption is explicit.
      app.db.query("DELETE FROM pull_source WHERE pull_id = ?1").run(mine.id);
      expect(foldsIn(app.db, mine.id)).toBe(false);
      expect(pullSourceOf(app.db, mine.id)).toBeUndefined();
      expect(adoptResolution(app.db, mine.id)).toMatchObject({ host: f.host, account: "jmoran" });
      expect(adoptResolution(app.db, theirs.value.id)).toBeUndefined();
      expect(foldsIn(app.db, mine.id)).toBe(true);
    } finally {
      f.server.stop(true);
    }
  });

  test("the settings page lists each source on one line and adds through the form", async () => {
    const t = await repoWith("pagey", "base\n");
    const servers = await serve(app);
    const cookie = `forge_session=${createSession(app.db, alice.id).token}`;
    try {
      const add = await fetch(`${servers.url}/${t.r.ownerName}/${t.r.name}/settings/sources`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie, origin: servers.url, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ sources: "https://git.open-platform.sh/jmoran/forge-jay.git main\nhttps://forge-apps.benjivers.com/apps/foundry.git main as benjivers" }),
      });
      await add.arrayBuffer();
      expect(add.status).toBe(303);
      expect(listSources(app.db, t.r.id).length).toBe(2);
      const page = await (await fetch(`${servers.url}/${t.r.ownerName}/${t.r.name}/settings`, { headers: { cookie } })).text();
      expect(page).toContain("jmoran/forge-jay");
      expect(page).toContain("benjivers@forge-apps.benjivers.com");
      expect(page).toContain("/settings/sources/");
      const stranger = await fetch(`${servers.url}/${t.r.ownerName}/${t.r.name}/settings/sources`, {
        method: "POST",
        redirect: "manual",
        headers: { cookie: `forge_session=${createSession(app.db, guest.id).token}`, origin: servers.url, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ sources: "https://x.test/a/b" }),
      });
      await stranger.arrayBuffer();
      expect(stranger.status).toBe(404);
      expect(listSources(app.db, t.r.id).length).toBe(2);
    } finally {
      servers.stop();
    }
  });

  test("a migrated repository's settings offer its origin as the first line to follow", async () => {
    const t = await repoWith("moved", "base\n");
    expect(recordProvenance(app.db, t.r.id, { url: "https://git.open-platform.sh/jmoran/forge-jay", parents: [] })).toBe(true);
    const servers = await serve(app);
    try {
      const page = await (
        await fetch(`${servers.url}/${t.r.ownerName}/${t.r.name}/settings`, { headers: { cookie: `forge_session=${createSession(app.db, alice.id).token}` } })
      ).text();
      expect(page).toContain("https://git.open-platform.sh/jmoran/forge-jay main</textarea");
    } finally {
      servers.stop();
    }
  });

  test("the terminal adds, lists and removes sources for a repository admin only, and a web viewer hears it", async () => {
    const t = await repoWith("tui", "base\n");
    const heard: string[] = [];
    const off = app.bus.subscribe((e) => {
      if (e.repoId === t.r.id) heard.push(e.kind);
    });
    const pushed: Screen[] = [];
    const ctx = { invalidate() {}, toast() {}, push: (x: Screen) => pushed.push(x), pop() {}, copy() {} } as unknown as Ctx;
    const screenFor = (user: User) => sourcesScreen({ app, db: app.db, user } as unknown as Session, ctx, getRepoById(app.db, t.r.id)!);
    try {
      const mine = screenFor(alice);
      expect(mine.key!({ key: "a" } as never)).toBe(true);
      const prompt = pushed.pop()!;
      expect(prompt.title).toBe("Follow a source");
      // Submit through the prompt as typed text.
      for (const ch of "https://git.open-platform.sh/jmoran/forge-jay.git main") prompt.key!({ key: ch } as never);
      prompt.key!({ key: "enter" } as never);
      expect(listSources(app.db, t.r.id).length).toBe(1);
      expect(heard).toContain("repo.source_added");
      expect(mine.key!({ key: "x" } as never)).toBe(true);
      const confirm = pushed.pop()!;
      expect(confirm.title).toBe("Stop following");
      confirm.key!({ key: "tab" } as never);
      confirm.key!({ key: "enter" } as never);
      expect(listSources(app.db, t.r.id).length).toBe(0);
      expect(heard).toContain("repo.source_removed");

      // Someone who is not an admin of the repository is offered nothing and changes nothing.
      const theirs = screenFor(guest);
      expect(theirs.key!({ key: "a" } as never)).toBe(false);
      expect(pushed.length).toBe(0);
    } finally {
      off();
    }
  });
});
