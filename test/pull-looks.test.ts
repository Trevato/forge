/**
 * GET …/pulls/:number/looks lists what POST attached, and only what the
 * reader may fetch: scoped to the pull's own environment, no errored look,
 * no owner-taken look for a non-writer, nothing of a private app to a reader
 * it does not name, nothing of a private repository to an outsider. MCP `pull`
 * carries the same list.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { previewEnv } from "../src/apps/data.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { recordLook } from "../src/core/looks.ts";
import type { Pull } from "../src/core/pulls.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { encodePng } from "../src/design/image/png.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { getRepo } from "../src/core/repos.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { pullLooksScreen } from "../src/tui/screens/pulllooks.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-good-passphrase";
const PHONE = Buffer.from(
  encodePng(390, 844, new Uint8Array(390 * 844 * 4).fill(200)),
).toString("base64");

let dataDir: string;
let app: App;
let servers: Servers;
const tokens: Record<string, string> = {};
const pulls: Record<string, Pull[]> = {};
const apps: Record<string, string> = {};

const url = (repo: string, n: number) =>
  `${servers.url}/api/v1/repos/alice/${repo}/pulls/${n}/looks`;
const get = (repo: string, token: string | null, n = pulls[repo]![0]!.number) =>
  fetch(url(repo, n), { headers: token ? { authorization: `Bearer ${token}` } : {} });
const items = async (repo: string, token: string | null) =>
  ((await (await get(repo, token)).json()) as { items: Record<string, any>[] }).items;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-pull-looks-"));
  app = createApp({ dataDir, port: 0 });
  const person = async (username: string): Promise<User> => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: PASSWORD,
      adminIfFirst: username === "alice",
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const alice = await person("alice");
  const bob = await person("bob");
  const repoWith = async (
    name: string,
    visibility: "public" | "private",
    access: "public" | "private" | undefined,
  ) => {
    const made = await createRepo(app, alice, { name, visibility });
    if (!made.ok) throw new Error(String(made.error));
    const repo = made.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: `# ${name}\n` }],
    });
    pulls[name] = [];
    for (const branch of ["one", "two"]) {
      await commitToBranch(app, alice, repo, {
        branch,
        base: "main",
        message: branch,
        files: [{ path: `${branch}.md`, content: "x\n" }],
      });
      const opened = await openPull(app, alice, repo, {
        title: `Change ${branch}`,
        body: "",
        baseBranch: "main",
        headBranch: branch,
      });
      if (!opened.ok) throw new Error(String(opened.error));
      pulls[name]!.push(opened.value);
    }
    if (access !== undefined) {
      const inserted = insertApp(app.db, { repoId: repo.id, slug: name, access });
      if (!inserted.ok) throw new Error(inserted.error);
      apps[name] = inserted.value.id;
    }
  };
  await repoWith("bare", "public", undefined);
  await repoWith("garden", "public", "public");
  await repoWith("hush", "public", "private");
  await repoWith("den", "private", "public");
  servers = await serve(app);
  tokens["alice"] = createToken(app.db, alice.id, "t", "rw").token;
  tokens["bob"] = createToken(app.db, bob.id, "t", "rw").token;
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const record = (name: string, n: number, extra: Record<string, unknown>) =>
  recordLook(app.db, {
    appId: apps[name]!,
    env: previewEnv(n),
    commitOid: "a".repeat(40),
    kind: "phone",
    path: "looks/x.png",
    takenAs: "nobody",
    ...extra,
  } as Parameters<typeof recordLook>[1]);

test("a pull with no app answers an empty list", async () => {
  const res = await get("bare", tokens["alice"]!);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ items: [] });
});

test("a nonexistent pull number is a 404", async () => {
  expect((await get("garden", tokens["alice"]!, 999)).status).toBe(404);
  expect((await get("garden", tokens["alice"]!, 0)).status).toBe(404);
});

test("a look attached through the POST is listed by the GET", async () => {
  const n = pulls["den"]![0]!.number;
  const posted = await fetch(url("den", n), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tokens["alice"]}` },
    body: JSON.stringify({ width: "phone", says: "the empty den", image: PHONE }),
  });
  expect(posted.status).toBe(201);
  const made = (await posted.json()) as { id: string; url: string };
  const listed = await items("den", tokens["alice"]!);
  expect(listed).toHaveLength(1);
  expect(listed[0]).toMatchObject({
    id: made.id,
    width: "phone",
    says: "the empty den",
    by: "alice",
    url: made.url,
  });
  expect(typeof listed[0]!.at).toBe("string");
  // A private repository does not exist to an outsider or a guest.
  expect((await get("den", tokens["bob"]!)).status).toBe(404);
  expect((await get("den", null)).status).toBe(404);
});

test("only what the reader may fetch is listed, and only this pull's", async () => {
  const [one, two] = pulls["garden"]!;
  record("garden", one!.number, { kind: "desktop", takenAs: "nobody", note: "seen" });
  // An errored look, an owner-taken look and another pull's look.
  record("garden", one!.number, { commitOid: "b".repeat(40), error: "boom", path: "" });
  record("garden", one!.number, { commitOid: "c".repeat(40), takenAs: "owner" });
  record("garden", two!.number, { commitOid: "d".repeat(40), note: "elsewhere" });

  const mine = await items("garden", tokens["alice"]!);
  expect(mine.map((i) => i.commit).sort()).toEqual(["a".repeat(40), "c".repeat(40)]);

  // A reader who cannot write, and a guest (a public repository answers anonymously).
  for (const who of [tokens["bob"]!, null]) {
    const seen = await items("garden", who);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ commit: "a".repeat(40), width: "desktop", says: "seen" });
  }
  // The other pull lists its own.
  const other = await items("garden", tokens["alice"]!).then(() =>
    get("garden", tokens["alice"]!, two!.number).then((r) => r.json()),
  );
  expect((other as { items: { says: string }[] }).items.map((i) => i.says)).toEqual(["elsewhere"]);
});

test("a private app's looks are not a reader's unless named", async () => {
  const one = pulls["hush"]![0]!;
  record("hush", one.number, { note: "private" });
  expect(await items("hush", tokens["alice"]!)).toHaveLength(1);
  expect(await items("hush", tokens["bob"]!)).toEqual([]);
  expect(await items("hush", null)).toEqual([]);
});

test("MCP pull carries the same looks, gated the same", async () => {
  const call = async (token: string, repo: string) => {
    const res = await fetch(`${servers.url}/mcp`, {
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
        params: { name: "pull", arguments: { repo: `alice/${repo}`, number: pulls[repo]![0]!.number } },
      }),
    });
    const body = (await res.json()) as any;
    return JSON.parse(body.result.content[0].text) as { looks: { says: string | null }[] };
  };
  expect((await call(tokens["alice"]!, "hush")).looks).toHaveLength(1);
  expect((await call(tokens["bob"]!, "hush")).looks).toEqual([]);
  expect((await call(tokens["bob"]!, "garden")).looks).toHaveLength(1);
});

test("the terminal screen lists the same looks, gated the same", async () => {
  const shown = async (username: string, repoName: string) => {
    const person = getUserByName(app.db, username)!;
    const repo = getRepo(app.db, "alice", repoName)!;
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: username, remoteAddress: "127.0.0.1", user: person },
      { terminal: headlessTerminal(140, 30), exitHooks: false },
    );
    tui.start();
    await settleApp(tui);
    tui.push(pullLooksScreen(session, tui.ctx, repo, pulls[repoName]![0]!));
    await settleApp(tui);
    return tui.screen.toText();
  };
  expect(await shown("alice", "hush")).toContain("phone · private");
  expect(await shown("bob", "hush")).toContain("No looks yet");
});
