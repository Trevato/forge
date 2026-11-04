/**
 * An agent's green pull waits for its reviewer in the crew's part (the Now
 * word), not in the owner's asks, and moves to the owner on a verdict (#1602).
 */

import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import {} from "../src/core/agents.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { pullWord, type WordCtx } from "../src/web/studio/words.ts";
import { quietLogs } from "./helpers/globals.ts";
import { adminCookie } from "./helpers/admin.ts";

quietLogs();

describe("a green agent pull and its reviewer", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let cookie = "";
  let repo: Repo;
  let pull: Pull;

  const home = async (): Promise<string> =>
    (
      await (await fetch(`${servers.url}/asks`, { headers: { cookie } })).text()
    ).replace(/\s+/g, " ");
  const wordCtx = (): WordCtx => ({ db: app.db }) as unknown as WordCtx;

  /** An agent's open pull on branch `n`, its check green. */
  const greenPull = async (n: number): Promise<Pull> => {
    await commitToBranch(app, getUserByName(app.db, "alice")!, repo, {
      branch: `bot/${n}-thing`,
      base: "main",
      message: "Bot work",
      files: [{ path: `BOT${n}.md`, content: "bot\n" }],
    });
    const opened = await openPull(app, getUserByName(app.db, "bot")!, repo, {
      title: `Bot did thing ${n}`,
      body: "",
      baseBranch: "main",
      headBranch: `bot/${n}-thing`,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const made = opened.value;
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: made.id,
      env: `pull-${made.number}`,
      commitOid: made.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "ok" });
    return made;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-review-wait-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    cookie = `${await adminCookie(app, { username: "alice", email: "alice@forge.test", password: "a-long-review-passphrase" })}; forge_mode=studio`;
    const alice = getUserByName(app.db, "alice")!;
    const made = await createRepo(app, alice, { name: "garden", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    for (const name of ["bot", "rev"]) {
      await createAgent(app, alice, { username: name });
      addToCrew(app, alice, repo, name);
    }
    seatAs(app.db, repo.id, getUserByName(app.db, "rev")!.id, "reviewer");
    pull = await greenPull(1);
    await home(); // warm the first render so no test pays for it under load
  }, 60_000);

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("before the review it is the crew's: no ask, no count, a waiting word", async () => {
    const page = await home();
    expect(page).not.toContain(`id="ask-look:${pull.id}"`);
    expect(page).not.toContain('id="needs-you"');
    expect(await pullWord(wordCtx(), pull)).toEqual({
      word: "waiting",
      note: "waiting for rev's review",
    });
  }, 30_000);

  test("an approval moves it to the owner", async () => {
    submitReview(app.db, {
      issueId: pull.id,
      authorId: getUserByName(app.db, "rev")!.id,
      state: "approved",
      commitOid: pull.headOid,
    });
    expect(await home()).toContain(`id="ask-look:${pull.id}"`);
    expect((await pullWord(wordCtx(), pull)).word).toBe("look");
  }, 30_000);

  test("a reviewer's decline moves it to the owner too", async () => {
    const other = await greenPull(2);
    expect(await home()).not.toContain(`id="ask-look:${other.id}"`);
    submitReview(app.db, {
      issueId: other.id,
      authorId: getUserByName(app.db, "rev")!.id,
      state: "changes_requested",
      commitOid: other.headOid,
    });
    expect(await home()).toContain(`id="ask-look:${other.id}"`);
  }, 30_000);
});
