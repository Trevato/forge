/**
 * A proposal token lets one named child push `child/<name>/…` branches to
 * its parent and open pulls from them — and nothing else, enforced by one
 * gate before any handler runs.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { revokeProposal } from "../src/actions/proposal_tokens.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import {
  recordPullProposal,
  headInNamespace,
  inNamespace,
  isChildName,
  mintProposalToken,
  parseOrigin,
} from "../src/core/proposal_token.ts";
import type { Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/actions/pulls.ts";
import { pullMayRun } from "../src/core/pull_trust.ts";
import { getPull } from "../src/core/pulls.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { proposalLimiter } from "../src/http/proposal_gate.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

const ORIGIN = "https://kid.example.com/";

describe("the rules about names", () => {
  test("hostile branch names are outside every namespace", () => {
    const ok = "refs/heads/child/kid/feature-1";
    expect(inNamespace(ok, "kid")).toBe(true);
    expect(inNamespace("refs/heads/child/kid/a/b.c", "kid")).toBe(true);
    for (const ref of [
      "refs/heads/main",
      "refs/heads/child/other/x",
      "refs/heads/child/kid",
      "refs/heads/child/kid/",
      "refs/heads/child/kid/../../main",
      "refs/heads/child/x/../../main",
      "refs/heads/child/kid/..",
      "refs/heads/child/kid/a\nb",
      "refs/heads/child/kid/a\x00b",
      "refs/heads/child/kid/a\x7fb",
      "refs/heads/child/kid/a b",
      "refs/heads/child/kid/a:b",
      "refs/heads/child/kid/-x/.hidden",
      "refs/heads/child/kid/x.lock",
      "refs/heads/child/kid//x",
      "refs/tags/child/kid/x",
      "refs/pull/1/head",
      `refs/heads/child/kid/${"a".repeat(300)}`,
    ])
      expect(inNamespace(ref, "kid")).toBe(false);
    expect(headInNamespace("child/kid/x", "kid")).toBe(true);
    expect(headInNamespace("child/kid/x", "kid2")).toBe(false);
  });

  test("a child is words and hyphens; an origin is a bare https address", () => {
    for (const bad of ["", "Kid", "a/b", "-a", "a-", "a b", "a\nb", "x".repeat(41)])
      expect(isChildName(bad)).toBe(false);
    expect(isChildName("kid-2")).toBe(true);
    for (const bad of [
      "http://kid.example.com",
      "javascript:alert(1)",
      "https://u:p@kid.example.com",
      "https://kid.example.com/#x",
      "https://kid.example.com/?x=1",
      "https://kid.example.com/a b",
      "https://kid.example.com/\n",
      "",
    ])
      expect(parseOrigin(bad)).toBeUndefined();
    expect(parseOrigin(ORIGIN)).toBe(ORIGIN);
  });
});

describe("over HTTP", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let carol: User;
  let lib: Repo;
  let work: string;
  let secret: string;
  let tokenId: string;
  let proposedNumber = 0;
  let writerSecret: string | undefined;
  /** An ordinary rw token for alice, made once. */
  const writerToken = (): string =>
    (writerSecret ??= createToken(app.db, alice.id, "writer", "rw").token);

  const bearer = (token = secret) => ({ authorization: `Bearer ${token}` });
  const api = (path: string, init: RequestInit = {}, token = secret) =>
    fetch(`${servers.url}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...bearer(token), ...init.headers },
    });

  const git = async (args: string[], cwd = work) => {
    // No helper of the machine's may answer for the token in the URL.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_CONFIG")),
    );
    const proc = Bun.spawn(["git", "-c", "credential.helper=", ...args], {
      cwd,
      env: {
        ...env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        HOME: dataDir,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, errText] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, out, err: errText };
  };
  const push = (ref: string, token = secret) =>
    git([
      "push",
      `${servers.url.replace("://", `://child:${token}@`)}/alice/lib.git`,
      `HEAD:${ref}`,
    ]);

  const mint = (child = "kid") => {
    const minted = mintProposalToken(app.db, alice.id, lib.id, {
      child,
      origin: ORIGIN,
    });
    if (!minted.ok) throw new Error(minted.error);
    return minted.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-proposal-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    const people: User[] = [];
    for (const [username, first] of [["alice", true], ["carol", false]] as const) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!made.ok) throw new Error(made.error);
      people.push(made.value);
    }
    [alice, carol] = people as [User, User];
    promote(app.db, carol);
    const made = await createRepo(app, alice, { name: "lib", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    lib = made.value;
    const seeded = await commitToBranch(app, alice, lib, {
      branch: "main",
      message: "Start",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));

    work = join(dataDir, "work");
    const cloned = await git(["clone", `${servers.url}/alice/lib.git`, work], dataDir);
    if (cloned.code !== 0) throw new Error(cloned.err);
    await git(["config", "user.email", "kid@example.com"]);
    await git(["config", "user.name", "kid"]);
    await Bun.write(join(work, "kid.md"), "from the kid\n");
    await git(["add", "."]);
    await git(["commit", "-m", "Kid's change"]);

    ({ id: tokenId, token: secret } = mint());
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a writer mints one; a reader and a stranger cannot", async () => {
    const aliceLogin = await api("/api/v1/tokens", {
      method: "POST",
      body: JSON.stringify({ username: "alice", password: "a-good-passphrase", scope: "rw", adminConfirm: true }),
    }, "none");
    const writer = ((await aliceLogin.json()) as { token: string }).token;
    const ask = (token: string, body: object) =>
      api("/api/v1/repos/alice/lib/proposal-tokens", { method: "POST", body: JSON.stringify(body) }, token);
    const good = await ask(writer, { child: "mint-test", origin: ORIGIN });
    expect(good.status).toBe(201);
    expect(((await good.json()) as { token: string }).token).toStartWith("forge_");
    expect((await ask(writer, { child: "Bad Name", origin: ORIGIN })).status).toBe(422);
    expect((await ask(writer, { child: "ok", origin: "http://plain.example" })).status).toBe(422);
    // A proposal token cannot mint another.
    expect((await ask(secret, { child: "again", origin: ORIGIN })).status).toBe(403);
    const reader = await createUser(app.db, {
      origin: "seed",
      trusted: true, username: "dave", email: "d@forge.local", password: "a-good-passphrase",
    });
    if (!reader.ok) throw new Error(reader.error);
    const readerToken = createToken(app.db, reader.value.id, "r", "rw").token;
    expect((await ask(readerToken, { child: "x", origin: ORIGIN })).status).toBe(404);
  });

  test("a push to the default branch is refused with one line", async () => {
    const pushed = await push("main");
    expect(pushed.code).not.toBe(0);
    expect(pushed.err).toContain("a proposal token pushes only child/kid/");
  });

  test("a push outside the namespace is refused", async () => {
    for (const ref of [
      "refs/heads/other",
      "refs/heads/child/kid2/x",
      "refs/heads/child/kid/../../main",
      "refs/tags/v1",
    ]) {
      const pushed = await push(ref);
      expect(pushed.code).not.toBe(0);
    }
  });

  test("a push inside the namespace lands, and a pull opens from it", async () => {
    const pushed = await push("refs/heads/child/kid/idea");
    expect(pushed.err).not.toContain("refused");
    expect(pushed.code).toBe(0);

    const opened = await api("/api/v1/repos/alice/lib/pulls", {
      method: "POST",
      body: JSON.stringify({
        title: "A <b>proposal</b>",
        base: "main",
        head: "child/kid/idea",
      }),
    });
    expect(opened.status).toBe(201);
    const pull = (await opened.json()) as { number: number; proposal: { child: string; origin: string } };
    expect(pull.proposal).toEqual({ child: "kid", origin: ORIGIN });

    proposedNumber = pull.number;
    for (const tab of ["", "/files"]) {
      const text = await (await fetch(`${servers.url}/alice/lib/pulls/${pull.number}${tab}`)).text();
      expect(text).toContain("proposed by child");
      expect(text).toContain(ORIGIN);
    }
  });

  test("every door says who proposed it: GET, MCP and the terminal", async () => {
    const got = (await (await api(`/api/v1/repos/alice/lib/pulls/${proposedNumber}`, {}, writerToken())).json()) as {
      proposal: unknown;
    };
    expect(got.proposal).toEqual({ child: "kid", origin: ORIGIN, folds: false });

    const called = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${writerToken()}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "pull", arguments: { repo: "alice/lib", number: proposedNumber } },
      }),
    });
    const result = ((await called.json()) as any).result.content[0].text as string;
    expect(JSON.parse(result).proposal).toEqual({ child: "kid", origin: ORIGIN, folds: false });

    const terminal = headlessTerminal(160, 44);
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:a", user: alice },
      { terminal, exitHooks: false },
    );
    tui.start();
    try {
      tui.ctx.push(pullScreen(session, tui.ctx, local(session, lib), proposedNumber));
      await settleApp(tui);
      expect(tui.screen.toText()).toContain(`proposed by child kid from ${ORIGIN}`);
    } finally {
      tui.stop();
    }
  });

  test("a proposed pull runs nothing until a writer approves that exact head", async () => {
    const pull = getPull(app.db, lib.id, proposedNumber)!;
    const head = pull.headOid;
    expect(pullMayRun(app.db, lib, pull, head)).toBe(false);
    // Even before its proposal row is written, a head under child/ waits.
    app.db.query("DELETE FROM pull_proposal WHERE issue_id = ?1").run(pull.id);
    expect(pullMayRun(app.db, lib, pull, head)).toBe(false);
    recordPullProposal(app.db, pull.id, { child: "kid", origin: ORIGIN });
    // The writer who minted the token opened this pull; approving it is
    // self-review, and it neither runs the head nor satisfies a review.
    const own = await submitReview(app, alice, lib, pull, { state: "approved" });
    expect(own.ok).toBe(false);
    if (!own.ok) expect(own.error).toBe("self_review");
    expect(pullMayRun(app.db, lib, pull, head)).toBe(false);
    // Another writer's approval does.
    app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(carol.id);
    const other = { ...carol, isAdmin: true };
    const reviewed = await submitReview(app, other, lib, pull, { state: "approved" });
    if (!reviewed.ok) throw new Error(String(reviewed.error));
    expect(pullMayRun(app.db, lib, pull, head)).toBe(true);
    // A new head is a new question.
    expect(pullMayRun(app.db, lib, pull, "f".repeat(40))).toBe(false);
  });

  test("the child and origin are escaped where the pull renders", async () => {
    // A stored value from before the name rules would still render safely.
    const { listPulls } = await import("../src/core/pulls.ts");
    const [pull] = listPulls(app.db, lib.id, {});
    recordPullProposal(app.db, pull!.id, { child: "<script>x</script>", origin: '"><img src=x>' });
    const text = await (await fetch(`${servers.url}/alice/lib/pulls/${pull!.number}/files`)).text();
    expect(text).not.toContain("<script>x</script>");
    expect(text).toContain("&lt;script&gt;x&lt;/script&gt;");
    expect(text).not.toContain('"><img src=x>');
  });

  test("a pull from outside the namespace, or from a fork, is refused", async () => {
    const open = (body: object) =>
      api("/api/v1/repos/alice/lib/pulls", { method: "POST", body: JSON.stringify({ title: "t", base: "main", ...body }) });
    expect((await open({ head: "main" })).status).toBe(422);
    expect((await open({ head: "child/kid/../../main" })).status).toBe(422);
    expect((await open({ head: "child/other/x" })).status).toBe(422);
    expect((await open({ head: "child/kid/idea", headRepo: "carol/lib" })).status).toBe(422);
  });

  test("an oversize body is refused", async () => {
    const declared = await api("/api/v1/repos/alice/lib/pulls", {
      method: "POST",
      body: JSON.stringify({ title: "t", head: "child/kid/idea", body: "x".repeat(70_000) }),
    });
    expect(declared.status).toBe(413);
    const chunked = await api("/api/v1/repos/alice/lib/pulls", {
      method: "POST",
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`{"title":"t","head":"child/kid/idea","body":"${"x".repeat(70_000)}"}`));
          c.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    expect(chunked.status).toBe(413);
  });

  test("every other API is a 403, before its handler", async () => {
    const fresh = mint("sweep").token;
    proposalLimiter(app).setLimits({ perMinute: 1000, adminPerMinute: 1000, enabled: true });
    for (const [method, path] of [
      ["GET", "/api/v1/repos/alice/lib"],
      ["GET", "/api/v1/repos/alice/lib/pulls"],
      ["GET", "/api/v1/tokens"],
      ["POST", "/api/v1/tokens"],
      ["POST", "/api/v1/repos/alice/lib/issues"],
      ["POST", "/api/v1/repos/alice/lib/pulls/1/merge"],
      ["POST", "/api/v1/repos/alice/other/pulls"],
      ["POST", "/alice/other.git/git-upload-pack"],
      ["GET", "/alice/other.git/info/refs?service=git-upload-pack"],
      ["GET", "/alice/lib.git/info/refs?service=git-bogus"],
      ["GET", "/alice/lib"],
      ["GET", "/nonesuch"],
    ] as const) {
      const res = await api(path, { method, ...(method === "POST" ? { body: "{}" } : {}) }, fresh);
      expect([method, path, res.status]).toEqual([method, path, 403]);
    }
  });

  test("another repository is out of reach", async () => {
    const other = await createRepo(app, alice, { name: "other", visibility: "public" });
    if (!other.ok) throw new Error(String(other.error));
    const res = await api("/api/v1/repos/alice/other/pulls", {
      method: "POST",
      body: JSON.stringify({ title: "t", head: "child/kid/idea", base: "main" }),
    }, mint("far").token);
    expect(res.status).toBe(403);
  });

  test("the rate limit is per token", async () => {
    const fresh = mint("busy");
    const limiter = proposalLimiter(app);
    limiter.setLimits({ perMinute: 3, adminPerMinute: 3, enabled: true });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++)
        codes.push((await api("/api/v1/tokens", {}, fresh.token)).status);
      expect(codes).toEqual([403, 403, 403, 429, 429]);
      // The first token has its own budget.
      expect((await api("/api/v1/tokens", {}, mint("calm").token)).status).toBe(403);
    } finally {
      limiter.setLimits({ perMinute: 1000, adminPerMinute: 1000, enabled: true });
    }
  });

  test("deleting the child or the repository removes its tokens", async () => {
    const count = (id: string) =>
      app.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM token WHERE id = ?1").get(id)!.n;
    const forked = await forkRepo(app, carol, lib, "lib-kid");
    if (!forked.ok) throw new Error(String(forked.error));
    const minted = mintProposalToken(app.db, alice.id, lib.id, {
      child: "forked", origin: ORIGIN, childRepoId: forked.value.id,
    });
    if (!minted.ok) throw new Error(minted.error);
    expect(count(minted.value.id)).toBe(1);
    app.db.query("DELETE FROM repo WHERE id = ?1").run(forked.value.id);
    expect(count(minted.value.id)).toBe(0);
    expect(app.db.query("SELECT 1 FROM proposal_token WHERE token_id = ?1").get(minted.value.id)).toBeNull();

    const scratch = await createRepo(app, alice, { name: "scratch", visibility: "private" });
    if (!scratch.ok) throw new Error(String(scratch.error));
    const second = mintProposalToken(app.db, alice.id, scratch.value.id, { child: "kid", origin: ORIGIN });
    if (!second.ok) throw new Error(second.error);
    app.db.query("DELETE FROM repo WHERE id = ?1").run(scratch.value.id);
    expect(count(second.value.id)).toBe(0);
    // Others are untouched.
    expect(count(tokenId)).toBe(1);
  });

  test("the grant reads one private repository: fork-fetch, then propose; a revoke stops both", async () => {
    const hush = await createRepo(app, alice, { name: "hush", visibility: "private" });
    if (!hush.ok) throw new Error(String(hush.error));
    const seeded = await commitToBranch(app, alice, hush.value, {
      branch: "main", message: "Secret start", files: [{ path: "a.md", content: "private\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const vault = await createRepo(app, alice, { name: "vault", visibility: "private" });
    if (!vault.ok) throw new Error(String(vault.error));
    await commitToBranch(app, alice, vault.value, {
      branch: "main", message: "Vault", files: [{ path: "v.md", content: "v\n" }],
    });
    const grant = mintProposalToken(app.db, alice.id, hush.value.id, { child: "kid", origin: ORIGIN });
    if (!grant.ok) throw new Error(grant.error);
    const at = (name: string, token: string) =>
      servers.url.replace("://", `://child:${token}@`) + `/alice/${name}.git`;
    const dest = (n: string) => join(dataDir, n);

    // Without a grant nothing is readable; with it, that repository is.
    expect((await git(["clone", `${servers.url}/alice/hush.git`, dest("anon")], dataDir)).code).not.toBe(0);
    const cloned = await git(["clone", at("hush", grant.value.token), dest("fork")], dataDir);
    expect(cloned.code).toBe(0);

    // Not another repository of the same owner, nor the API's secrets, apps or issues.
    expect((await git(["clone", at("vault", grant.value.token), dest("vault")], dataDir)).code).not.toBe(0);
    for (const path of [
      "/api/v1/repos/alice/hush/secrets",
      "/api/v1/repos/alice/hush/issues",
      "/api/v1/repos/alice/hush/apps",
      "/api/v1/repos/alice/vault",
    ]) expect([path, [403, 404].includes((await api(path, {}, grant.value.token)).status)]).toEqual([path, true]);

    // It never pushes the default branch, nor anything outside its namespace.
    await git(["config", "user.email", "kid@example.com"], dest("fork"));
    await git(["config", "user.name", "kid"], dest("fork"));
    await Bun.write(join(dest("fork"), "kid.md"), "x\n");
    await git(["add", "."], dest("fork"));
    await git(["commit", "-m", "Kid"], dest("fork"));
    const before = await Bun.$`git -C ${join(dataDir, "repos", "alice", "hush.git")} rev-parse main`.quiet().nothrow();
    for (const ref of ["main", "refs/heads/other"])
      expect((await git(["push", at("hush", grant.value.token), `HEAD:${ref}`], dest("fork"))).code).not.toBe(0);
    expect((await git(["push", at("hush", grant.value.token), "HEAD:refs/heads/child/kid/idea"], dest("fork"))).code).toBe(0);
    if (before.exitCode === 0) {
      const after = await Bun.$`git -C ${join(dataDir, "repos", "alice", "hush.git")} rev-parse main`.quiet().nothrow();
      expect(after.stdout.toString()).toBe(before.stdout.toString());
    }
    const opened = await api("/api/v1/repos/alice/hush/pulls", {
      method: "POST",
      body: JSON.stringify({ title: "Idea", base: "main", head: "child/kid/idea" }),
    }, grant.value.token);
    expect(opened.status).toBe(201);

    // Revoke: fetch and propose both stop.
    expect(revokeProposal(app, alice, hush.value, grant.value.id).ok).toBe(true);
    expect((await git(["fetch", at("hush", grant.value.token)], dest("fork"))).code).not.toBe(0);
    expect((await git(["clone", at("hush", grant.value.token), dest("again")], dataDir)).code).not.toBe(0);
    expect((await git(["push", at("hush", grant.value.token), "HEAD:refs/heads/child/kid/more"], dest("fork"))).code).not.toBe(0);
    const late = await api("/api/v1/repos/alice/hush/pulls", {
      method: "POST",
      body: JSON.stringify({ title: "Idea", base: "main", head: "child/kid/idea" }),
    }, grant.value.token);
    expect(late.status).toBe(401);
  });
});
