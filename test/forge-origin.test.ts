import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { getUserByName } from "../src/core/users.ts";
import { discover } from "../src/origins/discover.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { syncsSettled } from "../src/origins/sync.ts";
import { mirrorAndWait } from "./fake-origin.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { proveAll } from "./helpers/verified.ts";

/**
 * One forge connects to another as an origin (#8900): two real forges, one
 * friend's with a private and a public repository, and a pasted token that
 * lets this one see both and bring the private one across.
 */

setDefaultTimeout(60_000);

const ALICE = "alice-login-secret";
const BOB = "bob-login-secret";
const basic = (user: string, secret: string): string =>
  `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}`;

describe("a forge is an origin", () => {
  let dirs: string[] = [];
  let mine: App;
  let friend: App;
  let mineServers: Servers;
  let friendServers: Servers;
  let friendToken = "";
  let originId = "";

  const mineApi = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", basic("alice", ALICE));
    if (init.body !== undefined) headers.set("content-type", "application/json");
    return fetch(`${mineServers.url}${path}`, { ...init, headers });
  };

  async function makeRepo(visibility: "public" | "private", name: string): Promise<void> {
    const headers = { "content-type": "application/json", authorization: basic("bob", BOB) };
    const made = await fetch(`${friendServers.url}/api/v1/repos`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name, visibility }),
    });
    expect(made.status).toBe(201);
    const wrote = await fetch(`${friendServers.url}/api/v1/repos/bob/${name}/contents`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        branch: "main",
        message: "first",
        files: [{ path: "README.md", content: `${name}\n` }],
      }),
    });
    expect(wrote.status).toBeLessThan(300);
  }

  beforeAll(async () => {
    const make = async () => {
      const dir = await mkdtemp(join(tmpdir(), "forge-forge-origin-"));
      dirs.push(dir);
      return dir;
    };
    friend = createApp({ dataDir: await make(), port: 0 });
    friendServers = await serve(friend);
    await seedAdmin(friend, { username: "bob", email: "bob@friend.test", password: BOB });
    proveAll(friend);
    friendToken = createToken(friend.db, getUserByName(friend.db, "bob")!.id, "alice", "ro").token;
    await makeRepo("private", "secret-app");
    await makeRepo("public", "open-app");

    mine = createApp({ dataDir: await make(), port: 0 });
    mineServers = await serve(mine);
    await seedAdmin(mine, { username: "alice", email: "alice@forge.test", password: ALICE });
    proveAll(mine);
  }, 120_000);

  afterAll(async () => {
    await syncsSettled();
    mineServers.stop();
    friendServers.stop();
    mine.close();
    friend.close();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }, 120_000);

  test("a forge answers its version, and discover recognises it", async () => {
    const version = await fetch(`${friendServers.url}/api/v1/version`);
    expect(version.status).toBe(200);
    expect(await version.json()).toMatchObject({ software: "forge" });
    const found = await discover(friendServers.url, { FORGE_DEV: "1" });
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.value.via).toBe("version-endpoint");
      expect(found.value.software).toStartWith("forge ");
      expect(found.value.apiUrl).toBe(`${friendServers.url}/api/v1`);
    }
  });

  test("the token scheme a Gitea client sends is a token here", async () => {
    const as = (authorization: string) =>
      fetch(`${friendServers.url}/api/v1/user`, { headers: { authorization } });
    const ok = await as(`token ${friendToken}`);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ username: "bob" });
    expect((await as("token forge_nope")).status).toBe(401);
  });

  test("pasting a token connects, and the picker lists the private repository", async () => {
    const connected = await mineApi("/api/v1/user/origins", {
      method: "POST",
      body: JSON.stringify({ host: friendServers.url, token: friendToken }),
    });
    expect(connected.status).toBe(201);
    const origin = (await connected.json()) as { id: string; login: string; token?: string };
    expect(origin.login).toBe("bob");
    expect(JSON.stringify(origin)).not.toContain(friendToken);
    originId = origin.id;

    const listed = await mineApi(`/api/v1/user/origins/${originId}/repos`);
    expect(listed.status).toBe(200);
    const text = await listed.text();
    expect(text).toContain("bob/secret-app");
    expect(text).toContain("bob/open-app");
    expect(text).not.toContain(friendToken);
  });

  test("a private repository comes across with the credential", async () => {
    const job = await mirrorAndWait(
      await mineApi(`/api/v1/user/origins/${originId}/mirror`, {
        method: "POST",
        body: JSON.stringify({ fullName: "bob/secret-app" }),
      }),
    );
    expect(job?.stage).toBe("done");
    const theirs = await resolveOid(repoDir(friend.reposRoot, "bob", "secret-app"), "refs/heads/main");
    const ours = await resolveOid(repoDir(mine.reposRoot, "alice", "secret-app"), "refs/heads/main");
    expect(theirs).toBeDefined();
    expect(ours).toBe(theirs);
  });

  test("the origin says what did not come", async () => {
    const listed = await mineApi("/api/v1/user/origins");
    const rows = (await listed.json()) as { id: string; software: string; carries: string | null }[];
    const row = rows.find((o) => o.id === originId)!;
    expect(row.software).toBe("forge");
    expect(row.carries).toContain("data and its secrets");
    const page = await (await mineApi("/settings/origins")).text();
    expect(page.replace(/\s+/g, " ")).toContain("Another forge.");
  });

  test("without a token the private repository stays private", async () => {
    const anon = await fetch(`${friendServers.url}/bob/secret-app.git/info/refs?service=git-upload-pack`);
    expect(anon.status).not.toBe(200);
    const listed = await fetch(`${friendServers.url}/api/v1/user/repos`);
    expect(listed.status).toBe(401);
  });
});
