/**
 * An ask lives only while its cause does (#688): a green pull that no
 * longer merges is no ask; a dismissal holds until something new happens
 * to the ask; the same kind in the same repository is one row — on
 * `/asks`, in the header, in the feed, and to the phone.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { recordInteraction } from "../src/core/interactions.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { getUserByName, type User } from "../src/core/users.ts";
import { sweepStaleAsks } from "../src/crew/stale_asks.ts";
import { readFeed } from "../src/feed/feed.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { askLinesFor } from "../src/web/studio/asks.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-expiry-passphrase";

describe("asks that expire, hold and collapse", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice = "";
  let aliceUser: User;
  let repo: Repo;

  const get = async (path: string): Promise<string> => {
    const response = await fetch(`${servers.url}${path}`, {
      headers: { cookie: alice },
      redirect: "manual",
    });
    expect(response.status).toBe(200);
    return (await response.text()).replace(/\s+/g, " ");
  };
  const sentence = (page: string): string =>
    /<h1 id="asks-sentence">([^<]*)<\/h1>/.exec(page)?.[1] ?? "";
  const headerCount = (page: string): number =>
    Number(/>Asks<span class="pill"[^>]*>(\d+)</.exec(page)?.[1] ?? 0);

  /** A run's timestamps are milliseconds: let one tick pass between acts. */
  const tick = () => Bun.sleep(5);

  const green = (pull: Pull): void => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "green" });
  };

  const botPull = async (
    slug: string,
    files: { path: string; content: string }[],
  ): Promise<Pull> => {
    const made = await commitToBranch(app, aliceUser, repo, {
      branch: `bot/${slug}`,
      base: "main",
      message: slug,
      files,
    });
    expect(made.ok).toBe(true);
    const opened = await openPull(app, getUserByName(app.db, "bot")!, repo, {
      title: `Bot: ${slug}`,
      body: "",
      baseBranch: "main",
      headBranch: `bot/${slug}`,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-asks-expiry-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const response = await fetch(`${servers.url}/signup`, {
      method: "POST",
      body: new URLSearchParams({
        username: "alice",
        email: "alice@forge.test",
        password: PASSWORD,
      }),
      redirect: "manual",
    });
    alice = `${(response.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=studio`;
    aliceUser = getUserByName(app.db, "alice")!;
    const made = await createRepo(app, aliceUser, {
      name: "orchard",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, aliceUser, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# orchard\n" }],
    });
    await createAgent(app, aliceUser, { username: "bot" });
    addToCrew(app, aliceUser, repo, "bot");
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  let apples: Pull;
  let pears: Pull;

  test("two green pulls in one repository are one row, and every surface counts it once", async () => {
    apples = await botPull("apples", [
      { path: "APPLES.md", content: "apples\n" },
    ]);
    pears = await botPull("pears", [{ path: "PEARS.md", content: "pears\n" }]);
    green(apples);
    green(pears);
    const page = await get("/asks");
    expect(sentence(page)).toBe("1 thing needs you");
    expect(headerCount(page)).toBe(1);
    expect(page).toContain("2 green changes wait for your look");
    // Each still has its own Ship, inside the one row.
    expect(page).toContain(`id="ask-look:${apples.id}"`);
    expect(page).toContain(`id="ask-look:${pears.id}"`);
    const lines = askLinesFor(app.db, aliceUser);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.id).toBe(`look:${repo.id}`);
    expect(lines[0]!.items.sort()).toEqual(
      [`look:${apples.id}`, `look:${pears.id}`].sort(),
    );
    const asks = readFeed(app.db, aliceUser).items.filter(
      (i) => i.kind === "ask",
    );
    expect(asks).toHaveLength(1);
    expect(asks[0]!.link).toBe(`/asks#look-${repo.id}`);
    expect(page).toContain(`id="look-${repo.id}"`);
  });

  test("an ask card in the feed offers no Mute: asks are never muted away", async () => {
    const fragment = await get("/live/feed");
    const card =
      /<article[^>]*data-kind="ask"[\s\S]*?<\/article>/.exec(fragment)?.[0] ??
      "";
    expect(card).toContain('data-feed="dismissed"');
    expect(card).not.toContain('data-feed="muted"');
  });

  test("dismissing the row holds until something new happens under it", async () => {
    await tick();
    recordInteraction(app.db, {
      viewerId: aliceUser.id,
      itemId: `ask:look:${repo.id}`,
      kind: "dismissed",
      repoId: repo.id,
      actorId: null,
    });
    let page = await get("/asks");
    expect(sentence(page)).toBe("All fine");
    expect(headerCount(page)).toBe(0);
    expect(askLinesFor(app.db, aliceUser)).toHaveLength(0);
    expect(
      readFeed(app.db, aliceUser).items.some((i) => i.kind === "ask"),
    ).toBe(false);
    // A new check on one of them: that one asks again, on its own.
    await tick();
    green(apples);
    page = await get("/asks");
    expect(sentence(page)).toBe("1 thing needs you");
    expect(page).toContain("Bot: apples");
    expect(page).not.toContain("Bot: pears");
    const lines = askLinesFor(app.db, aliceUser);
    expect(lines.map((l) => l.id)).toEqual([`look:${apples.id}`]);
    expect(lines[0]!.link).toBe(
      `/${repo.ownerName}/${repo.name}/changes/${apples.number}`,
    );
  });

  test("dismissing one ask holds until it has a new cause, and the pull.s own page still lands it", async () => {
    await tick();
    recordInteraction(app.db, {
      viewerId: aliceUser.id,
      itemId: `ask:look:${apples.id}`,
      kind: "dismissed",
      repoId: repo.id,
      actorId: null,
    });
    expect(sentence(await get("/asks"))).toBe("All fine");
    const change = await get(
      `/${repo.ownerName}/${repo.name}/pulls/${apples.number}`,
    );
    expect(change).toContain(`/pulls/${apples.number}/merge`);
  });

  test("a green pull that conflicts with main is no ask once the sweep has seen it", async () => {
    const plums = await botPull("plums", [
      { path: "README.md", content: "# plums\n" },
    ]);
    green(plums);
    // Not yet known: the ask stands.
    expect(askLinesFor(app.db, aliceUser).map((l) => l.id)).toEqual([
      `look:${plums.id}`,
    ]);
    await sweepStaleAsks(app);
    expect(askLinesFor(app.db, aliceUser).map((l) => l.id)).toEqual([
      `look:${plums.id}`,
    ]);
    // main moves under it, on the same line: the pull no longer merges.
    await commitToBranch(app, aliceUser, repo, {
      message: "main moves",
      files: [{ path: "README.md", content: "# orchard, renamed\n" }],
    });
    await sweepStaleAsks(app);
    expect(askLinesFor(app.db, aliceUser)).toHaveLength(0);
    expect(sentence(await get("/asks"))).toBe("All fine");
    // Its own page still says why it cannot ship.
    const change = await get(
      `/${repo.ownerName}/${repo.name}/pulls/${plums.number}`,
    );
    expect(change).toContain("README.md");
  });
});
