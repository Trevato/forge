import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectOrigin } from "../src/actions/origins.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createOrg } from "../src/core/orgs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { providerFor } from "../src/origins/providers/index.ts";
import { syncsSettled } from "../src/origins/sync.ts";
import { settled } from "../src/origins/jobs.ts";
import { staticCredential } from "../src/origins/types.ts";
import { promote } from "./helpers/members.ts";
import { proveAll } from "./helpers/verified.ts";

/**
 * The owner connected a friend's forge and saw "no repos": they own nothing
 * there. An origin's list is three labelled groups, and a repository someone
 * else owns is one a person can read, bring here, and send work back to when
 * their access allows, told plainly when it does not.
 */

setDefaultTimeout(60_000);

describe("an origin's repositories, in three groups", () => {
  const dirs: string[] = [];
  let mine: App;
  let friend: App;
  let mineServers: Servers;
  let friendServers: Servers;
  let bob: User;
  let carol: User;
  let cookie = "";
  let originId = "";
  let readWrite = "";

  const person = async (app: App, username: string): Promise<User> => {
    const made = await createUser(app.db, {
      username,
      email: `${username}@test.test`,
      password: `${username}-login-secret`,
      origin: "seed",
      trusted: true,
    });
    if (!made.ok) throw new Error(made.error);
    promote(app.db, made.value);
    return made.value;
  };
  const api = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${mineServers.url}${path}`, {
      ...init,
      headers: { cookie, origin: mineServers.url, "content-type": "application/json" },
    });
  const group = async (name: string, extra = ""): Promise<{ names: string[]; next: string | null; rows: { fullName: string; canPush: boolean }[] }> => {
    const seen = await api(`/api/v1/user/origins/${originId}/repos?group=${name}${extra}`);
    expect(seen.status).toBe(200);
    const body = (await seen.json()) as { items: { fullName: string; canPush: boolean }[]; next_cursor: string | null };
    return { names: body.items.map((r) => r.fullName), next: body.next_cursor, rows: body.items };
  };

  beforeAll(async () => {
    const make = async (): Promise<string> => {
      const dir = await mkdtemp(join(tmpdir(), "forge-groups-"));
      dirs.push(dir);
      return dir;
    };
    friend = createApp({ dataDir: await make(), port: 0 });
    friendServers = await serve(friend);
    bob = await person(friend, "bob");
    carol = await person(friend, "carol");
    proveAll(friend);
    const open = async (owner: User, name: string, visibility: "public" | "private", org?: string) => {
      const made = await createRepo(friend, owner, { name, visibility, ...(org === undefined ? {} : { owner: org }) });
      if (!made.ok) throw new Error(`${name}: ${String(made.error)}`);
      const done = await commitToBranch(friend, owner, made.value, {
        branch: "main",
        message: "first",
        files: [{ path: "a.txt", content: "a\n" }],
      });
      if (!done.ok) throw new Error(String(done.error));
    };
    await open(carol, "lantern", "public");
    await open(carol, "closed", "private");
    const org = createOrg(friend.db, "lantern-crew", bob.id);
    if (!org.ok) throw new Error(String(org.error));
    await open(bob, "shared-thing", "private", "lantern-crew");

    mine = createApp({ dataDir: await make(), port: 0 });
    mineServers = await serve(mine);
    const alice = await person(mine, "alice");
    proveAll(mine);
    cookie = `forge_session=${createSession(mine.db, alice.id).token}`;
    const connected = await connectOrigin(mine, alice, {
      host: friendServers.url,
      token: createToken(friend.db, bob.id, "ro", "ro").token,
    });
    if (!connected.ok) throw new Error(String(connected.error));
    originId = connected.value.id;
    readWrite = createToken(friend.db, bob.id, "rw", "rw").token;
  });

  afterAll(async () => {
    await syncsSettled();
    mineServers.stop();
    friendServers.stop();
    mine.close();
    friend.close();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  test("owning nothing there still shows what is shared and what is public, each in its group", async () => {
    expect((await group("yours")).names).toEqual([]);
    expect((await group("shared")).names).toEqual(["lantern-crew/shared-thing"]);
    const open = await group("public");
    expect(open.names).toEqual(["carol/lantern"]);
    expect(open.rows[0]!.canPush).toBe(false);
  });

  test("the page labels all three, and a group with nothing says why", async () => {
    const seen = await api(`/settings/origins/${originId}/repos`);
    const text = await seen.text();
    expect(text).toContain("Yours");
    expect(text).toContain("Shared with you");
    expect(text).toContain("Public on this forge");
    expect(text).toContain("This account owns no repositories there.");
    expect(text).toContain("carol/lantern");
    expect(text).not.toContain("carol/closed");
  });

  test("search narrows a group, and a group that is not one is refused", async () => {
    expect((await group("public", "&q=lant")).names).toEqual(["carol/lantern"]);
    expect((await group("public", "&q=nothing-like-it")).names).toEqual([]);
    const page = await (await api(`/settings/origins/${originId}/repos?q=nothing-like-it`)).text();
    expect(page).toContain("Nothing in this group matches that search.");
    expect((await api(`/api/v1/user/origins/${originId}/repos?group=everyone`)).status).toBe(422);
  });

  test("a repository someone else owns comes across, and read access cannot send work back, in words", async () => {
    const start = await api(`/api/v1/user/origins/${originId}/mirror`, {
      method: "POST",
      body: JSON.stringify({ fullName: "carol/lantern" }),
    });
    expect(start.status).toBe(202);
    const job = await settled(((await start.json()) as { job: { id: string } }).job.id);
    expect(job?.stage).toBe("done");
    expect((await group("public")).names).toEqual(["carol/lantern"]);

    const contribute = (): Promise<Response> =>
      api(`/api/v1/user/origins/${originId}/browse/carol/lantern/contribute`, {
        method: "POST",
        body: JSON.stringify({
          branch: "a-change",
          base: "main",
          message: "a change",
          files: [{ path: "b.txt", content: "b\n" }],
          openPull: { title: "A change", body: "from another forge" },
        }),
      });
    const refused = await contribute();
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const said = JSON.stringify(await refused.json());
    expect(said).toMatch(/write|access|scope|refused/i);
    expect(said).not.toContain("forge_");

    // With a token that can write, the same action forks it there and opens the pull.
    await api(`/api/v1/user/origins/${originId}`, { method: "DELETE" });
    const alice = getUserByName(mine.db, "alice")!;
    const again = await connectOrigin(mine, alice, { host: friendServers.url, token: readWrite });
    if (!again.ok) throw new Error(String(again.error));
    originId = again.value.id;
    const sent = await contribute();
    const answer = await sent.text();
    expect(sent.status, answer).toBeLessThan(300);
    const pulls = await fetch(`${friendServers.url}/api/v1/repos/carol/lantern/pulls`);
    const listed = (await pulls.json()) as { items: { title: string; authorName: string }[] };
    expect(listed.items.map((p) => [p.title, p.authorName])).toEqual([["A change", "bob"]]);
  });

  test("the fork takes a second name when the account already has that name, and the pull still opens", async () => {
    const bobsOwn = await createRepo(friend, bob, { name: "beacon", visibility: "public" });
    if (!bobsOwn.ok) throw new Error(String(bobsOwn.error));
    const carols = await createRepo(friend, carol, { name: "beacon", visibility: "public" });
    if (!carols.ok) throw new Error(String(carols.error));
    const first = await commitToBranch(friend, carol, carols.value, {
      branch: "main",
      message: "first",
      files: [{ path: "a.txt", content: "a\n" }],
    });
    if (!first.ok) throw new Error(String(first.error));
    const sent = await api(`/api/v1/user/origins/${originId}/browse/carol/beacon/contribute`, {
      method: "POST",
      body: JSON.stringify({
        branch: "to-carol",
        base: "main",
        message: "to carol",
        files: [{ path: "c.txt", content: "c\n" }],
        openPull: { title: "To Carol", body: "" },
      }),
    });
    const answer = await sent.text();
    expect(sent.status, answer).toBeLessThan(300);
    const pulls = await fetch(`${friendServers.url}/api/v1/repos/carol/beacon/pulls`);
    expect(((await pulls.json()) as { items: { title: string }[] }).items.map((p) => p.title)).toEqual(["To Carol"]);
  });
});

describe("Forgejo and Gitea, by /repos/search", () => {
  let server: ReturnType<typeof Bun.serve>;
  const asked: URLSearchParams[] = [];
  const row = (full: string, isPrivate: boolean, push: boolean) => ({
    id: full.length,
    full_name: full,
    name: full.split("/")[1],
    private: isPrivate,
    permissions: { push, admin: false },
  });

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/user") return Response.json({ id: 7, login: "ben" });
        if (url.pathname !== "/api/v1/repos/search") return Response.json({ page_size: 50 });
        asked.push(url.searchParams);
        const everyone = [row("ben/own", false, true), row("zed/let-in", true, true), row("zed/open", false, false)];
        const uid = url.searchParams.get("uid");
        return Response.json({ data: uid === null ? everyone : everyone.filter((r) => r.full_name !== "zed/open") });
      },
    });
  });
  afterAll(() => server.stop(true));

  test("each group asks for what it means and keeps only what it means", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const provider = providerFor(
      staticCredential({ kind: "gitea", apiUrl: `${base}/api/v1`, webUrl: base, login: "ben", token: "t" }),
    );
    const names = async (group: "yours" | "shared" | "public", q?: string): Promise<string[]> => {
      const read = await provider.listRepoGroup!(group, q === undefined ? {} : { q });
      if (!read.ok) throw new Error(read.error.message);
      return read.value.items.map((r) => r.fullName);
    };
    expect(await names("yours")).toEqual(["ben/own"]);
    expect(asked.at(-1)!.get("exclusive")).toBe("true");
    expect(await names("shared")).toEqual(["zed/let-in"]);
    expect(asked.at(-1)!.get("uid")).toBe("7");
    expect(await names("public", "open")).toEqual(["zed/open"]);
    expect(asked.at(-1)!.get("uid")).toBeNull();
    expect(asked.at(-1)!.get("q")).toBe("open");
  });
});
