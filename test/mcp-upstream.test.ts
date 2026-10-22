/**
 * The MCP doors to proposing across forges (#2231): one tool proposes to the
 * parent forge, one read lists the proposals; a writer proposes and lists, a
 * reader lists and is refused the proposal, and the same tip is the same pull.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { createApp, type App } from "../src/app.ts";
import { mintProposalToken } from "../src/core/proposal_token.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { proposalLimiter } from "../src/http/proposal_gate.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { checkUpstream } from "../src/spawn/upstream.ts";
import { keepParentCredential } from "../src/spawn/parent_credential.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-upstream-passphrase";

describe("MCP proposes to the parent forge and lists proposals", () => {
  let dir = "";
  let parent: App;
  let child: App;
  let parentServer: Servers;
  let childServer: Servers;
  let alice: User;
  let kid: User;
  let lib: Repo;
  let forge: Repo;
  let secret = "";

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

  /** A change landing on the child: a branch, a pull, a merge. */
  const land = async (branch: string, title: string) => {
    const c = await commitToBranch(child, kid, forge, {
      branch,
      base: "main",
      message: title,
      files: [{ path: `${branch}.md`, content: `${title}\n` }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const opened = await openPull(child, kid, forge, {
      title,
      baseBranch: "main",
      headBranch: branch,
    });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const merged = await mergePull(child, kid, forge, opened.value, "merge");
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    return opened.value;
  };

  const parentPull = (number: number) => getPull(parent.db, lib.id, number)!;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-upstream-"));
    parent = createApp({ dataDir: join(dir, "parent"), port: 0, host: "parent.test" });
    parentServer = await serve(parent);
    alice = await person(parent, "alice");
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
    secret = minted.value.token;
    // Many presses in one minute are the test's doing, not a flood.
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
    // The child's code is a copy of the parent's: the same history.
    const there = repoDir(child.reposRoot, "kid", "forge");
    await rm(there, { recursive: true, force: true });
    const cloned = await runGit(
      ["clone", "--bare", repoDir(parent.reposRoot, "alice", "lib"), there],
      {},
    );
    if (!cloned.ok) throw new Error(String(cloned.error));
    forge = getRepo(child.db, "kid", "forge")!;
    const tip = await runGit(["rev-parse", "main"], { cwd: there });
    if (!tip.ok) throw new Error(String(tip.error));
    await Bun.write(
      join(child.config.dataDir, "parent.json"),
      JSON.stringify({
        upstream: parentServer.url,
        name: "kid",
        forgeCode: {
          repo: "kid/forge",
          upstream: "alice/lib",
          mode: "tell-me",
          tip: tip.value.trim(),
          chain: [],
        },
      }),
    );
    const kept = await keepParentCredential(child, { child: "kid", token: secret });
    if (!kept.ok) throw new Error(kept.error);
  });

  afterAll(async () => {
    await childServer.stop();
    await parentServer.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const call = async (token: string, name: string) => {
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
        params: { name, arguments: { repo: "kid/forge" } },
      }),
    });
    const body = (await res.json()) as any;
    const text = body.result.content[0].text as string;
    return { error: body.result.isError === true, text };
  };

  test("the following tool carries the upstream state, null before a check", async () => {
    const token = createToken(child.db, kid.id, "rw", "rw").token;
    expect(JSON.parse((await call(token, "following")).text).upstream).toBeNull();
    await checkUpstream(child, { remote: repoDir(parent.reposRoot, "alice", "lib") });
    const got = JSON.parse((await call(token, "following")).text).upstream;
    expect(got).toMatchObject({ error: "" });
    expect(typeof got.behind).toBe("number");
    expect(got.parentTip).toMatch(/^[0-9a-f]{40,64}$/);
  });

  test("tools/list names both", async () => {
    const token = createToken(child.db, kid.id, "rw", "rw").token;
    const res = await fetch(`${childServer.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const tools = ((await res.json()) as any).result.tools as { name: string; annotations: any }[];
    const by = (n: string) => tools.find((t) => t.name === n);
    expect(by("propose_to_parent_forge")?.annotations).toBeUndefined();
    expect(by("forge_proposals")?.annotations.readOnlyHint).toBe(true);
  });

  test("with nothing ahead, the tool says what the page says", async () => {
    const writer = createToken(child.db, kid.id, "rw", "rw").token;
    const none = await call(writer, "propose_to_parent_forge");
    expect(none.error).toBe(true);
    expect(none.text).toBe("nothing_to_propose: nothing here is ahead of the parent forge");
    expect(JSON.parse((await call(writer, "forge_proposals")).text).items).toEqual([]);
  });

  test("a writer proposes and lists; the same tip is the same pull", async () => {
    const writer = createToken(child.db, kid.id, "rw", "rw").token;
    await land("feat", "Add feat");
    const made = await call(writer, "propose_to_parent_forge");
    expect(made.error).toBe(false);
    const first = JSON.parse(made.text);
    expect(first.opened).toBe(true);
    expect(parentPull(first.proposal.number).title).toBe("Add feat");

    const again = JSON.parse((await call(writer, "propose_to_parent_forge")).text);
    expect(again.opened).toBe(false);
    expect(again.proposal.number).toBe(first.proposal.number);

    const listed = JSON.parse((await call(writer, "forge_proposals")).text).items;
    expect(listed).toHaveLength(1);
    expect(listed[0].number).toBe(first.proposal.number);
    expect(listed[0].state).toBe("open");
    expect(listed[0].url).toBe(`${parentServer.url}/alice/lib/pulls/${first.proposal.number}`);
  });

  test("a reader is refused the proposal and can still list", async () => {
    const made = await createUser(child.db, {
      origin: "seed",
      trusted: true,
      username: "reader",
      email: "r@forge.local",
      password: PASSWORD,
    });
    if (!made.ok) throw new Error(made.error);
    const reader = createToken(child.db, made.value.id, "rw", "rw").token;
    const readOnly = createToken(child.db, kid.id, "ro", "ro").token;
    for (const token of [reader, readOnly]) {
      const refused = await call(token, "propose_to_parent_forge");
      expect(refused.error).toBe(true);
      expect(refused.text).toMatch(/^forbidden: /);
      const listed = await call(token, "forge_proposals");
      expect(listed.error).toBe(false);
      expect(JSON.parse(listed.text).items).toHaveLength(1);
    }
  });

  test("a parent that does not answer reads as unreachable in the list", async () => {
    const writer = createToken(child.db, kid.id, "rw", "rw").token;
    child.db.query("UPDATE upstream_proposal SET checked_at = 0").run();
    await parentServer.stop();
    const listed = JSON.parse((await call(writer, "forge_proposals")).text).items;
    expect(listed[0].reachable).toBe(false);
    expect(listed[0].says).toContain("parent unreachable");
  });
});
