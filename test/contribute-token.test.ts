/**
 * An outside agent's short-lived contribute token (#12012): mint, renew, revoke,
 * expiry, refusal for a repository that does not take outside contributions,
 * the scope check, and the doors (HTTP, git push, a pull, MCP).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintContributeToken, renewContributeToken, setOutsideContributions } from "../src/actions/contribute_token.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import {
  CONTRIBUTE_MAX_LIFE_MS,
  CONTRIBUTE_TTL_MS,
  MINTS_PER_HOUR,
  OPEN_PULLS_PER_TOKEN,
  PULLS_PER_REPO_DAY,
  contribNamespace,
  contribSegment,
  allows,
  headInContribNamespace,
  inContribNamespace,
  pullCapReached,
  isAgentName,
  listContribute,
  revokeContribute,
} from "../src/core/contribute_token.ts";
import type { Repo } from "../src/core/repos.ts";
import { verifyToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const scope = { tokenId: "t", repoId: "r", agent: "codex", namespace: "codex/abcd1234" };
const lib = { owner: "alice", name: "lib" };

describe("the scope check", () => {
  const ask = (method: string, path: string, extra: object = {}) => allows(scope, lib, { method, path, ...extra });

  test("reads public things, pushes and opens pulls on its one repository, and nothing else", () => {
    expect(ask("GET", "/api/v1/repos/bob/other")).toBe(true);
    expect(ask("GET", "/bob/other.git/info/refs", { service: "git-upload-pack" })).toBe(true);
    expect(ask("POST", "/bob/other.git/git-upload-pack")).toBe(true);
    expect(ask("GET", "/alice/lib.git/info/refs", { service: "git-receive-pack" })).toBe(true);
    expect(ask("POST", "/alice/lib.git/git-receive-pack")).toBe(true);
    expect(ask("POST", "/api/v1/repos/alice/lib/pulls")).toBe(true);
    expect(ask("PATCH", "/api/v1/repos/alice/lib/pulls/3", { ownPull: true })).toBe(true);

    expect(ask("PATCH", "/api/v1/repos/alice/lib/pulls/3")).toBe(false); // not its own
    expect(ask("POST", "/bob/other.git/git-receive-pack")).toBe(false);
    expect(ask("GET", "/bob/other.git/info/refs", { service: "git-receive-pack" })).toBe(false);
    expect(ask("POST", "/api/v1/repos/bob/other/pulls")).toBe(false);
    expect(ask("POST", "/api/v1/repos/alice/lib/proposal-tokens")).toBe(false);
    expect(ask("DELETE", "/api/v1/repos/alice/lib")).toBe(false);
    expect(ask("GET", "/api/v1/user")).toBe(false);
    expect(ask("POST", "/mcp")).toBe(false);
  });

  test("its branches are contrib/<agent>/ and hostile names are outside it", () => {
    expect(inContribNamespace("refs/heads/contrib/codex/abcd1234/fix-1", "codex/abcd1234")).toBe(true);
    expect(headInContribNamespace("contrib/codex/abcd1234/a/b", "codex/abcd1234")).toBe(true);
    for (const ref of [
      "refs/heads/main",
      "refs/heads/contrib/other/x",
      "refs/heads/contrib/codex/abcd1234",
      "refs/heads/contrib/codex/fix-1", // no segment: another token's ground
      "refs/heads/contrib/codex/ffff0000/fix-1", // another token's segment
      "refs/heads/contrib/codex/abcd1234/../../main",
      "refs/heads/contrib/codex/abcd1234/a b",
      "refs/tags/contrib/codex/abcd1234/x",
      "refs/pull/1/head",
    ])
      expect(inContribNamespace(ref, "codex/abcd1234")).toBe(false);
    for (const bad of ["", "-x", "a/b", "a b", "a..b", "x".repeat(65)]) expect(isAgentName(bad)).toBe(false);
    expect(isAgentName("Codex_cloud-2")).toBe(true);
  });
});

describe("minting, renewing, revoking", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let pub: Repo;
  let closed: Repo;
  let work: string;
  const now = new Date("2026-11-14T00:00:00Z");

  const git = async (args: string[], cwd = work) => {
    const proc = Bun.spawn(["git", "-c", "credential.helper=", ...args], {
      cwd,
      env: gitClientEnv({ GIT_TERMINAL_PROMPT: "0" }),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code: await proc.exited, out, err };
  };
  const post = (path: string, body: unknown, token?: string, headers: Record<string, string> = {}) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-contrib-token-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    for (const [name, visibility] of [["lib", "public"], ["secret", "private"]] as const) {
      const r = await createRepo(app, alice, { name, visibility });
      if (!r.ok) throw new Error(String(r.error));
      if (name === "lib") pub = r.value;
      else closed = r.value;
      const seeded = await commitToBranch(app, alice, r.value, {
        branch: "main",
        message: "Start",
        files: [{ path: "README.md", content: "hi\n" }],
      });
      if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    }
    work = join(dataDir, "work");
    expect((await git(["clone", `${servers.url}/alice/lib.git`, work], dataDir)).code).toBe(0);
    await git(["config", "user.email", "codex@example.com"]);
    await git(["config", "user.name", "codex"]);
    await Bun.write(join(work, "fix.md"), "a fix\n");
    await git(["add", "."]);
    await git(["commit", "-m", "A fix"]);
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const mint = (repo: string, agent = "codex", source = "203.0.113.1", at = now) =>
    mintContributeToken(app, { agent, origin: "codex cloud, claimed", repo }, source, "https://forge.test", at);

  test("a repository that does not allow outside contributions is refused, and so is every other that cannot", async () => {
    // Not opted in yet.
    const first = await mint("alice/lib", "codex", "198.51.100.9");
    expect(first.ok).toBe(false);
    expect(!first.ok && first.error.error).toBe("not_open");
    // A missing one answers alike.
    const none = await mint("alice/nope", "codex", "198.51.100.9");
    expect(!none.ok && none.error.error).toBe("not_open");
    // A private repository does not take them even when the owner said yes.
    setOutsideContributions(app, alice, closed, true);
    const priv = await mint("alice/secret", "codex", "198.51.100.9");
    expect(!priv.ok && priv.error.error).toBe("not_open");
    // Bad input is named.
    const bad = await mintContributeToken(app, { agent: "a b", repo: "alice/lib" }, "198.51.100.9", "https://forge.test", now);
    expect(!bad.ok && bad.error.error).toBe("invalid_agent");
    const badOrigin = await mintContributeToken(app, { agent: "x", origin: "<script>", repo: "alice/lib" }, "198.51.100.9", "https://forge.test", now);
    expect(!badOrigin.ok && badOrigin.error.error).toBe("invalid_origin");
  });

  test("an owner's yes lets it mint; the token expires, renews once, and is revoked", async () => {
    expect(setOutsideContributions(app, alice, pub, true).ok).toBe(true);
    const made = await mint("alice/lib");
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    expect(made.value.branches).toBe(`contrib/codex/${contribSegment(made.value.id)}/*`);
    expect(Date.parse(made.value.expiresAt) - now.getTime()).toBe(CONTRIBUTE_TTL_MS);

    const verified = verifyToken(app.db, made.value.token);
    expect(verified.ok && verified.value.contribute).toEqual({
      tokenId: made.value.id,
      repoId: pub.id,
      agent: "codex",
      namespace: contribNamespace("codex", made.value.id),
    });
    expect(verified.ok && verified.value.user.isAdmin).toBe(false);

    // Listed with what it claimed.
    const listed = listContribute(app.db, pub.id, now);
    expect(listed.map((t) => [t.agent, t.origin])).toEqual([["codex", "codex cloud, claimed"]]);

    // Renews once, a day on.
    const later = new Date(now.getTime() + 20 * 3600_000);
    const renewed = renewContributeToken(app, made.value.id, later);
    expect(renewed.ok && Date.parse(renewed.value.expiresAt)).toBe(later.getTime() + CONTRIBUTE_TTL_MS);
    expect(Date.parse((renewed.ok && renewed.value.expiresAt) || "")).toBeLessThanOrEqual(now.getTime() + CONTRIBUTE_MAX_LIFE_MS);
    const again = renewContributeToken(app, made.value.id, later);
    expect(!again.ok && again.error.error).toBe("already_renewed");

    // Expiry is seen: not listed after, and the token no longer verifies.
    app.db.query("UPDATE token SET expires_at = ?1 WHERE id = ?2").run(new Date(Date.now() - 1000).toISOString(), made.value.id);
    expect(verifyToken(app.db, made.value.token).ok).toBe(false);
    expect(listContribute(app.db, pub.id, new Date()).length).toBe(0);

    // Revoke: another repository's id cannot revoke it; its own can.
    const second = await mint("alice/lib", "jules", "203.0.113.2");
    if (!second.ok) throw new Error("mint");
    expect(revokeContribute(app.db, closed.id, second.value.id)).toBe(false);
    expect(verifyToken(app.db, second.value.token).ok).toBe(true);
    expect(revokeContribute(app.db, pub.id, second.value.id)).toBe(true);
    expect(verifyToken(app.db, second.value.token).ok).toBe(false);
  });

  test("minting is limited per address", async () => {
    for (let i = 0; i < MINTS_PER_HOUR; i++) expect((await mint("alice/lib", "busy", "192.0.2.7")).ok).toBe(true);
    const over = await mint("alice/lib", "busy", "192.0.2.7");
    expect(!over.ok && over.error.error).toBe("rate_limited");
    expect((await mint("alice/lib", "busy", "192.0.2.8")).ok).toBe(true);
  });

  test("over HTTP: mint with no account, push under contrib/<agent>/ only, open a pull, renew once", async () => {
    const res = await post("/api/v1/contribute", { agent: "cursor", repo: "alice/lib", origin: "cursor cloud" });
    expect(res.status).toBe(201);
    const made = (await res.json()) as { token: string; git: { url: string }; expiresAt: string };
    expect(made.token).toStartWith("forge_");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const closedRes = await post("/api/v1/contribute", { agent: "cursor", repo: "alice/secret" });
    expect(closedRes.status).toBe(404);
    expect((await post("/api/v1/contribute", { agent: "", repo: "alice/lib" })).status).toBe(422);

    const verifiedMade = verifyToken(app.db, made.token) as { ok: true; value: { user: User; contribute: { namespace: string } } };
    const user = verifiedMade.value.user.username;
    const ns = verifiedMade.value.contribute.namespace;
    const remote = (ref: string) => git(["push", `${servers.url.replace("://", `://${user}:${made.token}@`)}/alice/lib.git`, `HEAD:${ref}`]);
    const toMain = await remote("main");
    expect(toMain.code).not.toBe(0);
    expect(toMain.err).toContain(`this token pushes only contrib/${ns}/`);
    expect((await remote("refs/heads/contrib/other/x")).code).not.toBe(0);
    expect((await remote(`refs/heads/contrib/${ns}/../../main`)).code).not.toBe(0);
    // Another repository is not its own.
    const elsewhere = await git(["push", `${servers.url.replace("://", `://${user}:${made.token}@`)}/alice/secret.git`, `HEAD:refs/heads/contrib/${ns}/x`]);
    expect(elsewhere.code).not.toBe(0);
    const landed = await remote(`refs/heads/contrib/${ns}/fix`);
    expect(landed.err).not.toContain("refused");
    expect(landed.code).toBe(0);

    const auth = { authorization: `Bearer ${made.token}` };
    const opened = await post("/api/v1/repos/alice/lib/pulls", { title: "A fix", base: "main", head: `contrib/${ns}/fix` }, made.token);
    expect(opened.status).toBe(201);
    const pull = (await opened.json()) as { number: number };
    // Its head must be its own namespace.
    expect((await post("/api/v1/repos/alice/lib/pulls", { title: "x", base: "main", head: "main" }, made.token)).status).toBe(422);
    // It reads its pull back, checks included, but may not merge or reach anything else.
    const read = await fetch(`${servers.url}/api/v1/repos/alice/lib/pulls/${pull.number}`, { headers: auth });
    expect(read.status).toBe(200);
    expect((await post(`/api/v1/repos/alice/lib/pulls/${pull.number}/merge`, {}, made.token)).status).not.toBe(200);
    expect((await fetch(`${servers.url}/api/v1/tokens`, { headers: auth })).status).toBe(403);
    expect((await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, made.token)).status).toBe(403);

    // Renews once through the same call.
    const renewed = await post("/api/v1/contribute", {}, made.token);
    expect(renewed.status).toBe(200);
    expect(((await renewed.json()) as { renewed: boolean }).renewed).toBe(true);
    expect((await post("/api/v1/contribute", {}, made.token)).status).toBe(409);

    // The owner revokes it from the settings list: the token stops working.
    const listed = listContribute(app.db, pub.id, new Date()).find((t) => t.agent === "cursor")!;
    expect(revokeContribute(app.db, pub.id, listed.id)).toBe(true);
    expect((await fetch(`${servers.url}/api/v1/repos/alice/lib`, { headers: auth })).status).toBe(200); // public, as anyone
    expect((await post("/api/v1/repos/alice/lib/pulls", { title: "y", base: "main", head: `contrib/${ns}/fix` }, made.token)).status).toBe(401);
  });

  test("an owner's no ends the offer and the token's push", async () => {
    const res = await post("/api/v1/contribute", { agent: "late", repo: "alice/lib" }, undefined);
    const made = (await res.json()) as { token: string };
    setOutsideContributions(app, alice, pub, false);
    expect((await post("/api/v1/contribute", { agent: "again", repo: "alice/lib" })).status).toBe(404);
    expect((await post("/api/v1/repos/alice/lib/pulls", { title: "z", base: "main", head: "contrib/late/x" }, made.token)).status).toBe(403);
    setOutsideContributions(app, alice, pub, true);
  });

  test("the start tool's contribute action mints through MCP with no token", async () => {
    const res = await post("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "start", arguments: { action: "contribute", agent: "jules", repo: "alice/lib", origin: "jules.google" } },
    }, undefined, { accept: "application/json, text/event-stream" });
    const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBeUndefined();
    const made = JSON.parse(body.result.content[0]!.text) as { token: string; branches: string };
    expect(made.branches).toMatch(/^contrib\/jules\/[0-9a-f]{8}\/\*$/);
    expect(made.token).toStartWith("forge_");
  });

  test("two tokens that claim the same name cannot push over, or delete, each other's branches", async () => {
    setOutsideContributions(app, alice, pub, true);
    const a = await mint("alice/lib", "twin", "203.0.113.50");
    const b = await mint("alice/lib", "twin", "203.0.113.51");
    if (!a.ok || !b.ok) throw new Error("mint");
    const nsA = contribNamespace("twin", a.value.id);
    const nsB = contribNamespace("twin", b.value.id);
    expect(nsA).not.toBe(nsB);
    const as = (t: typeof a.value) => {
      const verified = verifyToken(app.db, t.token) as { ok: true; value: { user: User } };
      return `${servers.url.replace("://", `://${verified.value.user.username}:${t.token}@`)}/alice/lib.git`;
    };
    expect((await git(["push", as(a.value), `HEAD:refs/heads/contrib/${nsA}/work`])).code).toBe(0);
    await git(["commit", "--allow-empty", "-m", "Another head"]);
    // B pushes into A's namespace, force-pushes over its branch, and deletes it: all refused.
    expect((await git(["push", "--force", as(b.value), `HEAD:refs/heads/contrib/${nsA}/work`])).code).not.toBe(0);
    expect((await git(["push", as(b.value), `:refs/heads/contrib/${nsA}/work`])).code).not.toBe(0);
    // The bare claimed name, with no segment, is nobody's.
    expect((await git(["push", as(b.value), "HEAD:refs/heads/contrib/twin/work"])).code).not.toBe(0);
    expect((await git(["push", as(b.value), `HEAD:refs/heads/contrib/${nsB}/work`])).code).toBe(0);
    // A's branch is still there, and A may delete its own.
    const heads = (await git(["ls-remote", as(a.value)])).out;
    expect(heads).toContain(`refs/heads/contrib/${nsA}/work`);
    expect((await git(["push", as(a.value), `:refs/heads/contrib/${nsA}/work`])).code).toBe(0);
  });

  test("a token opens at most a few pulls, and a repository takes a day's worth from all of them", async () => {
    setOutsideContributions(app, alice, pub, true);
    const made = await mint("alice/lib", "spam", "203.0.113.60");
    if (!made.ok) throw new Error("mint");
    const ns = contribNamespace("spam", made.value.id);
    const verified = verifyToken(app.db, made.value.token) as { ok: true; value: { user: User } };
    const url = `${servers.url.replace("://", `://${verified.value.user.username}:${made.value.token}@`)}/alice/lib.git`;
    const refs = Array.from({ length: OPEN_PULLS_PER_TOKEN + 1 }, (_, i) => `HEAD:refs/heads/contrib/${ns}/p${i}`);
    expect((await git(["push", url, ...refs])).code).toBe(0);
    const open = (i: number) => post("/api/v1/repos/alice/lib/pulls", { title: `P${i}`, base: "main", head: `contrib/${ns}/p${i}` }, made.value.token);
    for (let i = 0; i < OPEN_PULLS_PER_TOKEN; i++) expect((await open(i)).status).toBe(201);
    const over = await open(OPEN_PULLS_PER_TOKEN);
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).not.toBeNull();
    // Counted from the rows: closing one frees a place.
    app.db.query("UPDATE issue SET state = 'closed' WHERE repo_id = ?1 AND author_id = ?2 AND number = (SELECT MIN(number) FROM issue WHERE repo_id = ?1 AND author_id = ?2)").run(pub.id, verified.value.user.id);
    expect((await open(OPEN_PULLS_PER_TOKEN)).status).toBe(201);

    // The repository's own day: pulls by many outside tokens together.
    const others: User[] = [];
    for (let i = 0; others.length < Math.ceil(PULLS_PER_REPO_DAY / 4); i++) {
      const m = await mint("alice/lib", `many${i}`, `198.18.0.${i}`);
      if (!m.ok) throw new Error("mint");
      others.push((verifyToken(app.db, m.value.token) as { ok: true; value: { user: User } }).value.user);
    }
    let n = 1000;
    for (const u of others)
      for (let k = 0; k < 4; k++)
        app.db
          .query("INSERT INTO issue (id, repo_id, number, kind, title, author_id, state) VALUES (?1, ?2, ?3, 'pull', 'x', ?4, 'closed')")
          .run(`seed-${n}`, pub.id, n++, u.id);
    expect(pullCapReached(app.db, pub.id, others[0]!.id, new Date())).toBe("repo_day");
    const late = await mint("alice/lib", "late2", "198.19.0.1");
    if (!late.ok) throw new Error("mint");
    const lateUser = (verifyToken(app.db, late.value.token) as { ok: true; value: { user: User } }).value.user;
    expect(pullCapReached(app.db, pub.id, lateUser.id, new Date())).toBe("repo_day");
    // A day later the count is clear.
    expect(pullCapReached(app.db, pub.id, lateUser.id, new Date(Date.now() + 2 * 86_400_000))).toBeUndefined();
  });

  test("a mint that loses the race to the cap leaves no account behind", async () => {
    const source = "203.0.113.77";
    for (let i = 0; i < MINTS_PER_HOUR - 1; i++) expect((await mint("alice/lib", "pre", source)).ok).toBe(true);
    const users = () => app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM user").get()!.n;
    const before = users();
    const both = await Promise.all([mint("alice/lib", "race", source), mint("alice/lib", "race", source)]);
    expect(both.filter((r) => r.ok).length).toBe(1);
    // One account for the one token, none for the refused mint.
    expect(users()).toBe(before + 1);
  });
});
