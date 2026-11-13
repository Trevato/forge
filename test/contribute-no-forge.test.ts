/**
 * An agent that only wants to contribute works from its own runtime and a
 * fork, and the host makes no forge for it (#11837). One test walks the way a
 * chat agent goes with no account-level powers: read `contribute`, fork, take
 * the source archive, send a patch with no git; then asserts the pull exists
 * on the guest's fork, waits for a person, and that no child forge was made.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { listChildrenNow } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { getPull } from "../src/core/pulls.ts";
import { getForkOf, getRepoById, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { markVerified } from "../src/core/verify.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { guestWaits } from "../src/origins/guest.ts";
import { setLimit } from "../src/settings/limits.ts";
import { ARCHIVES_AT_ONCE, ARCHIVES_PER_MINUTE, forgetArchives, takeArchive } from "../src/http/archive_limit.ts";
import { notePeer } from "../src/http/peer.ts";
import { sendChangeLines } from "../src/tui/screens/send_change.ts";
import { wantsToContribute } from "../src/spawn/contribute_words.ts";
import { quietLogs } from "./helpers/globals.ts";
import { mcpTool } from "./helpers/mcp.ts";

quietLogs();

const PATCH = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 hi
+there
diff --git a/NEW.md b/NEW.md
new file mode 100644
--- /dev/null
+++ b/NEW.md
@@ -0,0 +1 @@
+new
`;

describe("contributing costs the host no forge", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let owner: User;
  let admin: { token: string };
  let lib: Repo;
  let n = 0;

  async function guest(): Promise<{ user: User; token: string }> {
    const username = `chat${++n}`;
    const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@test.dev`, password: "correct-horse-battery" });
    if (!made.ok) throw new Error(made.error);
    markVerified(app.db, made.value.id, new Date().toISOString());
    app.db.query("UPDATE user SET created_at = ?1 WHERE id = ?2").run("2026-01-01T00:00:00.000Z", made.value.id);
    return { user: getUserByName(app.db, username)!, token: createToken(app.db, made.value.id, "t", "rw").token };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-contribute-no-forge-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "olive", email: "o@test.dev", password: "correct-horse-battery" });
    if (!made.ok) throw new Error(made.error);
    app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(made.value.id);
    markVerified(app.db, made.value.id, new Date().toISOString());
    owner = getUserByName(app.db, "olive")!;
    admin = { token: createToken(app.db, owner.id, "t", "admin").token };
    const repo = await createRepo(app, owner, { name: "lib", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    const seeded = await commitToBranch(app, owner, repo.value, { message: "Start", files: [{ path: "README.md", content: "hi\n" }] });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    lib = getRepoById(app.db, repo.value.id)!;
    setLimit(app.db, "signup.per_source", 1000, "setup");
    setLimit(app.db, "guest.forks_forge_per_day", 1000, "setup");
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("read contribute, fork, fetch the archive, send a patch: a pull on the fork's branch, no forge made", async () => {
    const { user, token } = await guest();
    const children = listChildrenNow(app).length;

    // 1. contribute says the fork path first.
    const welcome = await mcpTool(servers.url, token, "contribute");
    expect(welcome.value.propose[0]).toContain("costs the host no forge");
    expect(welcome.value.propose.join("\n")).toContain("/archive/");

    // 2. fork.
    const forked = await mcpTool(servers.url, token, "fork", { repo: "olive/lib" });
    expect(forked.value.repo).toBe(`${user.username}/lib`);

    // 3. the source, over HTTPS with no credential.
    const res = await fetch(`${servers.url}/olive/lib/archive/main.tar.gz`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const tar = new TextDecoder("utf-8").decode(Bun.gunzipSync(new Uint8Array(await res.arrayBuffer())));
    expect(tar).toContain("/README.md");
    expect(tar).not.toContain(".git/");

    // 4. a patch and what was run locally, in one call.
    const sent = await mcpTool(servers.url, token, "open_pull", {
      repo: "olive/lib",
      title: "Say there",
      body: "Adds a word.",
      patch: PATCH,
      checks: [{ name: "bun scripts/gate.ts", result: "pass" }, { name: "bun test test/x.test.ts", result: "pass", detail: "3 tests" }],
    });
    expect(sent.error).toBeUndefined();
    expect(sent.value.fork).toBe(`${user.username}/lib`);
    expect(sent.value.waitsForApproval).toBe(true);

    const pull = getPull(app.db, lib.id, sent.value.number)!;
    expect(pull.authorId).toBe(user.id);
    expect(pull.headRepoId).toBe(getForkOf(app.db, user.id, lib.id)!.id);
    expect(guestWaits(app.db, pull)).toBe(true);
    const body = app.db.query<{ body: string }, [string]>("SELECT body FROM issue WHERE id = ?1").get(pull.id)!.body;
    expect(body).toContain("bun scripts/gate.ts: pass");
    expect(body).toContain("its word; the forge runs its own");

    // The branch is on the guest's fork, the commit theirs, the files whole.
    const fork = getForkOf(app.db, user.id, lib.id)!;
    const dir = repoDir(app.reposRoot, fork.ownerName, fork.name);
    const log = await runGit(["log", "-1", "--format=%an", pull.headBranch], { cwd: dir });
    expect(log.ok && log.value).toBe(user.username);
    const readme = await runGit(["show", `${pull.headBranch}:README.md`], { cwd: dir });
    expect(readme.ok && readme.value).toBe("hi\nthere");
    const added = await runGit(["show", `${pull.headBranch}:NEW.md`], { cwd: dir });
    expect(added.ok && added.value).toBe("new");

    // No cell, no forge, on the host.
    expect(listChildrenNow(app).length).toBe(children);
  });

  test("files go the same way, and a patch that does not apply, or is a binary, writes nothing", async () => {
    const { token } = await guest();
    const ok = await mcpTool(servers.url, token, "open_pull", { repo: "olive/lib", title: "A file", files: [{ path: "docs/a.md", content: "a\n" }] });
    expect(ok.error).toBeUndefined();
    const bad = await mcpTool(servers.url, token, "open_pull", {
      repo: "olive/lib",
      title: "Stale",
      patch: "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-nothing like it\n+x\n",
    });
    expect(bad.error).toContain("does not apply");
    const both = await mcpTool(servers.url, token, "open_pull", { repo: "olive/lib", title: "Both", patch: PATCH, files: [{ path: "a", content: "b" }] });
    expect(both.error).toContain("invalid");
    const escape = await mcpTool(servers.url, token, "open_pull", { repo: "olive/lib", title: "Up", files: [{ path: "../x", content: "b" }] });
    expect(escape.error).toBeDefined();
    const link = await mcpTool(servers.url, token, "open_pull", {
      repo: "olive/lib",
      title: "Link",
      patch: "diff --git a/l b/l\nnew file mode 120000\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+/etc/passwd\n\\ No newline at end of file\n",
    });
    expect(link.error).toBeDefined();
    const wrongChecks = await mcpTool(servers.url, token, "open_pull", { repo: "olive/lib", title: "C", files: [{ path: "c", content: "c" }], checks: [{ name: "x", result: "great" }] });
    expect(wrongChecks.error).toContain("checks");
  });

  test("spawn asked to contribute creates nothing and returns the fork path", async () => {
    const children = listChildrenNow(app).length;
    const asked = await mcpTool(servers.url, admin.token, "spawn", { name: "mine", purpose: "contribute", dryRun: false });
    expect(asked.value.created).toBe(false);
    expect(asked.value.says).toContain("Nothing was made");
    expect(asked.value.contribute.join("\n")).toContain("open_pull");
    expect(asked.value.where.map((w: { where: string }) => w.where)).toEqual(["hosted here", "on your machine", "on a cloud account"]);
    expect(listChildrenNow(app).length).toBe(children);
    // A plan for a forge to keep says where one can live and who pays.
    const plan = await mcpTool(servers.url, admin.token, "spawn", { name: "keeper" });
    expect(plan.value.where.length).toBe(3);
    expect(wantsToContribute({ direction: "a notes app for contributors" })).toBe(false);
  });

  test("the archive answers only what a reader may read, at a stable URL", async () => {
    const priv = await createRepo(app, owner, { name: "hidden", visibility: "private" });
    if (!priv.ok) throw new Error(String(priv.error));
    await commitToBranch(app, owner, priv.value, { message: "s", files: [{ path: "a", content: "a" }] });
    expect((await fetch(`${servers.url}/olive/hidden/archive/main.tar.gz`)).status).toBe(404);
    expect((await fetch(`${servers.url}/olive/lib/archive/nope.tar.gz`)).status).toBe(404);
    expect((await fetch(`${servers.url}/olive/lib/archive/main.zip`)).status).toBe(404);
    const oid = (await runGit(["rev-parse", "main"], { cwd: repoDir(app.reposRoot, "olive", "lib") }))!;
    const pinned = await fetch(`${servers.url}/olive/lib/archive/${oid.ok ? oid.value : ""}.tar.gz?path=README.md`);
    expect(pinned.status).toBe(200);
    expect(pinned.headers.get("cache-control")).toContain("immutable");
  });

  test("the same bytes are an MCP resource for a runtime with no network; large trees are refused with advice", async () => {
    forgetArchives();
    const { token } = await guest();
    const rpc = async (method: string, params: unknown) =>
      ((await (await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })).json()) as any);
    const templates = await rpc("resources/templates/list", {});
    expect(templates.result.resourceTemplates[0].uriTemplate).toContain("forge://source/");
    const read = await rpc("resources/read", { uri: "forge://source/olive/lib@main" });
    const tar = new TextDecoder("utf-8").decode(Bun.gunzipSync(Buffer.from(read.result.contents[0].blob, "base64")));
    expect(tar).toContain("/README.md");
    expect((await rpc("resources/read", { uri: "forge://source/olive/hidden@main" })).error.code).toBe(-32002);
    expect((await rpc("resources/read", { uri: "forge://source/olive/lib@main?path=../x" })).error.code).toBe(-32002);
  });

  test("spawn acts only on an explicit purpose: an ordinary direction is still a real spawn plan", async () => {
    expect(wantsToContribute({ direction: "an app for contributions and contributors, and contribute back" })).toBe(false);
    expect(wantsToContribute({ fresh: "a tool, and contribute" })).toBe(false);
    expect(wantsToContribute({ purpose: "Contribute" })).toBe(true);
    expect(wantsToContribute({ purpose: "keep" })).toBe(false);
    const before = listChildrenNow(app).length;
    const plain = await mcpTool(servers.url, admin.token, "spawn", { name: "keeper2", direction: "track contributions and pull requests" });
    expect(plain.value.created).toBeUndefined();
    expect(plain.value.where.length).toBe(3);
    const asked = await mcpTool(servers.url, admin.token, "spawn", { name: "keeper3", purpose: "contribute" });
    expect(asked.value.created).toBe(false);
    expect(asked.value.contribute.length).toBeGreaterThan(3);
    expect(listChildrenNow(app).length).toBe(before);
  });

  test("the archive is bounded per source address and by builds at once, and a refusal frees nothing it did not take", () => {
    forgetArchives();
    const from = (address: string) => {
      const r = new Request("http://x/archive");
      notePeer(r, address);
      return r;
    };
    const taken = [];
    for (let i = 0; i < ARCHIVES_AT_ONCE; i++) {
      const t = takeArchive(from(`10.0.0.${i + 1}`));
      expect(t.ok).toBe(true);
      taken.push(t);
    }
    const busy = takeArchive(from("10.0.0.9"));
    expect(busy).toMatchObject({ ok: false, why: "busy" });
    for (const t of taken) if (t.ok) t.done();
    for (const t of taken) if (t.ok) t.done(); // twice: no double free
    expect(takeArchive(from("10.0.0.9")).ok).toBe(true);
    forgetArchives();
    for (let i = 0; i < ARCHIVES_PER_MINUTE; i++) {
      const t = takeArchive(from("10.0.0.5"));
      expect(t.ok).toBe(true);
      if (t.ok) t.done();
    }
    const limited = takeArchive(from("10.0.0.5"));
    expect(limited).toMatchObject({ ok: false, why: "rate" });
    expect(takeArchive(from("10.0.0.6")).ok).toBe(true); // another source is not held
    expect(takeArchive(from("10.0.0.5"), Date.now() + 61_000).ok).toBe(true); // the minute passed
    forgetArchives();
  });

  test("the MCP resource is admitted like the route: a seventh read in a minute is refused, and it shares the route's bucket", async () => {
    forgetArchives();
    const { token } = await guest();
    const read = async () =>
      ((await (await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "forge://source/olive/lib@main" } }),
      })).json()) as any);
    for (let i = 0; i < ARCHIVES_PER_MINUTE; i++) expect((await read()).result.contents[0].mimeType).toBe("application/gzip");
    const seventh = await read();
    expect(seventh.error.code).toBe(-32002);
    expect(seventh.error.message).toContain("too many archives");
    expect((await fetch(`${servers.url}/olive/lib/archive/main.tar.gz`)).status).toBe(429);
    forgetArchives();
  });

  test("the route answers 429 when a source asks too often", async () => {
    forgetArchives();
    let last = 0;
    for (let i = 0; i <= ARCHIVES_PER_MINUTE; i++) last = (await fetch(`${servers.url}/olive/lib/archive/main.tar.gz`)).status;
    expect(last).toBe(429);
    forgetArchives();
  });

  test("reported checks are escaped where the pull shows them, and files are validated at the boundary", async () => {
    forgetArchives();
    const { token } = await guest();
    const sent = await mcpTool(servers.url, token, "open_pull", {
      repo: "olive/lib",
      title: "Markup",
      files: [{ path: "m.md", content: "m\n" }],
      checks: [{ name: "<script>alert(1)</script>", result: "pass", detail: "<img src=x onerror=alert(2)>" }],
    });
    expect(sent.error).toBeUndefined();
    const page = await (await fetch(`${servers.url}/olive/lib/pulls/${sent.value.number}`)).text();
    expect(page).not.toContain("<script>alert(1)");
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("&lt;script&gt;alert(1)");
    for (const files of [[{ path: "../x", content: "x" }], [{ path: "a", content: 5 }], [{ path: "a" }], [], "a"]) {
      const r = await mcpTool(servers.url, token, "open_pull", { repo: "olive/lib", title: "Bad", files });
      expect(r.error).toContain("invalid");
    }
  });

  test("the terminal's card says the same steps", () => {
    const text = sendChangeLines(60).join("\n");
    expect(text).toContain("open_pull");
    expect(text).toContain("archive");
  });
});
