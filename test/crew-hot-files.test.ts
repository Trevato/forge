/**
 * The hot-file WIP limit (#5934): with five open pulls on one file, a sixth
 * build naming that file waits while a build on a cold file starts, and
 * the hold is said where the picker says why it skipped — the held counts,
 * the feed, and the feed through the MCP. The hold lifts when the pile
 * drains under five.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import {} from "../src/core/agents.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import type { Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { forgetHeat, warmingLine } from "../src/crew/hot_history.ts";
import { driveRepo } from "../src/crew/autonomy.ts";
import { heldNow, heldWords } from "../src/crew/held.ts";
import {
  expectedFiles,
  HOT_PULLS,
  hotFiles,
  holdHot,
  hotOverlap,
  learnPullFiles,
  pullCounts,
  standingHot,
  WIDE_PULL,
  widePulls,
  wideSays,
} from "../src/crew/hot_files.ts";
import { readFeed } from "../src/feed/feed.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("expected files", () => {
  test("are the repository paths an issue names, each once", () => {
    expect(
      expectedFiles({
        title: "Split src/http/mcp.ts into one file per tool",
        body: "Touches `docs/MCP.md`, `README.md` and src/http/mcp.ts again; see https://example.com/a/b.html and ../up/x.ts.",
      }),
    ).toEqual(["src/http/mcp.ts", "docs/MCP.md", "README.md"]);
    expect(expectedFiles({ title: "Make the home page faster", body: "" })).toEqual([]);
  });

  test("overlap a hot file only when it is named", () => {
    const hot = new Map([["src/a.ts", 7], ["src/b.ts", 5]]);
    expect(hotOverlap({ title: "src/b.ts and src/a.ts", body: "" }, hot)).toEqual([
      { path: "src/a.ts", pulls: 7 },
      { path: "src/b.ts", pulls: 5 },
    ]);
    expect(hotOverlap({ title: "src/c.ts", body: "" }, hot)).toEqual([]);
  });
});

describe("the picker holds a build on a hot file", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let servers: Servers;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-hot-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    servers = await serve(app);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const fresh = (repo: Repo) => getRepoById(app.db, repo.id)!;

  function issue(repo: Repo, title: string): Issue {
    const opened = openIssue(app, alice, fresh(repo), { title, body: "" });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value;
  }

  async function pullOn(repo: Repo, n: number, path: string): Promise<Pull> {
    const branch = await commitToBranch(app, alice, fresh(repo), {
      branch: `feature/${n}`,
      base: "main",
      message: `Change ${n}`,
      files: [{ path, content: `export const n = ${n};\n` }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const pull = await openPull(app, alice, fresh(repo), {
      title: `Change ${n}`,
      body: "",
      baseBranch: "main",
      headBranch: `feature/${n}`,
    });
    if (!pull.ok) throw new Error(String(pull.error));
    return pull.value;
  }

  test("a sixth build on a hot file waits while a build on a cold file starts", async () => {
    const made = await createRepo(app, alice, { name: "engine", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    for (const agent of ["atlas", "mason"]) {
      const created = await createAgent(app, alice, { username: agent });
      if (!created.ok) throw new Error(String(created.error));
      expect(addToCrew(app, alice, made.value, agent).ok).toBe(true);
    }
    seatAs(app.db, made.value.id, getUserByName(app.db, "atlas")!.id, "planner");
    const set = await updateRepoSettings(app, alice, made.value, {
      autonomy: "autonomous",
      autonomyDirection: "Keep the engine small.",
      autonomyCeilingUsd: 100,
      autonomySlots: 1,
      autonomyBy: alice.id,
    });
    if (!set.ok) throw new Error(JSON.stringify(set.error));
    const repo = fresh(made.value);
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [
        { path: "src/hot.ts", content: "export const n = 0;\n" },
        { path: "src/cold.ts", content: "export const n = 0;\n" },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const pulls: Pull[] = [];
    for (let n = 1; n <= HOT_PULLS; n++) pulls.push(await pullOn(repo, n, "src/hot.ts"));

    // First on the map, so only the hold keeps it from being picked.
    const hotWork = issue(repo, "Add a flag to src/hot.ts");
    const coldWork = issue(repo, "Tidy src/cold.ts");

    expect(await driveRepo(app, fresh(repo))).toBe("picked");
    const mason = getUserByName(app.db, "mason")!;
    expect(getIssueById(app.db, coldWork.id)!.assigneeId).toBe(mason.id);
    expect(getIssueById(app.db, hotWork.id)!.assigneeId).toBeNull();
    expect(hotFiles(repo.id)).toEqual(new Map([["src/hot.ts", HOT_PULLS]]));

    // Said where the picker says why it skipped: the held counts the tick
    // line and /flow read…
    const held = heldNow(app, fresh(repo));
    expect(held.by.hot_file.map((i) => i.number)).toEqual([hotWork.number]);
    expect(heldWords(held)).toContain("hot_file=1");
    expect(standingHot(repo.id)?.holds).toEqual([
      { number: hotWork.number, title: hotWork.title, files: [{ path: "src/hot.ts", pulls: HOT_PULLS }] },
    ]);

    // …the feed…
    const said = `#${hotWork.number} waits: src/hot.ts is in ${HOT_PULLS} open pulls (hot at ${HOT_PULLS}).`;
    const feed = readFeed(app.db, alice, { limit: 50 });
    const post = feed.items.find((i) => i.id === `hot:${repo.id}`);
    expect(post?.what).toBe(`1 build waits on hot files: ${said}`);
    expect(post?.link).toBe(`/alice/engine/map`);

    // …and the feed through the MCP.
    const token = createToken(app.db, alice.id, "t", "ro").token;
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "feed", arguments: { limit: 50 } },
      }),
    });
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    expect(body.result.content[0]!.text).toContain(said);

    // The pile drains under the limit: the hold lifts, and the post goes.
    const closed = setIssueState(app, alice, fresh(repo), getIssueById(app.db, pulls[0]!.id)!, "closed");
    expect(closed.ok).toBe(true);
    await learnPullFiles(app, fresh(repo));
    expect(hotFiles(repo.id).size).toBe(0);
    expect(heldNow(app, fresh(repo)).by.hot_file).toEqual([]);
    await driveRepo(app, fresh(repo));
    expect(standingHot(repo.id)).toBeUndefined();
    expect(readFeed(app.db, alice, { limit: 50 }).items.some((i) => i.id === `hot:${repo.id}`)).toBe(false);
  });

  test("two passes an hour apart name the file that gained pulls, in its repository", async () => {
    const made = await createRepo(app, alice, { name: "warm", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    const repo = fresh(made.value);
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "src/warm.ts", content: "export const n = 0;\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const t0 = Date.now();
    await pullOn(repo, 201, "src/warm.ts");
    await learnPullFiles(app, fresh(repo), t0);
    await pullOn(repo, 202, "src/warm.ts");
    await pullOn(repo, 203, "src/warm.ts");
    await learnPullFiles(app, fresh(repo), t0 + 3_600_000);
    const line = warmingLine(app.db, t0 + 3_600_000, pullCounts, false);
    forgetHeat();
    expect(line).toBe("warming: src/warm.ts 1 → 3 pulls in alice/warm");
  });

  test("a pull wider than WIDE_PULL counts toward no file's heat and is named", async () => {
    const made = await createRepo(app, alice, { name: "wide", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    const repo = fresh(made.value);
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "src/hot.ts", content: "export const n = 0;\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const wide = async (n: number): Promise<Pull> => {
      const files = Array.from({ length: WIDE_PULL + 1 }, (_, k) => ({
        path: k === 0 ? "src/hot.ts" : `gen/${n}/f${k}.ts`,
        content: `export const n = ${n};\n`,
      }));
      const branch = await commitToBranch(app, alice, fresh(repo), {
        branch: `wide/${n}`,
        base: "main",
        message: `Wide ${n}`,
        files,
      });
      if (!branch.ok) throw new Error(JSON.stringify(branch.error));
      const pull = await openPull(app, alice, fresh(repo), {
        title: `Wide ${n}`,
        body: "",
        baseBranch: "main",
        headBranch: `wide/${n}`,
      });
      if (!pull.ok) throw new Error(String(pull.error));
      return pull.value;
    };
    const wides: Pull[] = [];
    for (let n = 1; n <= HOT_PULLS; n++) wides.push(await wide(n));
    wides.push(await pullOn(repo, 90, "src/hot.ts"));
    await learnPullFiles(app, fresh(repo));
    expect(hotFiles(repo.id).size).toBe(0);
    expect(widePulls(repo.id)).toHaveLength(HOT_PULLS);
    // No build is held, yet the feed still names them.
    const work = issue(repo, "Add a flag to src/hot.ts");
    expect(heldNow(app, fresh(repo)).by.hot_file).toEqual([]);
    holdHot(repo.id, []);
    const said = widePulls(repo.id).map((w) => `#${w.number} (${w.files} files)`).join(", ");
    const post = readFeed(app.db, alice, { limit: 50 }).items.find((i) => i.id === `hot:${repo.id}`);
    expect(post?.what).toBe(`too wide to count: ${said} - close or rebase.`);
    expect(wideSays([{ number: 4840, files: 1081 }])).toBe("too wide to count: #4840 (1,081 files)");

    // Four ordinary pulls plus one more on the same file still hold it.
    for (let n = 91; n <= 94; n++) await pullOn(repo, n, "src/hot.ts");
    await learnPullFiles(app, fresh(repo));
    expect(hotFiles(repo.id)).toEqual(new Map([["src/hot.ts", 5]]));
    expect(heldNow(app, fresh(repo)).by.hot_file.map((i) => i.number)).toEqual([work.number]);
  });
});
