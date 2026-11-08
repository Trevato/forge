import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { getUserByName } from "../src/core/users.ts";
import { getOriginById } from "../src/core/origins.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepo } from "../src/core/repos.ts";
import { listComments, listIssues } from "../src/core/issues.ts";
import { discover } from "../src/origins/discover.ts";
import { providerForOrigin } from "../src/origins/credential.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { syncOrigin, syncsSettled } from "../src/origins/sync.ts";
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
    // A fixed port, so the friend can go down and come back at the same address.
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const friendPort = probe.port as number;
    await probe.stop(true);
    friend = createApp({ dataDir: await make(), port: friendPort });
    friendServers = await serve(friend);
    await seedAdmin(friend, { username: "bob", email: "bob@friend.test", password: BOB });
    proveAll(friend);
    friendToken = createToken(friend.db, getUserByName(friend.db, "bob")!.id, "alice", "rw").token;
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

  describe("work crosses", () => {
    const bobApi = (path: string, init: RequestInit = {}) =>
      fetch(`${friendServers.url}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          authorization: basic("bob", BOB),
          ...(init.headers as Record<string, string> | undefined),
        },
      });
    const sync = async () => {
      const origin = getOriginById(mine.db, originId)!;
      await syncOrigin(mine, origin);
    };
    const local = () => getRepo(mine.db, "alice", "secret-app")!;

    test("an issue and a comment written there arrive here, under their author", async () => {
      const made = await bobApi("/api/v1/repos/bob/secret-app/issues", {
        method: "POST",
        body: JSON.stringify({ title: "It crashes", body: "on start" }),
      });
      expect(made.status).toBe(201);
      const number = ((await made.json()) as { number: number }).number;
      await bobApi(`/api/v1/repos/bob/secret-app/issues/${number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "me too" }),
      });
      await sync();
      const issue = listIssues(mine.db, local().id, { state: "all" }).find((i) => i.title === "It crashes");
      expect(issue?.originAuthor).toBe("bob");
      expect(listComments(mine.db, issue!.id).map((c) => c.body)).toContain("me too");
    });

    test("a comment written here lands there", async () => {
      const issue = listIssues(mine.db, local().id, { state: "all" })[0]!;
      const wrote = await mineApi(`/api/v1/repos/alice/secret-app/issues/${issue.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "looking now" }),
      });
      expect(wrote.status).toBe(201);
      const there = await bobApi(`/api/v1/repos/bob/secret-app/issues/${issue.number}/comments`);
      expect(JSON.stringify(await there.json())).toContain("looking now");
    });

    test("a pull opens on the origin, and its merge comes back", async () => {
      const edit = await bobApi("/api/v1/repos/bob/secret-app/contents", {
        method: "POST",
        body: JSON.stringify({
          branch: "feature",
          message: "a change",
          files: [{ path: "NOTE.md", content: "hi\n" }],
        }),
      });
      expect(edit.status).toBeLessThan(300);
      const origin = getOriginById(mine.db, originId)!;
      const provider = providerForOrigin(mine, origin);
      expect(provider.ok).toBe(true);
      if (!provider.ok) return;
      const opened = await provider.value.createPull("bob/secret-app", {
        title: "A change",
        body: "from the other side",
        base: "main",
        head: "feature",
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      expect(opened.value.pull?.headBranch).toBe("feature");
      expect(opened.value.state).toBe("open");
      const merged = await bobApi(`/api/v1/repos/bob/secret-app/pulls/${opened.value.number}/merge`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(merged.status).toBeLessThan(300);
      const again = await provider.value.getIssue("bob/secret-app", opened.value.number);
      expect(again.ok && again.value.pull?.mergedAt).toBeTruthy();
      await sync();
      const ours = getPull(mine.db, local().id, opened.value.number);
      expect(ours?.title).toBe("A change");
      expect(ours?.mergedAt).not.toBeNull();
    });

    test("an origin that is down leaves what was brought and refuses what would be lost, then catches up", async () => {
      const snapshot = () =>
        listIssues(mine.db, local().id, { state: "all" }).map((i) => ({
          number: i.number,
          title: i.title,
          state: i.state,
          comments: listComments(mine.db, i.id).map((c) => c.body),
        }));
      const before = snapshot();
      friendServers.stop();
      const report = await syncOrigin(mine, getOriginById(mine.db, originId)!);
      expect(report.error).not.toBe("");
      expect(snapshot()).toEqual(before);

      const issue = listIssues(mine.db, local().id, { state: "all" })[0]!;
      const wrote = await mineApi(`/api/v1/repos/alice/secret-app/issues/${issue.number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "while it is down" }),
      });
      expect(wrote.status).toBeGreaterThanOrEqual(500);
      expect(snapshot()).toEqual(before);

      // Written there while it was away from here: an issue and a comment.
      friendServers = await serve(friend);
      const made = await bobApi("/api/v1/repos/bob/secret-app/issues", {
        method: "POST",
        body: JSON.stringify({ title: "Written while down", body: "catch me up" }),
      });
      expect(made.status).toBe(201);
      const number = ((await made.json()) as { number: number }).number;
      await bobApi(`/api/v1/repos/bob/secret-app/issues/${number}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: "missed event" }),
      });
      const again = await syncOrigin(mine, getOriginById(mine.db, originId)!);
      expect(again.error).toBe("");
      const caught = listIssues(mine.db, local().id, { state: "all" }).find(
        (i) => i.title === "Written while down",
      );
      expect(caught?.originAuthor).toBe("bob");
      expect(listComments(mine.db, caught!.id).map((c) => c.body)).toContain("missed event");
    });

    test("a comment links to its thread, not the repository", async () => {
      const provider = providerForOrigin(mine, getOriginById(mine.db, originId)!);
      if (!provider.ok) throw new Error("no provider");
      const issue = listIssues(mine.db, local().id, { state: "all" })[0]!;
      const read = await provider.value.listComments("bob/secret-app", issue.number);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      const first = read.value[0]!;
      expect(first.htmlUrl).toBe(
        `${friendServers.url}/bob/secret-app/issues/${issue.number}#c-${first.remoteId}`,
      );
    });

    test("a head with more than one colon is refused", async () => {
      const provider = providerForOrigin(mine, getOriginById(mine.db, originId)!);
      if (!provider.ok) throw new Error("no provider");
      for (const head of ["a:b:c", ":x", "x:"]) {
        const refused = await provider.value.createPull("bob/secret-app", {
          title: "t",
          body: "",
          base: "main",
          head,
        });
        expect(refused.ok).toBe(false);
      }
    });
  });
});
