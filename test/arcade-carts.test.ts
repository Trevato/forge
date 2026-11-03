/**
 * Arcade carts: a cart built outside the forge is imported as a pin that
 * carries its demo, with its page and picture kept once, and its cover
 * kept by the repository.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { captureCart, captureState, capturePath, importCapture, keepPage, readArt, readCapture, startCapture } from "../src/arcade/carts.ts";
import { importCart } from "../src/arcade/import.ts";
import { createUser } from "../src/core/users.ts";
import { deletePin, listBuildPins, parsePinMessage, readBuildPin, setPinDemo } from "../src/git/builds.ts";
import { repoDir } from "../src/git/repos.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5]);
const HTML = new TextEncoder().encode("<!doctype html><title>kart</title>");
const tagger = { name: "Jay Moran", email: "jay@example.test" };

describe("arcade carts", () => {
  let dataDir: string;
  let app: App;
  let sha = "";
  let dir = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-carts-"));
    app = createApp({ dataDir, port: 0 });
    const user = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!user.ok) throw new Error(user.error);
    const alice = user.value;
    const made = await createRepo(app, alice, { name: "karts", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const c = await commitToBranch(app, alice, made.value, {
      branch: "main", message: "one", files: [{ path: "a.txt", content: "a\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    sha = c.value.commitOid;
    dir = repoDir(app.reposRoot, "alice", "karts");
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const entry = (over: object = {}) => ({
    repo: "alice/karts", label: "iter-1", sha, note: "first",
    cart: { name: "fiesta-kart", version: "1.2", page: "/", shelf: true },
    html: HTML, cover: PNG, art: PNG, ...over,
  });

  test("an import pins the commit with its demo and keeps the page, picture and cover", async () => {
    const done = await importCart(dataDir, entry(), tagger);
    expect(done.ok && done.value).toEqual({ label: "iter-1", pinned: true, captured: true });
    const pin = await readBuildPin(dir, "iter-1");
    expect(pin?.oid).toBe(sha);
    expect(pin?.pinnedBy).toBe("Jay Moran");
    expect(pin?.demo).toMatchObject({ name: "fiesta-kart", version: "1.2", launch: "file", page: "/", showcase: true });
    expect(pin?.demo?.cover).toMatch(/^[0-9a-f]{40,64}$/);
    expect(readCapture(dataDir, { ownerName: "alice", name: "karts" }, sha, "/")).toEqual(HTML);
    expect(readArt(dataDir, { ownerName: "alice", name: "karts" }, sha, "/")).toEqual(PNG);
  });

  test("importing again changes nothing: the page is written once", async () => {
    const again = await importCart(dataDir, entry({ html: new TextEncoder().encode("other") }), tagger);
    expect(again.ok && again.value).toEqual({ label: "iter-1", pinned: false, captured: false });
    expect(readCapture(dataDir, { ownerName: "alice", name: "karts" }, sha, "/")).toEqual(HTML);
    expect((await listBuildPins(dir)).length).toBe(1);
  });

  test("an import refuses what is not a repo, a commit, a cover or a page", async () => {
    expect((await importCart(dataDir, entry({ repo: "../x/y" }), tagger)).ok).toBe(false);
    expect((await importCart(dataDir, entry({ label: "iter-2", sha: "0".repeat(40) }), tagger)).ok).toBe(false);
    expect((await importCart(dataDir, entry({ label: "iter-3", cover: new Uint8Array([1, 2, 3]) }), tagger)).ok).toBe(false);
    expect((await importCart(dataDir, entry({ label: "iter-1", sha: "1".repeat(40) }), tagger)).ok).toBe(false);
    expect((await importCart(dataDir, entry({ label: "iter-4", cart: { name: "x", version: "1", page: "/../x", shelf: false } }), tagger)).ok).toBe(false);
  });

  test("a capture path cannot leave the carts directory", () => {
    const repo = { ownerName: "alice", name: "karts" };
    expect(importCapture(dataDir, repo, sha, "/../../x", HTML).ok).toBe(false);
    expect(importCapture(dataDir, repo, "../../etc", "/", HTML).ok).toBe(false);
    expect(readCapture(dataDir, repo, "../../etc", "/")).toBeUndefined();
    expect(existsSync(capturePath(dataDir, repo, sha, "/spicy"))).toBe(false);
  });

  test("a demo survives a rewrite of its pin, and goes when set to none; deleting drops the cover", async () => {
    const pin = (await readBuildPin(dir, "iter-1"))!;
    const hid = await setPinDemo(dir, "iter-1", { ...pin.demo!, showcase: false });
    expect(hid.ok && hid.value.demo?.showcase).toBe(false);
    const back = (await readBuildPin(dir, "iter-1"))!;
    expect(back).toMatchObject({ oid: sha, note: "first", pinnedBy: "Jay Moran", source: "import" });
    expect(back.demo?.showcase).toBe(false);
    expect((await setPinDemo(dir, "iter-1", { ...back.demo!, name: "bad\nname" })).ok).toBe(false);
    expect((await setPinDemo(dir, "nope", undefined)).ok).toBe(false);
    expect((await setPinDemo(dir, "iter-1", undefined)).ok).toBe(true);
    expect((await readBuildPin(dir, "iter-1"))?.demo).toBeUndefined();
    expect((await deletePin(dir, "iter-1")).ok).toBe(true);
  });

  test("old Cart: and Shelf: trailers still read as a demo", () => {
    const m = parsePinMessage("n\n\nSource: commit\nCart: old\nVersion: 3\nPage: /\nShelf: on\n");
    expect(m.demo).toMatchObject({ name: "old", launch: "file", showcase: true });
  });
});

describe("arcade capture", () => {
  const { mkdtempSync, readFileSync: rf } = require("node:fs") as typeof import("node:fs");
  const stub = Bun.serve({
    port: 0,
    fetch: (r) => {
      const path = new URL(r.url).pathname;
      if (path === "/big") return new Response(new Uint8Array(2000));
      if (path === "/gone") return new Response("no", { status: 404 });
      return new Response("<p>game</p>");
    },
  });
  const url = (p: string) => `http://127.0.0.1:${stub.port}${p}`;
  const picture = (calls: string[]) => async (input: { url: string; out: string }) => {
    calls.push(input.url);
    await Bun.write(input.out, PNG);
    return { ok: true, value: {} } as never;
  };

  test("a page is kept once, with its picture taken by the stand-in", async () => {
    const base = join(mkdtempSync(join(tmpdir(), "forge-keep-")), "index");
    const calls: string[] = [];
    expect((await keepPage(base, url("/"), picture(calls))).ok).toBe(true);
    expect(rf(`${base}.html`, "utf8")).toBe("<p>game</p>");
    expect(new Uint8Array(rf(`${base}.png`))).toEqual(PNG);
    expect(calls).toEqual([url("/")]);
    expect(existsSync(`${base}.${process.pid}.shot.png`)).toBe(false);
  });

  test("a missing page, a page over the cap, or a dead server keeps nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-keep-"));
    const none = picture([]);
    expect((await keepPage(join(dir, "a"), url("/gone"), none)).ok).toBe(false);
    expect((await keepPage(join(dir, "b"), url("/big"), none, "", "", "", 1000)).ok).toBe(false);
    expect((await keepPage(join(dir, "c"), "http://127.0.0.1:1/", none)).ok).toBe(false);
    expect(existsSync(join(dir, "a.html")) || existsSync(join(dir, "b.html")) || existsSync(join(dir, "c.html"))).toBe(false);
  });

  test("a failed picture still keeps the page", async () => {
    const base = join(mkdtempSync(join(tmpdir(), "forge-keep-")), "index");
    const failed = (async () => ({ ok: false, error: "no chromium" })) as never;
    expect((await keepPage(base, url("/"), failed)).ok).toBe(true);
    expect(existsSync(`${base}.html`)).toBe(true);
    expect(existsSync(`${base}.png`)).toBe(false);
  });

  const fakeApp = () => createApp({ dataDir: mkdtempSync(join(tmpdir(), "forge-cap-")), port: 0 });
  const repo = { id: 1, ownerName: "alice", name: "karts" } as never;
  const OID = "a".repeat(40);

  test("a capture starts the build when it is not running, waits for it, keeps the page and its picture", async () => {
    const app = fakeApp();
    let state = "stopped";
    let starts = 0;
    const build = {
      up: () => ({ state, port: stub.port }),
      start: async () => {
        starts++;
        setTimeout(() => (state = "running"), 30);
        return { ok: true, value: undefined } as const;
      },
    };
    const calls: string[] = [];
    const run = startCapture(app, undefined, repo, OID, "/", { build, picture: picture(calls), pollMs: 5 });
    expect(captureState(app, repo, OID, "/")).toEqual({ state: "capturing" });
    expect((await run).ok).toBe(true);
    expect(starts).toBe(1);
    expect(calls).toEqual([url("/")]);
    expect(captureState(app, repo, OID, "/")).toEqual({ state: "done" });
    expect(readCapture(app.config.dataDir, repo, OID, "/")).toEqual(new TextEncoder().encode("<p>game</p>"));
    // Captured once: a second capture neither starts a build nor fetches.
    expect((await captureCart(app, undefined, repo, OID, "/", { build, picture: picture(calls) })).ok).toBe(true);
    expect(starts).toBe(1);
    app.close();
  });

  test("a build that fails, or never comes up, is a failed capture the state remembers", async () => {
    const app = fakeApp();
    const failed = { up: () => ({ state: "failed" }), start: async () => ({ ok: true, value: undefined }) as const };
    expect(await startCapture(app, undefined, repo, OID, "/", { build: failed, pollMs: 5 })).toEqual({ ok: false, error: "build_failed" });
    expect(captureState(app, repo, OID, "/")).toMatchObject({ state: "failed", error: "build_failed" });
    const slow = { up: () => ({ state: "starting" }), start: async () => ({ ok: true, value: undefined }) as const };
    expect(await captureCart(app, undefined, repo, OID, "/spicy", { build: slow, waitMs: 20, pollMs: 5 })).toEqual({ ok: false, error: "timed_out" });
    const gone = { up: () => ({ state: "running", port: stub.port }), start: async () => ({ ok: true, value: undefined }) as const };
    expect(await captureCart(app, undefined, repo, OID, "/gone", { build: gone, picture: picture([]) })).toEqual({ ok: false, error: "page_missing" });
    // A repository that is no app has no build to capture from.
    expect(await captureCart(app, undefined, repo, OID, "/")).toEqual({ ok: false, error: "not_an_app" });
    app.close();
  });
});
