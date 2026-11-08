import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addCommentThrough, openIssueThrough } from "../src/actions/issues.ts";
import { createApp, type App } from "../src/app.ts";
import { getOriginById } from "../src/core/origins.ts";
import { getRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { hookSecret, HOOK_SIGNATURE_HEADER } from "../src/origins/hook.ts";
import { syncOrigin, syncsSettled } from "../src/origins/sync.ts";
import { mirrorAndWait } from "./fake-origin.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { proveAll } from "./helpers/verified.ts";

/**
 * Two forges: issues and comments written here land on the origin under the
 * signed-in person's connected account, the origin's own arrive by signed
 * webhook, and after the origin was down a sweep fetches what was missed
 * without a duplicate.
 */

setDefaultTimeout(60_000);

const ALICE = "alice-login-secret";
const BOB = "bob-login-secret";
const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

describe("issues on a repository brought from another forge", () => {
  const dirs: string[] = [];
  let mine: App;
  let friend: App;
  let mineServers: Servers;
  let friendServers: Servers;
  let originId = "";

  const bobApi = (path: string, init: RequestInit = {}) =>
    fetch(`${friendServers.url}${path}`, {
      ...init,
      headers: { authorization: basic("bob", BOB), "content-type": "application/json" },
    });
  const mirror = () => getRepo(mine.db, "alice", "app")!;
  const sync = () => syncOrigin(mine, getOriginById(mine.db, originId)!);
  const rows = (sql: string, ...args: string[]) => mine.db.query<Record<string, string>, string[]>(sql).all(...args);
  const bodies = () =>
    rows("SELECT c.body FROM comment c JOIN issue i ON i.id = c.issue_id WHERE i.repo_id = ?1 ORDER BY c.body", mirror().id).map((r) => r.body);
  const deliver = async (body: unknown) => {
    const raw = JSON.stringify(body);
    const mac = new Bun.CryptoHasher("sha256", hookSecret(mine, mirror())).update(raw).digest("hex");
    return fetch(`${mineServers.url}/api/v1/repos/alice/app/origin-hook`, {
      method: "POST",
      headers: { "content-type": "application/json", [HOOK_SIGNATURE_HEADER]: `sha256=${mac}` },
      body: raw,
    });
  };

  beforeAll(async () => {
    const make = async () => {
      const dir = await mkdtemp(join(tmpdir(), "forge-origin-issues-"));
      dirs.push(dir);
      return dir;
    };
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const friendPort = probe.port as number;
    await probe.stop(true);
    friend = createApp({ dataDir: await make(), port: friendPort });
    friendServers = await serve(friend);
    await seedAdmin(friend, { username: "bob", email: "bob@friend.test", password: BOB });
    proveAll(friend);
    const token = createToken(friend.db, getUserByName(friend.db, "bob")!.id, "alice", "admin").token;
    await bobApi("/api/v1/repos", { method: "POST", body: JSON.stringify({ name: "app", visibility: "public" }) });
    await bobApi("/api/v1/repos/bob/app/contents", {
      method: "POST",
      body: JSON.stringify({ branch: "main", message: "first", files: [{ path: "README.md", content: "app\n" }] }),
    });

    mine = createApp({ dataDir: await make(), port: 0, url: "https://mine.test" });
    mineServers = await serve(mine);
    await seedAdmin(mine, { username: "alice", email: "alice@forge.test", password: ALICE });
    proveAll(mine);
    const connected = await fetch(`${mineServers.url}/api/v1/user/origins`, {
      method: "POST",
      headers: { authorization: basic("alice", ALICE), "content-type": "application/json" },
      body: JSON.stringify({ host: friendServers.url, token }),
    });
    originId = ((await connected.json()) as { id: string }).id;
    const job = await mirrorAndWait(
      await fetch(`${mineServers.url}/api/v1/user/origins/${originId}/mirror`, {
        method: "POST",
        headers: { authorization: basic("alice", ALICE), "content-type": "application/json" },
        body: JSON.stringify({ fullName: "bob/app" }),
      }),
    );
    expect(job?.stage).toBe("done");
  }, 120_000);

  afterAll(async () => {
    await syncsSettled();
    mineServers.stop();
    friendServers.stop();
    mine.close();
    friend.close();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }, 120_000);

  test("an issue and a comment opened here are written to the origin as the connected account", async () => {
    const alice = getUserByName(mine.db, "alice")!;
    const opened = await openIssueThrough(mine, alice, mirror(), { title: "It breaks", body: "on start" });
    if (!opened.ok) throw new Error(opened.error);
    const there = await (await bobApi(`/api/v1/repos/bob/app/issues/${opened.value.number}`)).json();
    expect(there).toMatchObject({ title: "It breaks" });

    const posted = await addCommentThrough(mine, alice, mirror(), opened.value, "from here");
    if (!posted.ok) throw new Error(posted.error);
    const thread = JSON.stringify(await (await bobApi(`/api/v1/repos/bob/app/issues/${opened.value.number}/comments`)).json());
    expect(thread).toContain("from here");
    // Written once locally: the echo of our own write is the same row.
    expect((await sync()).error).toBe("");
    expect(bodies().filter((b) => b === "from here")).toHaveLength(1);
  });

  test("an issue and comment made on the origin arrive by signed webhook", async () => {
    const made = await bobApi("/api/v1/repos/bob/app/issues", {
      method: "POST",
      body: JSON.stringify({ title: "Bob asks" }),
    });
    const number = ((await made.json()) as { number: number }).number;
    await bobApi(`/api/v1/repos/bob/app/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: "first from bob" }),
    });
    expect(rows("SELECT 1 FROM issue WHERE repo_id = ?1 AND title = 'Bob asks'", mirror().id)).toHaveLength(0);

    const raw = JSON.stringify({ kind: "issue.commented", payload: { number } });
    const bad = await fetch(`${mineServers.url}/api/v1/repos/alice/app/origin-hook`, {
      method: "POST",
      headers: { [HOOK_SIGNATURE_HEADER]: "sha256=00" },
      body: raw,
    });
    expect(bad.status).toBe(404);
    expect((await deliver({ kind: "issue.commented", payload: { number } })).status).toBe(200);
    expect(rows("SELECT 1 FROM issue WHERE repo_id = ?1 AND title = 'Bob asks'", mirror().id)).toHaveLength(1);
    expect(bodies()).toContain("first from bob");
    // Delivered twice, still one row.
    await deliver({ kind: "issue.commented", payload: { number } });
    expect(bodies().filter((b) => b === "first from bob")).toHaveLength(1);
  });

  test("after the origin was down a sweep fetches what was missed, once", async () => {
    friendServers.stop();
    expect((await sync()).error).not.toBe("");
    friendServers = await serve(friend);
    const made = await bobApi("/api/v1/repos/bob/app/issues", {
      method: "POST",
      body: JSON.stringify({ title: "While you were out" }),
    });
    const number = ((await made.json()) as { number: number }).number;
    await bobApi(`/api/v1/repos/bob/app/issues/${number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body: "missed me" }),
    });
    await bobApi(`/api/v1/repos/bob/app/issues/1/comments`, {
      method: "POST",
      body: JSON.stringify({ body: "late reply" }),
    });
    expect((await sync()).error).toBe("");
    expect((await sync()).error).toBe("");
    expect(rows("SELECT 1 FROM issue WHERE repo_id = ?1 AND title = 'While you were out'", mirror().id)).toHaveLength(1);
    expect(bodies().filter((b) => b === "missed me")).toHaveLength(1);
    expect(bodies().filter((b) => b === "late reply")).toHaveLength(1);
  });
});

describe("a number that is a pull", () => {
  test("is never imported as an issue by the item read", async () => {
    const { Database } = await import("bun:sqlite");
    const { refreshOriginItem } = await import("../src/origins/item-check.ts");
    const db = new Database(":memory:");
    let imported = false;
    const provider = {
      getIssue: async () => ({ ok: true, value: { number: 3, pull: {} } }),
      listComments: async () => {
        imported = true;
        return { ok: true, value: [] };
      },
    };
    const ctx = { db, repoId: "r", actorId: "u" };
    // @ts-expect-error a stub with only what the read touches
    expect(await refreshOriginItem(ctx, provider, "o/r", 3)).toBe("pull");
    expect(imported).toBe(false);
  });
});
