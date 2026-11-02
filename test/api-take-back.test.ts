/**
 * `POST /api/v1/repos/:owner/:name/pulls/:number/take-back` over HTTP: a
 * shipped pull taken back through the API opens the pull that undoes it,
 * shaped as the pull API answers one; a second take-back is
 * `already_reverted`, an open pull is `not_shipped`, an agent's `rw` token
 * is `forbidden` (landing is a person's verb), a revert that conflicts is
 * `conflict` with the file named and no branch left, and a read-only token
 * is refused by scope. A failure of the forge's own git is 500 `git_failed`
 * with git's words logged, never sent. The rules are `revertPull`'s
 * (`test/revert.test.ts`).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { takeBackRefusal } from "../src/http/api/take_back.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("POST /api/v1/repos/:owner/:name/pulls/:number/take-back", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let rw = "";
  let ro = "";
  let agentRw = "";

  const change = async (branch: string, title: string, content: string): Promise<Pull> => {
    await commitToBranch(app, alice, repo, {
      branch,
      base: "main",
      message: title,
      files: [{ path: "code.txt", content }],
    });
    const opened = await openPull(app, alice, repo, { title, baseBranch: "main", headBranch: branch });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    return opened.value;
  };

  const ship = async (branch: string, title: string, content: string): Promise<Pull> => {
    const pull = await change(branch, title, content);
    const merged = await mergePull(app, alice, repo, pull, "squash");
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    return pull;
  };

  const branchExists = async (name: string): Promise<boolean> =>
    (await resolveOid(repoDir(app.reposRoot, repo.ownerName, repo.name), `refs/heads/${name}`)) !==
    undefined;

  const takeBack = (number: number, token: string) =>
    fetch(`${servers.url}/api/v1/repos/alice/app/pulls/${number}/take-back`, {
      method: "POST",
      headers: { origin: servers.url, authorization: `Bearer ${token}` },
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-api-take-back-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.test",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const madeRepo = await createRepo(app, alice, { name: "app", visibility: "public" });
    if (!madeRepo.ok) throw new Error(String(madeRepo.error));
    repo = madeRepo.value;
    await commitToBranch(app, alice, repo, {
      branch: "main",
      message: "base",
      files: [{ path: "code.txt", content: "alpha\n" }],
    });
    rw = createToken(app.db, alice.id, "rw", "rw").token;
    ro = createToken(app.db, alice.id, "ro", "ro").token;
    const agent = await createAgent(app, alice, { username: "bot" });
    if (!agent.ok) throw new Error(String(agent.error));
    const crewed = addToCrew(app, alice, repo, "bot");
    if (!crewed.ok) throw new Error(String(crewed.error));
    agentRw = createToken(app.db, agent.value.user.id, "rw", "rw").token;
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  test("a shipped pull taken back opens the pull that undoes it; a second take-back is already_reverted", async () => {
    const shipped = await change("loud", "Make it loud", "alpha\nBETA\n");
    const merged = await mergePull(app, alice, repo, shipped, "squash");
    expect(merged.ok).toBe(true);

    const res = await takeBack(shipped.number, rw);
    expect(res.status).toBe(201);
    const opened = (await res.json()) as Record<string, unknown>;
    expect(opened.title).toBe('Revert "Make it loud"');
    expect(opened.baseBranch).toBe("main");
    expect(opened.headBranch).toBe(`revert-${shipped.number}`);
    expect(opened.number).not.toBe(shipped.number);
    expect(opened.labels).toEqual([]);

    // The new pull is the one the pull API reads back.
    const read = await fetch(`${servers.url}/api/v1/repos/alice/app/pulls/${opened.number}?diff=0`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as Record<string, unknown>).title).toBe('Revert "Make it loud"');

    const again = await takeBack(shipped.number, rw);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe("already_reverted");
  });

  test("an open pull is not_shipped", async () => {
    const open = await change("quiet", "Make it quiet", "alpha\ngamma\n");
    const res = await takeBack(open.number, rw);
    expect(res.status).toBe(409);
    const said = (await res.json()) as { error: string; message: string };
    expect(said.error).toBe("not_shipped");
    expect(said.message).toBeTruthy();
  });

  test("a read-only token is refused by scope, and an unknown pull is not_found", async () => {
    const res = await takeBack(1, ro);
    expect(res.status).toBe(403);
    const unknown = await takeBack(999, rw);
    expect(unknown.status).toBe(404);
  });

  test("an agent's rw token is forbidden: taking a change back is a person's verb", async () => {
    const shipped = await ship("epsilon", "Add epsilon", "alpha\nEPSILON\n");
    const res = await takeBack(shipped.number, agentRw);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("forbidden");
    expect(await branchExists(`revert-${shipped.number}`)).toBe(false);
  });

  test("a revert that conflicts is conflict, names the file, and leaves no branch", async () => {
    const gamma = await ship("gamma", "Add gamma", "alpha\nGAMMA\n");
    // The same line changes again, so undoing "Add gamma" cannot apply.
    await ship("delta", "Change it again", "alpha\nDELTA\n");
    const res = await takeBack(gamma.number, rw);
    expect(res.status).toBe(409);
    const said = (await res.json()) as { error: string; message: string };
    expect(said.error).toBe("conflict");
    expect(said.message).toContain("code.txt");
    expect(await branchExists(`revert-${gamma.number}`)).toBe(false);
  });
});

describe("takeBackRefusal: a failure of the forge's own git", () => {
  const logged: string[] = [];
  const log = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message: string, fields?: Record<string, unknown>) => {
      logged.push(`${message} ${JSON.stringify(fields ?? {})}`);
    },
  };

  test("git, branch and pull failures are 500 git_failed, logged and never echoed", async () => {
    const stderr = "fatal: /data/repos/alice/app.git/objects: permission denied";
    for (const error of [
      { kind: "git" as const, message: stderr },
      { kind: "branch_failed" as const, reason: stderr },
      { kind: "pull_failed" as const, reason: stderr },
      { kind: "unsafe" as const },
    ]) {
      logged.length = 0;
      const res = takeBackRefusal(error, log);
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text).error).toBe("git_failed");
      expect(text).not.toContain("/data/repos");
      expect(logged.length).toBe(1);
    }
    expect(logged[0]).toContain("take-back");
  });
});
