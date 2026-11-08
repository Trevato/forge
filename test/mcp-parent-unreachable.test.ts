/**
 * MCP `propose_to_parent_forge` when the parent does not answer (#7176): a
 * writer is told `parent_unreachable`, nothing is recorded as proposed, and
 * once the parent answers a retry proposes exactly once. A reader is refused
 * for write access before the parent is ever asked.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { createApp, type App } from "../src/app.ts";
import { mintProposalToken } from "../src/core/proposal_token.ts";
import { listPulls } from "../src/core/pulls.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { proposalLimiter } from "../src/http/proposal_gate.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { keepParentCredential } from "../src/spawn/parent_credential.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-unreachable-passphrase";

describe("MCP proposes to a parent forge that does not answer", () => {
  let dir = "";
  let parent: App;
  let child: App;
  let parentServer: Servers | undefined;
  let childServer: Servers;
  let kid: User;
  let lib: Repo;
  let forge: Repo;
  let writer = "";

  const person = async (app: App, username: string) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: PASSWORD,
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };

  const proposals = () =>
    child.db.query<{ n: number }, []>("SELECT count(*) AS n FROM upstream_proposal").get()!.n;

  const call = async (token: string) => {
    const res = await fetch(`${childServer.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "propose_to_parent_forge", arguments: { repo: "kid/forge" } },
      }),
    });
    const body = (await res.json()) as any;
    return { error: body.result.isError === true, text: body.result.content[0].text as string };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-unreachable-"));
    // A port that was free a moment ago and refuses connections until the
    // parent is started on it.
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = probe.port as number;
    await probe.stop(true);

    parent = createApp({ dataDir: join(dir, "parent"), port, host: "127.0.0.1" });
    const alice = await person(parent, "alice");
    const made = await createRepo(parent, alice, { name: "lib", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    lib = made.value;
    const seeded = await commitToBranch(parent, alice, lib, {
      branch: "main",
      message: "Start",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const minted = mintProposalToken(parent.db, alice.id, lib.id, {
      child: "kid",
      origin: "https://kid.example.com/",
    });
    if (!minted.ok) throw new Error(minted.error);
    proposalLimiter(parent).setLimits({ perMinute: 1000, adminPerMinute: 1000, enabled: true });

    child = createApp({
      dataDir: join(dir, "child"),
      port: 0,
      host: "kid.test",
      url: "https://kid.example.com",
    });
    childServer = await serve(child);
    kid = await person(child, "kid");
    const f = await createRepo(child, kid, { name: "forge", visibility: "public" });
    if (!f.ok) throw new Error(String(f.error));
    const there = repoDir(child.reposRoot, "kid", "forge");
    await rm(there, { recursive: true, force: true });
    const cloned = await runGit(["clone", "--bare", repoDir(parent.reposRoot, "alice", "lib"), there], {});
    if (!cloned.ok) throw new Error(String(cloned.error));
    forge = getRepo(child.db, "kid", "forge")!;
    const tip = await runGit(["rev-parse", "main"], { cwd: there });
    if (!tip.ok) throw new Error(String(tip.error));
    await Bun.write(
      join(child.config.dataDir, "parent.json"),
      JSON.stringify({
        upstream: `http://127.0.0.1:${port}`,
        name: "kid",
        forgeCode: { repo: "kid/forge", upstream: "alice/lib", mode: "tell-me", tip: tip.value.trim(), chain: [] },
      }),
    );
    const kept = await keepParentCredential(child, { child: "kid", token: minted.value.token });
    if (!kept.ok) throw new Error(kept.error);

    // A change landed on the child, worth proposing.
    const c = await commitToBranch(child, kid, forge, {
      branch: "feat",
      base: "main",
      message: "Add feat",
      files: [{ path: "feat.md", content: "feat\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const opened = await openPull(child, kid, forge, { title: "Add feat", baseBranch: "main", headBranch: "feat" });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const merged = await mergePull(child, kid, forge, opened.value, "merge");
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    writer = createToken(child.db, kid.id, "rw", "rw").token;
  });

  afterAll(async () => {
    await childServer.stop();
    await parentServer?.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("a reader is refused for write access, not told the parent is unreachable", async () => {
    const made = await person(child, "reader");
    const reader = createToken(child.db, made.id, "rw", "rw").token;
    const refused = await call(reader);
    expect(refused.error).toBe(true);
    expect(refused.text).toMatch(/^forbidden: /);
    expect(refused.text).not.toContain("parent_unreachable");
    expect(proposals()).toBe(0);
  });

  test("a writer is told the parent is unreachable and nothing is recorded", async () => {
    const r = await call(writer);
    expect(r.error).toBe(true);
    expect(r.text).toBe("parent_unreachable: parent unreachable: nothing was proposed");
    expect(proposals()).toBe(0);
  });

  test("once the parent answers, a retry proposes exactly once", async () => {
    parentServer = await serve(parent);
    const first = await call(writer);
    expect(first.error).toBe(false);
    expect(JSON.parse(first.text).opened).toBe(true);
    const again = await call(writer);
    expect(JSON.parse(again.text).opened).toBe(false);
    expect(proposals()).toBe(1);
    expect(listPulls(parent.db, lib.id, { state: "open", limit: 50 })).toHaveLength(1);
  });
});
