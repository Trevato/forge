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
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { getUserByName } from "../src/core/users.ts";
import { markVerified } from "../src/core/verify.ts";
import type { Ctx } from "../src/http/context.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setCapacity, storedCapacity, capacityChanges, capacityDefault } from "../src/core/capacity.ts";
import { listEvents } from "../src/core/events.ts";
import { hunt } from "../src/crew/sentinel.ts";
import { ASK_WORDS, decisionsFor } from "../src/web/studio/asks.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

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
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    alice = await signUp("alice"); // the first account: the site admin
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
    const page = await get(alice, "/");
    expect(sentence(page)).toBe("All fine");
    expect(headerCount(page)).toBe(0);
    expect(await get(alice, "/")).not.toContain('<section id="needs-you"');
  });

  test("/asks lands on the home's pinned needs-you, and a signed-out reader there gets the door, no asks", async () => {
    const response = await fetch(`${servers.url}/asks`, { redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/#needs-you");
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
    expect(sentence(await get(alice, "/"))).toBe("All fine");
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
    const page = await get(alice, "/");
    expect(sentence(page)).toBe("1 thing needs you");
    expect(page).toContain("Bot did a thing");
    expect(headerCount(page)).toBe(1);
    // The home counts it in the header's Asks link; the dev dashboard's
    // own "needs you" line went with the dashboard (#625).
    const home = await get(alice, "/");
    expect(headerCount(home)).toBe(1);
    // Bob can read the public repository but cannot write it: not his ask.
    expect(sentence(await get(bob, "/"))).toBe("All fine");
  });

  test("a forge health problem is a card for an admin and for no one else", async () => {
    createRun(app.db, { repoId: repo.id, kind: "check", env: "main" });
    app.db
      .query("UPDATE run SET created_at = ?1 WHERE state = 'queued'")
      .run(new Date(Date.now() - 3 * 3_600_000).toISOString());
    const admin = await get(alice, "/");
    expect(admin).toContain("behind one lane");
    expect(sentence(admin)).toBe("2 things need you");
    expect(headerCount(admin)).toBe(2);
    const other = await get(bob, "/");
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
    expect(await get(alice, "/")).toContain(card);
    // The re-run passes: the stop is answered, and the pull is green.
    check("ok");
    resolveOpen(app.db, pull.id, "retry", "green");
    const green = await get(alice, "/");
    expect(green).not.toContain(card);
    expect(green).toContain(`id="ask-look:${pull.id}"`);
    // Red again, before anything new is decided: the old stop is spent, and
    // the crew's tries are what the card is counted from.
    check("failed");
    expect(await get(alice, "/")).not.toContain(card);
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
  describe("a setting away from its default (#2029)", () => {
    const away = (key: "checks.concurrency" | "cells.egress", value: string): void => {
      setCapacity(app.db, key, value, getUserByName(app.db, "alice")!.id);
      app.db
        .query("UPDATE forge_setting SET updated_at = ?2 WHERE key = ?1")
        .run(key, new Date(Date.now() - 10 * 86_400_000).toISOString());
    };
    const post = (cookie: string, fields: Record<string, string>, origin = servers.url) =>
      fetch(`${servers.url}/asks/setting`, {
        method: "POST",
        headers: { cookie, origin },
        body: new URLSearchParams(fields),
        redirect: "manual",
      });
    const settingCards = (): string[] =>
      decisionsFor({ app, auth: { user: getUserByName(app.db, "alice")! } } as unknown as Ctx, [repo])
        .filter((d) => d.kind === "setting")
        .map((d) => d.id);
    const reset = (): void => {
      app.db.query("DELETE FROM forge_setting").run();
      app.db.query("DELETE FROM sentinel_kept").run();
      app.db.query("DELETE FROM sentinel_finding").run();
      app.db.query("DELETE FROM issue WHERE title LIKE 'Sentinel: %'").run();
    };

    test("one ask per key, with the key, value, default, who and when; the crew is not dispatched", async () => {
      reset();
      away("checks.concurrency", "4");
      away("cells.egress", "report");
      hunt(app, "alice/garden");
      hunt(app, "alice/garden", Date.now() + 3 * 3_600_000);
      expect(settingCards().sort()).toEqual(["setting:cells.egress", "setting:checks.concurrency"]);
      const card = decisionsFor({ app, auth: { user: getUserByName(app.db, "alice")! } } as unknown as Ctx, [repo]).find(
        (d) => d.id === "setting:checks.concurrency",
      )!;
      expect(card.says).toContain('"4"');
      expect(card.says).toContain("alice");
      expect(card.says).toContain("checks.concurrency");
      expect(ASK_WORDS.setting.options).toEqual(["Keep", "Put back"]);
      const page = await get(alice, "/");
      expect(page).toContain("Keep");
      expect(page).toContain("Put back");
      // not for a person who cannot put it back
      expect(await get(bob, "/")).not.toContain("Put back");
      expect(listEvents(app.db, { kind: "issue.assigned" }).length).toBe(0);
    });

    test("Keep closes the finding as kept, and it stays quiet", async () => {
      const res = await post(alice, { key: "checks.concurrency", answer: "keep" });
      expect(res.status).toBe(303);
      expect(settingCards()).toEqual(["setting:cells.egress"]);
      expect(app.db.query("SELECT value FROM sentinel_kept WHERE key = 'setting:checks.concurrency'").get()).toEqual({ value: "4" });
      expect(hunt(app, "alice/garden", Date.now() + 5 * 3_600_000).filed).toBe(0);
      expect(storedCapacity(app.db, "checks.concurrency")).toBe("4");
      const closed = app.db
        .query<{ close_reason: string }, []>("SELECT close_reason FROM issue WHERE title LIKE 'Sentinel: Setting checks.concurrency %'")
        .get();
      expect(closed?.close_reason).toBe("dropped");
    });

    test("Put back clears it on the capacity path, recorded, and closes the finding", async () => {
      const res = await post(alice, { key: "cells.egress", answer: "put" });
      expect(res.status).toBe(303);
      expect(storedCapacity(app.db, "cells.egress")).toBeUndefined();
      expect(capacityChanges(app.db).some((c) => c.key === "cells.egress" && c.to === capacityDefault("cells.egress"))).toBe(true);
      expect(listEvents(app.db, { kind: "capacity.changed" }).some((e) => e.payload["key"] === "cells.egress")).toBe(true);
      expect(settingCards()).toEqual([]);
    });

    test("a stranger, a bad answer and a foreign origin change nothing", async () => {
      reset();
      away("cells.egress", "report");
      hunt(app, "alice/garden");
      await post(bob, { key: "cells.egress", answer: "put" });
      await post(alice, { key: "cells.egress", answer: "burn" });
      await post(alice, { key: "nope", answer: "put" });
      await post(alice, { key: "cells.egress", answer: "put" }, "https://evil.example");
      expect(storedCapacity(app.db, "cells.egress")).toBe("report");
      expect(settingCards()).toEqual(["setting:cells.egress"]);
      reset();
    });

    test("a writer of the finding's repo who is not an admin cannot Keep or Put back", async () => {
      reset();
      const carol = await signUp("carol");
      const carolUser = getUserByName(app.db, "carol")!;
      markVerified(app.db, carolUser.id, new Date().toISOString());
      const plot = await createRepo(app, carolUser, { name: "plot", visibility: "public" });
      if (!plot.ok) throw new Error(String(plot.error));
      away("cells.egress", "report");
      hunt(app, "carol/plot");
      expect(app.db.query("SELECT COUNT(*) AS n FROM sentinel_finding WHERE key = 'setting:cells.egress'").get()).toEqual({ n: 1 });
      await post(carol, { key: "cells.egress", answer: "keep" });
      await post(carol, { key: "cells.egress", answer: "put" });
      expect(app.db.query("SELECT COUNT(*) AS n FROM sentinel_kept").get()).toEqual({ n: 0 });
      expect(storedCapacity(app.db, "cells.egress")).toBe("report");
      const open = app.db
        .query("SELECT COUNT(*) AS n FROM issue WHERE title LIKE 'Sentinel: Setting cells.egress %' AND state = 'open'")
        .get();
      expect(open).toEqual({ n: 1 });
      // the admin still can
      await post(alice, { key: "cells.egress", answer: "keep" });
      expect(app.db.query("SELECT COUNT(*) AS n FROM sentinel_kept").get()).toEqual({ n: 1 });
      reset();
    });
  });
});
