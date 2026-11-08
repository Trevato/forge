/**
 * `/asks`, the one screen for "is everything fine?": the sentence, the
 * decision cards, the forge's own needs for an admin — and the same number
 * in the header.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { TESTS_PASSED_TAIL } from "../src/apps/runtime.ts";
import { recordDecision, resolveOpen } from "../src/core/decisions.ts";
import { createIssue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { getUserByName } from "../src/core/users.ts";
import type { Ctx } from "../src/http/context.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setCapacity, storedCapacity } from "../src/core/capacity.ts";
import { decisionsFor } from "../src/web/studio/decisions.ts";
import { quietLogs } from "./helpers/globals.ts";
import { adminCookie } from "./helpers/admin.ts";

quietLogs();

const roomy = () => ({ freeBytes: 95, totalBytes: 100 });

const PASSWORD = "a-long-asks-passphrase";

describe("the asks page", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice = "";
  let bob = "";
  let repo: Repo;

  const get = async (cookie: string, path: string): Promise<string> => {
    const response = await fetch(`${servers.url}${path}`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(response.status).toBe(200);
    return (await response.text()).replace(/\s+/g, " ");
  };

  const signUp = async (username: string): Promise<string> => {
    const response = await fetch(`${servers.url}/signup`, {
      method: "POST",
      body: new URLSearchParams({
        username,
        email: `${username}@forge.test`,
        password: PASSWORD,
      }),
      redirect: "manual",
    });
    return `${(response.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=studio`;
  };

  /** The number the header's link carries, or 0 when it carries none. */
  const headerCount = (page: string): number =>
    Number(/<h2 id="asks-sentence"[^>]*>\s*(\d+)\b/.exec(page)?.[1] ?? 0);

  const sentence = (page: string): string =>
    /<h2 id="asks-sentence"[^>]*>([^<]*)<\/h2>/.exec(page)?.[1] ?? "";

  // Module loggers reach every forge in the process: each test starts from a quiet ledger.
  beforeEach(() => {
    app.signals.errors.clear();
    app.signals.refused.clear();
  });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-asks-"));
    // The disk is the host's, not the case's: a loaded check machine near full would ask for room.
    app = createApp({ dataDir, port: 0, disk: roomy });
    servers = await serve(app);
    alice = `${await adminCookie(app, { username: "alice", email: "alice@forge.test", password: PASSWORD })}; forge_mode=studio`;
    bob = await signUp("bob");
    const aliceUser = getUserByName(app.db, "alice")!;
    const made = await createRepo(app, aliceUser, {
      name: "garden",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, aliceUser, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    await createAgent(app, aliceUser, { username: "bot" });
    addToCrew(app, aliceUser, repo, "bot");
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("when nothing asks, it says All fine, and so does the header", async () => {
    const page = await get(alice, "/asks");
    expect(sentence(page)).toBe("All fine");
    expect(headerCount(page)).toBe(0);
    expect(await get(alice, "/asks")).not.toContain('<section id="needs-you"');
  });

  test("/asks is its own page: the needs-you section in its live region, and a signed-out reader is sent to sign in, no asks", async () => {
    const response = await fetch(`${servers.url}/asks`, { redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/signin");
    const page = await get(alice, "/asks");
    expect(page).toContain('id="live-on-you"');
    expect(page).toContain('data-live-src="/live/on-you"');
    expect(page).toContain("<title>");
    expect(page).toContain('<h1 class="sr-only">Asks</h1>');
    expect(page).toContain('id="asks-sentence"');
    const door = await (await fetch(`${servers.url}/`)).text();
    expect(door).not.toContain('id="needs-you"');
    expect(door).not.toContain('id="asks-sentence"');
  });

  test("a stopped pull is a card, and the header and the page agree", async () => {
    const bot = getUserByName(app.db, "bot")!;
    const branch = await commitToBranch(app, getUserByName(app.db, "alice")!, repo, {
      branch: "bot/1-thing",
      base: "main",
      message: "Bot work",
      files: [{ path: "BOT.md", content: "bot\n" }],
    });
    expect(branch.ok).toBe(true);
    const opened = await openPull(app, bot, repo, {
      title: "Bot did a thing",
      body: "",
      baseBranch: "main",
      headBranch: "bot/1-thing",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: opened.value.id,
      env: `pull-${opened.value.number}`,
      commitOid: opened.value.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "failed", summary: "red" });
    // Failed but the crew is still trying: that is working, not an ask.
    expect(sentence(await get(alice, "/asks"))).toBe("All fine");
    recordDecision(app.db, {
      kind: "retry",
      repoId: repo.id,
      issueId: opened.value.id,
      state: {},
      answer: "stop",
      p: 1,
      by: "rule",
      ms: 1,
    });
    const page = await get(alice, "/asks");
    expect(sentence(page)).toBe("1 thing needs you");
    expect(page).toContain("Bot did a thing");
    expect(headerCount(page)).toBe(1);
    // The section is §5's .stack: the page-local .needs-you class is gone
    // from the markup, while the words, links and forms stay (#4189).
    expect(page).toContain('<section id="needs-you" class="stack">');
    expect(page).not.toContain("needs-you ");
    expect(page).not.toMatch(/class="[^"]*\bneeds-you\b/);
    expect(page).toContain('href="/');
    expect(page).toMatch(/<form [^>]*method="post"/);
    // The home counts it in the header's Asks link; the dev dashboard's
    // own "needs you" line went with the dashboard (#625).
    const home = await get(alice, "/asks");
    expect(headerCount(home)).toBe(1);
    // Bob can read the public repository but cannot write it: not his ask.
    expect(sentence(await get(bob, "/asks"))).toBe("All fine");
  });

  test("a forge health problem is a card for an admin and for no one else", async () => {
    createRun(app.db, { repoId: repo.id, kind: "check", env: "main" });
    app.db
      .query("UPDATE run SET created_at = ?1 WHERE state = 'queued'")
      .run(new Date(Date.now() - 3 * 3_600_000).toISOString());
    const admin = await get(alice, "/asks");
    expect(admin).toContain("behind one lane");
    expect(sentence(admin)).toBe("2 things need you");
    expect(headerCount(admin)).toBe(2);
    const other = await get(bob, "/asks");
    expect(other).not.toContain("behind one lane");
    expect(sentence(other)).toBe("All fine");
  });

  test("a stop the crew took on a red check is no card once a check on that head passes", async () => {
    const aliceUser = getUserByName(app.db, "alice")!;
    const bot = getUserByName(app.db, "bot")!;
    await commitToBranch(app, aliceUser, repo, {
      branch: "bot/2-flaky",
      base: "main",
      message: "Bot work, unlucky",
      files: [{ path: "FLAKY.md", content: "flaky\n" }],
    });
    const opened = await openPull(app, bot, repo, {
      title: "Bot met a flaky runner",
      body: "",
      baseBranch: "main",
      headBranch: "bot/2-flaky",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const check = (state: "ok" | "failed") => {
      const run = createRun(app.db, {
        repoId: repo.id,
        kind: "check",
        issueId: pull.id,
        env: `pull-${pull.number}`,
        commitOid: pull.headOid,
        reason: "retry",
      });
      claimRun(app.db, run.id);
      finishRun(app.db, run.id, { state, summary: state });
    };
    check("failed");
    recordDecision(app.db, {
      kind: "retry",
      repoId: repo.id,
      issueId: pull.id,
      state: { check: { kind: "check", summary: "red" } },
      answer: "stop",
      p: 0.8,
      by: "decider",
      ms: 1,
    });
    const card = `id="ask-stopped:${pull.id}"`;
    expect(await get(alice, "/asks")).toContain(card);
    // The re-run passes: the stop is answered, and the pull is green.
    check("ok");
    resolveOpen(app.db, pull.id, "retry", "green");
    const green = await get(alice, "/asks");
    expect(green).not.toContain(card);
    expect(green).toContain(`id="ask-look:${pull.id}"`);
    // Red again, before anything new is decided: the old stop is spent, and
    // the crew's tries are what the card is counted from.
    check("failed");
    expect(await get(alice, "/asks")).not.toContain(card);
  });

  test("a green change's card says what its tests did", async () => {
    const bot = getUserByName(app.db, "bot")!;
    const branch = await commitToBranch(app, getUserByName(app.db, "alice")!, repo, {
      branch: "bot/3-clause",
      base: "main",
      message: "Bot work",
      files: [{ path: "CLAUSE.md", content: "x\n" }],
    });
    expect(branch.ok).toBe(true);
    const opened = await openPull(app, bot, repo, {
      title: "Bot clause",
      body: "",
      baseBranch: "main",
      headBranch: "bot/3-clause",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: `running at x${TESTS_PASSED_TAIL}` });
    const card = decisionsFor(
      { app, auth: { user: getUserByName(app.db, "alice")! } } as unknown as Ctx,
      [repo],
    ).find((d) => d.id === `look:${pull.id}`);
    expect(card?.says).toContain("its tests passed");
    expect(card?.short).toContain("its tests passed");
  });
  describe("a legacy setting finding (#3314)", () => {
    // The sentinel files no setting now (#3269); one filed before asks
    // nobody and is answered nowhere.
    test("raises no ask, and /asks/setting is gone", async () => {
      const alice0 = getUserByName(app.db, "alice")!;
      setCapacity(app.db, "checks.concurrency", "4", alice0.id);
      const made = createIssue(app.db, {
        repoId: repo.id,
        authorId: alice0.id,
        title: "Sentinel: Setting checks.concurrency has been away from its default for 10 days",
        body: "checks.concurrency is away",
      });
      if (!made.ok) throw new Error(made.error);
      app.db
        .query("INSERT INTO sentinel_finding (key, issue_id, evidence, first_seen, last_seen) VALUES ('setting:checks.concurrency', ?1, '', 'a', 'a')")
        .run(made.value.id);
      const ids = decisionsFor({ app, auth: { user: alice0 } } as unknown as Ctx, [repo]).map((d) => d.id);
      expect(ids.some((id) => id.startsWith("setting:"))).toBe(false);
      expect(await get(alice, "/asks")).not.toContain("Put back");
      const res = await fetch(`${servers.url}/asks/setting`, {
        method: "POST",
        headers: { cookie: alice, origin: servers.url },
        body: new URLSearchParams({ key: "checks.concurrency", answer: "put" }),
        redirect: "manual",
      });
      expect(res.status).toBe(404);
      expect(storedCapacity(app.db, "checks.concurrency")).toBe("4");
      app.db.query("DELETE FROM forge_setting").run();
      app.db.query("DELETE FROM sentinel_finding").run();
      app.db.query("DELETE FROM issue WHERE id = ?1").run(made.value.id);
    });
  });
});
