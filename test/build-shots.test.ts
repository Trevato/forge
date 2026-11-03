/**
 * A pin's screenshots: a writer uploads them, picks them from the deploy's
 * pictures, orders, captions and removes them through the API; the web
 * only shows each picture. Git holds them as a tree kept by refs/shots/<label>. A picture is
 * one by its first bytes and within its limits; a stranger to a private
 * repository sees nothing, and a reader, a stranger and an agent change
 * nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { deletePin, pinBuild } from "../src/actions/builds.ts";
import { pickShots, uploadShot } from "../src/actions/build_shots.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp, getAppByRepo } from "../src/core/apps.ts";
import { recordLook, type Look } from "../src/core/looks.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { readShots, SHOT_MAX } from "../src/git/shots.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { eventVerb } from "../src/design/activity.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const PNG = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, n, n]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 9]);
const PAGE = new TextEncoder().encode("<script>alert(1)</script>");

describe("pin screenshots", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let repo: Repo;
  let secret: Repo;
  let oid: string;
  let desktop: Look;
  let phone: Look;
  let elsewhere: Look;
  let aliceToken: string;
  let bobToken: string;
  const cookies: Record<string, string> = {};
  const dir = () => repoDir(app.reposRoot, "alice", "karts");
  const shots = () => readShots(dir(), "v1");

  const signIn = async (username: string) =>
    (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({ username, password: "a-good-passphrase" }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
  const get = (path: string, who?: string) =>
    fetch(`${base}${path}`, { headers: who === undefined ? {} : { cookie: cookies[who] ?? "" }, redirect: "manual" });
  const api = (method: string, path: string, token: string, body?: string | FormData, type?: string) =>
    fetch(`${base}/api/v1/repos${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(type === undefined ? {} : { "content-type": type }) },
      ...(body === undefined ? {} : { body }),
    });
  const upload = (bytes: Uint8Array, caption: string, name = "shot.png") => {
    const form = new FormData();
    form.append("shot", new Blob([bytes], { type: "image/png" }), name);
    form.append("caption", caption);
    return form;
  };
  /** A picture the forge took of `commit`, on disk where the looks service keeps them. */
  const look = (appId: string, commit: string, kind: "phone" | "desktop", bytes: Uint8Array): Look => {
    const path = join("looks", appId, "production", `${commit}-${kind}.png`);
    mkdirSync(join(dataDir, "looks", appId, "production"), { recursive: true });
    writeFileSync(join(dataDir, path), bytes);
    return recordLook(app.db, { appId, env: "production", commitOid: commit, kind, path });
  };
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd: dir(), env: gitClientEnv() });
    return new TextDecoder().decode(r.stdout).trim();
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-shots-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    for (const name of ["alice", "bob"]) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: name,
        email: `${name}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!made.ok) throw new Error(made.error);
      if (name === "alice") alice = made.value;
      cookies[name] = await signIn(name);
    }
    aliceToken = createToken(app.db, alice.id, "t", "rw").token;
    bobToken = createToken(app.db, getUserByName(app.db, "bob")!.id, "t", "rw").token;
    const made = await createRepo(app, alice, { name: "karts", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const c = await commitToBranch(app, alice, repo, { message: "one", files: [{ path: "a.txt", content: "a\n" }] });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    oid = c.value.commitOid;
    const c2 = await commitToBranch(app, alice, repo, { message: "two", files: [{ path: "a.txt", content: "b\n" }] });
    if (!c2.ok) throw new Error(JSON.stringify(c2.error));
    const pinned = await pinBuild(app, alice, repo, { label: "v1", oid });
    if (!pinned.ok) throw new Error(pinned.error);
    const record = insertApp(app.db, { repoId: repo.id, slug: "karts", access: "public" });
    if (!record.ok) throw new Error(record.error);
    desktop = look(record.value.id, oid, "desktop", PNG(1));
    phone = look(record.value.id, oid, "phone", PNG(2));
    elsewhere = look(record.value.id, c2.value.commitOid, "desktop", PNG(3));

    const hidden = await createRepo(app, alice, { name: "secret", visibility: "private" });
    if (!hidden.ok) throw new Error(String(hidden.error));
    secret = hidden.value;
    const s = await commitToBranch(app, alice, secret, { message: "one", files: [{ path: "a.txt", content: "a\n" }] });
    if (!s.ok) throw new Error(JSON.stringify(s.error));
    const sp = await pinBuild(app, alice, secret, { label: "v1", oid: s.value.commitOid });
    if (!sp.ok) throw new Error(sp.error);
    const up = await uploadShot(app, alice, secret, "v1", PNG(9), "hidden");
    if (!up.ok) throw new Error(up.error);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a writer uploads screenshots; git holds them as a tree with shots.json", async () => {
    expect((await api("POST", "/alice/karts/builds/v1/shots", aliceToken, upload(PNG(5), "Start screen"))).status).toBe(201);
    expect((await api("POST", "/alice/karts/builds/v1/shots", aliceToken, upload(JPEG, "  Race\nend  ", "x.bin"))).status).toBe(201);
    const read = await shots();
    expect(read.items.map((s) => [s.file, s.caption])).toEqual([["01.png", "Start screen"], ["02.jpg", "Race end"]]);
    // Git is truth: the ref points at a tree of the pictures and the list.
    expect(git("cat-file", "-t", "refs/shots/v1")).toBe("tree");
    expect(git("ls-tree", "--name-only", "refs/shots/v1").split("\n")).toEqual(["01.png", "02.jpg", "shots.json"]);
    expect(JSON.parse(git("cat-file", "blob", "refs/shots/v1:shots.json"))).toEqual([
      { file: "01.png", caption: "Start screen" },
      { file: "02.jpg", caption: "Race end" },
    ]);
    expect(git("rev-parse", "refs/shots/v1")).toBe(read.tree!);
  });

  test("a reader sees each picture with its own type and nosniff", async () => {
    const png = await get("/alice/karts/builds/v1/shots/01.png", "bob");
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(png.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(PNG(5));
    const jpg = await get("/alice/karts/builds/v1/shots/02.jpg");
    expect(jpg.headers.get("content-type")).toBe("image/jpeg");
    expect((await get("/alice/karts/builds/v1/shots/03.png")).status).toBe(404);
    expect((await get("/alice/karts/builds/v1/shots/..%2Fa.txt")).status).toBe(404);
  });

  test("a picture is one by its first bytes, within 2 MB and 12 a pin", async () => {
    const before = (await shots()).tree;
    // A page named .png is refused; so is a picture past the limit.
    const big = new Uint8Array(SHOT_MAX + 1);
    big.set(PNG(0));
    const html = await api("POST", "/alice/karts/builds/v1/shots", aliceToken, upload(PAGE, "evil", "evil.png"));
    expect(html.status).toBe(422);
    expect(((await html.json()) as { error: string }).error).toBe("invalid_shot");
    const large = await api("POST", "/alice/karts/builds/v1/shots", aliceToken, upload(big, "big"));
    expect(large.status).toBe(413);
    const long = await api("POST", "/alice/karts/builds/v1/shots", aliceToken, upload(PNG(1), "x".repeat(141)));
    expect(((await long.json()) as { error: string }).error).toBe("invalid_caption");
    expect((await shots()).tree).toBe(before);
    // Fill to twelve; the thirteenth is refused.
    for (let i = (await shots()).items.length; i < 12; i++) {
      const r = await api("POST", "/alice/karts/builds/v1/shots", aliceToken, upload(i % 2 ? WEBP : PNG(i), `n${i}`));
      expect(r.status).toBe(201);
    }
    const full = await api("POST", "/alice/karts/builds/v1/shots", aliceToken, upload(PNG(1), "one more"));
    expect(full.status).toBe(409);
    expect(((await full.json()) as { error: string }).error).toBe("too_many");
    expect((await shots()).items.length).toBe(12);
    expect((await shots()).items.some((s) => s.type === "image/webp")).toBe(true);
    // Back to the two this file started with.
    for (let left = (await shots()).items; left.length > 2; left = (await shots()).items)
      expect((await api("DELETE", `/alice/karts/builds/v1/shots/${left[2]!.file}`, aliceToken)).status).toBe(204);
  });

  test("a writer reorders, captions and removes; each change is a new tree", async () => {
    const first = (await shots()).tree!;
    const json = "application/json";
    const up = await api("POST", "/alice/karts/builds/v1/shots/02.jpg", aliceToken, JSON.stringify({ move: "up", at: first }), json);
    expect(up.status).toBe(200);
    expect((await shots()).items.map((s) => [s.file, s.caption])).toEqual([["01.jpg", "Race end"], ["02.png", "Start screen"]]);
    // A change drawn from the old tree changes nothing.
    expect((await api("DELETE", `/alice/karts/builds/v1/shots/01.jpg?at=${first}`, aliceToken)).status).toBe(409);
    expect((await shots()).items.length).toBe(2);
    const second = (await shots()).tree!;
    expect(second).not.toBe(first);
    const titled = await api("POST", "/alice/karts/builds/v1/shots/02.png", aliceToken, JSON.stringify({ caption: "Title", at: second }), json);
    expect(titled.status).toBe(200);
    expect((await shots()).items[1]!.caption).toBe("Title");
    const moved = await api("POST", "/alice/karts/builds/v1/shots/02.png", aliceToken, JSON.stringify({ move: "up", caption: "Title card" }), json);
    expect(moved.status).toBe(200);
    const listed = (await moved.json()) as { items: { file: string; caption: string; url: string }[]; next_cursor: null; tree: string };
    expect(listed.items.map((s) => [s.file, s.caption])).toEqual([["01.png", "Title card"], ["02.jpg", "Race end"]]);
    expect(listed.next_cursor).toBeNull();
    expect(listed.items[0]!.url).toMatch(/^\/alice\/karts\/builds\/v1\/shots\/01\.png\?v=[0-9a-f]{12}$/);
    expect((await api("DELETE", `/alice/karts/builds/v1/shots/02.jpg?at=${listed.tree}`, aliceToken)).status).toBe(204);
    expect((await shots()).items.map((s) => s.file)).toEqual(["01.png"]);
    expect(git("ls-tree", "--name-only", "refs/shots/v1").split("\n")).toEqual(["01.png", "shots.json"]);
  });

  test("a writer picks screenshots from the pictures of the pin's commit", async () => {
    const offered = await api("GET", "/alice/karts/builds/v1/shots/looks", aliceToken);
    const ids = ((await offered.json()) as { items: { id: string }[] }).items.map((l) => l.id).sort();
    expect(ids).toEqual([desktop.id, phone.id].sort());
    // Another commit's picture is not this pin's to take.
    const picked = await api("POST", "/alice/karts/builds/v1/shots/looks", aliceToken, JSON.stringify({ looks: [phone.id, desktop.id, elsewhere.id] }), "application/json");
    expect(picked.status).toBe(201);
    const read = await shots();
    expect(read.items.map((s) => s.file)).toEqual(["01.png", "02.png", "03.png"]);
    expect(new Uint8Array(await (await get("/alice/karts/builds/v1/shots/02.png")).arrayBuffer())).toEqual(PNG(2));
    expect(new Uint8Array(await (await get("/alice/karts/builds/v1/shots/03.png")).arrayBuffer())).toEqual(PNG(1));
    const none = await api("POST", "/alice/karts/builds/v1/shots/looks", aliceToken, JSON.stringify({ looks: [elsewhere.id] }), "application/json");
    expect(((await none.json()) as { error: string }).error).toBe("nothing_picked");
  });

  test("the looks on offer carry an ETag; a repeat is 304 until a new look of the pin's commit is taken", async () => {
    const first = await api("GET", "/alice/karts/builds/v1/shots/looks", aliceToken);
    const tag = first.headers.get("etag")!;
    expect(tag).toMatch(/^W\//);
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    expect(first.headers.get("vary")).toContain("authorization, cookie");
    const again = await fetch(`${base}/api/v1/repos/alice/karts/builds/v1/shots/looks`, {
      headers: { authorization: `Bearer ${aliceToken}`, "if-none-match": tag },
    });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(tag);
    expect(await again.text()).toBe("");
    const record = getAppByRepo(app.db, repo.id)!;
    const path = join("looks", record.id, "production", `${oid}-about.png`);
    mkdirSync(join(dataDir, "looks", record.id, "production"), { recursive: true });
    writeFileSync(join(dataDir, path), PNG(9));
    recordLook(app.db, { appId: record.id, env: "production", commitOid: oid, kind: "desktop", page: "/about", path });
    const after = await fetch(`${base}/api/v1/repos/alice/karts/builds/v1/shots/looks`, {
      headers: { authorization: `Bearer ${aliceToken}`, "if-none-match": tag },
    });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(tag);
  });

  test("a viewer who may fetch fewer looks has another tag, and is not given a 304 on a writer's", async () => {
    // The looks here were taken as the owner: alice (a writer) may fetch them, bob (a reader) may not.
    const url = `${base}/api/v1/repos/alice/karts/builds/v1/shots/looks`;
    const aliceRead = await fetch(url, { headers: { authorization: `Bearer ${aliceToken}` } });
    const bobRead = await fetch(url, { headers: { authorization: `Bearer ${bobToken}` } });
    expect(((await aliceRead.json()) as { items: unknown[] }).items.length).toBeGreaterThan(0);
    expect(((await bobRead.json()) as { items: unknown[] }).items).toEqual([]);
    const aliceTag = aliceRead.headers.get("etag")!;
    expect(bobRead.headers.get("etag")).not.toBe(aliceTag);
    const crossed = await fetch(url, { headers: { authorization: `Bearer ${bobToken}`, "if-none-match": aliceTag } });
    expect(crossed.status).toBe(200);
  });

  test("a reader and a signed-out visitor change nothing", async () => {
    const before = (await shots()).tree;
    expect((await api("POST", "/alice/karts/builds/v1/shots", bobToken, upload(PNG(1), "x"))).status).toBe(403);
    const signedOut = await fetch(`${base}/api/v1/repos/alice/karts/builds/v1/shots/01.png`, { method: "DELETE" });
    expect(signedOut.status).toBe(401);
    expect((await api("DELETE", "/alice/karts/builds/v1/shots/01.png", bobToken)).status).toBe(403);
    expect((await api("POST", "/alice/karts/builds/v1/shots/looks", bobToken, JSON.stringify({ looks: [desktop.id] }), "application/json")).status).toBe(403);
    expect((await shots()).tree).toBe(before);
  });

  test("the gallery carries an ETag: a repeat is 304 until a shot is added, moved or removed", async () => {
    const first = await api("GET", "/alice/karts/builds/v1/shots", aliceToken);
    const tag = first.headers.get("etag")!;
    expect(tag).toStartWith('W/"');
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    const repeat = await fetch(`${base}/api/v1/repos/alice/karts/builds/v1/shots`, { headers: { authorization: `Bearer ${aliceToken}`, "if-none-match": tag } });
    expect(repeat.status).toBe(304);
    expect(repeat.headers.get("etag")).toBe(tag);
    expect(repeat.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await repeat.text()).toBe("");
    const tagged = async () => (await api("GET", "/alice/karts/builds/v1/shots", aliceToken)).headers.get("etag")!;
    const room = (await shots()).items.length < 12;
    expect(room).toBe(true);
    expect((await api("POST", "/alice/karts/builds/v1/shots", aliceToken, upload(PNG(77), "tag"))).status).toBe(201);
    const added = await tagged();
    expect(added).not.toBe(tag);
    const stale = await fetch(`${base}/api/v1/repos/alice/karts/builds/v1/shots`, { headers: { authorization: `Bearer ${aliceToken}`, "if-none-match": tag } });
    expect(stale.status).toBe(200);
    const last = (await shots()).items.at(-1)!.file;
    expect((await api("POST", `/alice/karts/builds/v1/shots/${last}`, aliceToken, JSON.stringify({ move: "up" }), "application/json")).status).toBe(200);
    const moved = await tagged();
    expect(moved).not.toBe(added);
    expect((await api("DELETE", `/alice/karts/builds/v1/shots/${last}`, aliceToken)).status).toBe(204);
    expect(await tagged()).not.toBe(moved);
  });

  test("a stranger to a private repository gets 404 for its pictures and its writes", async () => {
    expect((await get("/alice/secret/builds/v1/shots/01.png", "alice")).status).toBe(200);
    expect((await get("/alice/secret/builds/v1/shots/01.png", "bob")).status).toBe(404);
    expect((await get("/alice/secret/builds/v1/shots/01.png")).status).toBe(404);
    expect((await api("GET", "/alice/secret/builds/v1/shots", bobToken)).status).toBe(404);
    expect((await api("POST", "/alice/secret/builds/v1/shots", bobToken, upload(PNG(1), "x"))).status).toBe(404);
    expect((await api("DELETE", "/alice/secret/builds/v1/shots/01.png", bobToken)).status).toBe(404);
    expect((await readShots(repoDir(app.reposRoot, "alice", "secret"), "v1")).items.length).toBe(1);
  });

  test("an agent on the crew is refused, as on the demo", async () => {
    const made = await createAgent(app, alice, { username: "atlas" });
    if (!made.ok) throw new Error(String(made.error));
    expect(addToCrew(app, alice, repo, "atlas").ok).toBe(true);
    const atlas = getUserByName(app.db, "atlas")!;
    const before = (await shots()).tree;
    expect(await uploadShot(app, atlas, repo, "v1", PNG(1), "x")).toEqual({ ok: false, error: "forbidden" });
    expect(await pickShots(app, atlas, repo, "v1", [desktop.id])).toEqual({ ok: false, error: "forbidden" });
    const token = createToken(app.db, atlas.id, "t", "rw").token;
    expect((await api("POST", "/alice/karts/builds/v1/shots", token, upload(PNG(1), "x"))).ok).toBe(false);
    expect((await shots()).tree).toBe(before);
  });

  test("every change is an event its readers see", () => {
    const kinds = app.db
      .query<{ payload: string }, [string]>("SELECT payload FROM event WHERE kind = 'build.shots' AND repo_id = ?1")
      .all(repo.id)
      .map((r) => (JSON.parse(r.payload) as { change: string }).change);
    for (const change of ["added", "moved", "captioned", "removed", "picked"]) expect(kinds).toContain(change);
  });

  test("two writers racing on one list: one lands, the other is told it moved; a stale `at` is refused", async () => {
    const before = await shots();
    const [a, b] = await Promise.all([
      uploadShot(app, alice, repo, "v1", PNG(7), "a"),
      uploadShot(app, alice, repo, "v1", PNG(8), "b"),
    ]);
    expect([a.ok, b.ok].filter(Boolean).length).toBe(1);
    expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, error: "moved" });
    expect((await shots()).items.length).toBe(before.items.length + 1);
    expect(await uploadShot(app, alice, repo, "v1", PNG(9), "c", before.tree ?? "")).toEqual({ ok: false, error: "moved" });
    expect((await pickShots(app, alice, repo, "v1", [desktop.id], before.tree ?? "")).ok).toBe(false);
  });

  test("deleting the pin deletes its screenshots, so a label pinned again starts bare", async () => {
    expect((await shots()).items.length).toBeGreaterThan(0);
    const gone = await deletePin(app, alice, repo, "v1");
    expect(gone.ok).toBe(true);
    expect((await shots()).items).toEqual([]);
    expect((await pinBuild(app, alice, repo, { label: "v1", oid })).ok).toBe(true);
    expect((await shots()).items).toEqual([]);
  });
});

describe("activity wording for build events", () => {
  const say = (kind: string, payload: Record<string, unknown>) =>
    eventVerb({ id: "e", kind, repoId: null, actorId: null, payload, createdAt: "" });

  test("every shots change and every build kind has a line", () => {
    expect(say("build.shots", { label: "v1", change: "added" })).toBe("added a screenshot to the pin v1");
    expect(say("build.shots", { label: "v1", change: "picked" })).toBe("picked screenshots from the deploy for the pin v1");
    expect(say("build.shots", { label: "v1", change: "moved" })).toBe("reordered the screenshots of the pin v1");
    expect(say("build.shots", { label: "v1", change: "captioned" })).toBe("captioned a screenshot of the pin v1");
    expect(say("build.shots", { label: "v1", change: "removed" })).toBe("removed a screenshot from the pin v1");
    expect(say("build.shots", {})).toBe("changed the screenshots of a pin");
    expect(say("build.pinned", {})).toBe("pinned a build");
    expect(say("build.deleted", {})).toBe("removed a build pin");
    expect(say("build.noted", {})).toBe("noted a pinned build");
  });
});
