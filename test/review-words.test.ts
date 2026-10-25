/**
 * A review's refusals read the same from every door (#5565): the pull page,
 * the studio's review action and MCP's `review` tool each answer a reader's
 * verdict with `reviewWords.forbidden`, and no file under src/ but the module
 * types any of the sentences out.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { reviewWords } from "../src/actions/review_words.ts";
import { listReviews } from "../src/core/reviews.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("a review's refusals, from every door", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let bobCookie = "";
  let bobRw = "";
  let pullNumber = 0;
  let pullId = "";

  /** The message of the flash a refused form POST set. */
  const flashOf = (res: Response): string => {
    const raw = (res.headers.get("set-cookie") ?? "").split(";")[0]!.split("=").slice(1).join("=");
    return (JSON.parse(decodeURIComponent(raw)) as { message: string }).message;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-review-words-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    alice = await mk("alice", true);
    const bob = await mk("bob");
    promote(app.db, alice, bob);
    bobRw = createToken(app.db, bob.id, "rw", "rw").token;
    const made = await createRepo(app, alice, { name: "game", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# game\n" }],
    });
    const branch = await commitToBranch(app, alice, repo, {
      branch: "change",
      message: "change",
      files: [{ path: "change.txt", content: "change\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, { title: "change", baseBranch: "main", headBranch: "change" });
    if (!opened.ok) throw new Error(String(opened.error));
    pullNumber = opened.value.number;
    pullId = opened.value.id;
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams({ username: "bob", password: "a-good-passphrase" }),
      redirect: "manual",
    });
    bobCookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the pull page refuses a reader's verdict in the module's words", async () => {
    const res = await fetch(`${servers.url}/alice/game/pulls/${pullNumber}/review-state`, {
      method: "POST",
      headers: { cookie: bobCookie, origin: servers.url },
      body: new URLSearchParams({ state: "approved" }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(flashOf(res)).toBe(`${reviewWords.forbidden} You can still leave a comment.`);
  });

  test("the studio's review action refuses a reader's verdict in the module's words", async () => {
    const res = await fetch(`${servers.url}/review/act`, {
      method: "POST",
      headers: { cookie: bobCookie, origin: servers.url },
      body: new URLSearchParams({ repo: "alice/game", number: String(pullNumber), verb: "changes", body: "Rename it." }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(flashOf(res)).toBe(reviewWords.forbidden);
  });

  test("MCP's review tool refuses a reader's verdict in the module's words", async () => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${bobRw}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "review", arguments: { repo: "alice/game", number: pullNumber, verdict: "approve" } },
      }),
    });
    const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain(reviewWords.forbidden);
    expect(listReviews(app.db, pullId)).toEqual([]);
  });

  test("no file under src/ but the module types the sentences out", async () => {
    const root = join(import.meta.dir, "..", "src");
    const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith(".ts"));
    const typed: string[] = [];
    for (const file of files) {
      if (file === join("actions", "review_words.ts")) continue;
      const text = await readFile(join(root, file), "utf8");
      for (const sentence of Object.values(reviewWords))
        if (text.includes(sentence)) typed.push(`${file}: ${sentence}`);
    }
    expect(typed).toEqual([]);
  });
});
