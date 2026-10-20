/**
 * A child forge follows a *private* parent with the proposal token the
 * parent minted for it: the upstream check fetches with it, and once the
 * token is revoked the failure is recorded without the token in it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revokeProposal } from "../src/actions/proposal_tokens.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { mintProposalToken } from "../src/core/proposal_token.ts";
import { createUser } from "../src/core/users.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { checkUpstream } from "../src/spawn/upstream.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("following a private parent with a proposal token", () => {
  let dir = "";
  let parent: App;
  let child: App;
  let servers: Servers;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-upstream-private-"));
    parent = createApp({ dataDir: join(dir, "parent"), port: 0, host: "forge.test" });
    servers = await serve(parent);
    const made = await createUser(parent.db, {
      origin: "seed", trusted: true, username: "boss", email: "r@forge.local",
      password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    const owner = made.value;
    const repo = await createRepo(parent, owner, { name: "forge", visibility: "private" });
    if (!repo.ok) throw new Error(String(repo.error));
    await commitToBranch(parent, owner, repo.value, {
      branch: "main", message: "One", files: [{ path: "a.md", content: "a\n" }],
    });
    const minted = mintProposalToken(parent.db, owner.id, repo.value.id, {
      child: "kid", origin: "https://kid.example.com/",
    });
    if (!minted.ok) throw new Error(minted.error);
    Object.assign(globalThis, { __grant: { ...minted.value, owner, repo: repo.value } });

    child = createApp({ dataDir: join(dir, "child"), url: "https://kid.example.com", port: 0 });
    const home = repoDir(child.reposRoot, "kid", "forge");
    await mkdir(join(child.reposRoot, "kid"), { recursive: true });
    const init = await runGit(["init", "-q", "--bare", "-b", "main", home]);
    if (!init.ok) throw new Error(init.error.stderr);
    // The child has history of its own, so "behind" has something to count from.
    const c = await runGit(["-c", "user.name=t", "-c", "user.email=t@x.invalid", "commit-tree", "-m", "own", "4b825dc642cb6eb9a060e54bf8d69288fbee4904"], { cwd: home });
    if (!c.ok) throw new Error(c.error.stderr);
    await runGit(["update-ref", "refs/heads/main", c.value], { cwd: home });
    await Bun.write(
      join(child.config.dataDir, "parent.json"),
      JSON.stringify({
        upstream: servers.url,
        proposal: { child: "kid", token: minted.value.token },
        forgeCode: { repo: "kid/forge", upstream: "boss/forge", mode: "tell-me", tip: "a".repeat(40), chain: [] },
      }),
    );
  });
  afterAll(async () => {
    await servers.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("the grant lets the child fetch; a revoke is a recorded error without the token", async () => {
    const grant = (globalThis as any).__grant;
    const first = await checkUpstream(child, { now: 1000 });
    expect(first?.error).toBe("");
    expect(first?.parentTip).toMatch(/^[0-9a-f]{40}$/);

    expect(revokeProposal(parent, grant.owner, grant.repo, grant.id).ok).toBe(true);
    const next = await checkUpstream(child, { now: 2000 });
    expect(next?.error).not.toBe("");
    expect(JSON.stringify(next)).not.toContain(grant.token);
    expect(next?.parentTip).toBe(first!.parentTip);
  });

  test("without a token the private parent is not readable", async () => {
    const doc = await Bun.file(join(child.config.dataDir, "parent.json")).json();
    delete doc.proposal;
    await Bun.write(join(child.config.dataDir, "parent.json"), JSON.stringify(doc));
    expect((await checkUpstream(child, { now: 3000 }))?.error).not.toBe("");
  });
});
