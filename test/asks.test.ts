/**
 * `/asks`, the one screen for "is everything fine?": the sentence, the
 * decision cards, the forge's own needs for an admin — and the same number
 * in the header.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { recordDecision } from "../src/core/decisions.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
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
    Number(/>Asks<span class="pill"[^>]*>(\d+)</.exec(page)?.[1] ?? 0);

  const sentence = (page: string): string =>
    /<h1 id="asks-sentence">([^<]*)<\/h1>/.exec(page)?.[1] ?? "";

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
    const page = await get(alice, "/asks");
    expect(sentence(page)).toBe("All fine");
    expect(headerCount(page)).toBe(0);
    expect(await get(alice, "/")).not.toContain("<h2>Needs you</h2>");
  });

  test("a signed-out reader is sent to sign in", async () => {
    const response = await fetch(`${servers.url}/asks`, { redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("/signin");
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
    // The dashboard no longer lists it: it links here.
    const dash = await get(`${alice.split(";")[0]!}; forge_mode=dev`, "/");
    expect(dash).toContain('<a href="/asks">1 thing needs you</a>');
    // Bob can read the public repository but cannot write it: not his ask.
    expect(sentence(await get(bob, "/asks"))).toBe("All fine");
  });

  test("a forge health problem is a card for an admin and for no one else", async () => {
    createRun(app.db, { repoId: repo.id, kind: "check", env: "main" });
    app.db
      .query("UPDATE run SET created_at = ?1 WHERE state = 'queued'")
      .run(new Date(Date.now() - 3 * 3_600_000).toISOString());
    const admin = await get(alice, "/asks");
    expect(admin).toContain("queue has waited over");
    expect(sentence(admin)).toBe("2 things need you");
    expect(headerCount(admin)).toBe(2);
    const other = await get(bob, "/asks");
    expect(other).not.toContain("queue has waited");
    expect(sentence(other)).toBe("All fine");
  });
});
