/**
 * The optional picture of a page that rides with a note from the forge
 * button (#4820): only when sent, only PNG or JPEG under 2 MB judged by its
 * bytes, kept under the data directory, and read only by who reads the issue.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { toolbarJs } from "../src/apps/toolbar.ts";
import { PICTURE_MAX, savePicture } from "../src/core/note_pictures.ts";
import { createIssue } from "../src/core/issues.ts";
import { insertNote } from "../src/core/app_notes.ts";
import { moderateNote } from "../src/actions/app_notes.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { getRepo, getRepoById } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";

describe("a note may carry a picture of the page", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-app-feedback-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    await runtime.start();
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    for (const [name, visibility] of [
      ["notes", "public"],
      ["diary", "private"],
    ] as const) {
      const made = await newApp(app, a.value, { name, description: "Words", visibility });
      if (!made.ok) throw new Error(String(made.error));
    }
  }, 120_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const host = (slug: string) => `${slug}.${DOMAIN}:${servers.port}`;
  const at = (slug: string, path: string, init: RequestInit = {}, cookie = "", source = "") =>
    fetch(`${servers.url}${path}`, {
      ...init,
      headers: {
        host: host(slug),
        ...(init.method === "POST" ? { origin: `http://${host(slug)}`, "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
        ...(source ? { "x-forwarded-for": source } : {}),
        ...(init.headers as Record<string, string>),
      },
      redirect: "manual",
    });
  const post = (text: string, cookie = "", source = "", slug = "notes") =>
    at(slug, "/__forge/note", { method: "POST", body: JSON.stringify({ text, page: `http://${host(slug)}/lists?x=1`, viewport: "390x844" }) }, cookie, source);
  const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  const note = async (source: string) => {
    const res = await post("The header looks wrong", "", source);
    const j = (await res.json()) as { note: { id: string; url: string } };
    return { cookie: cookieOf(res), id: j.note.id, number: Number(j.note.url.split("/").pop()) };
  };
  const upload = (id: string, bytes: Uint8Array, cookie: string, type = "image/png") =>
    at("notes", `/__forge/note/picture?note=${id}`, { method: "POST", body: bytes, headers: { "content-type": type } }, cookie);
  const issuePicture = (number: number) =>
    fetch(`${servers.url}/alice/notes/issues/${number}/picture`, { redirect: "manual" });

  test("the panel's box starts unticked and a picture is taken only when it is ticked", () => {
    expect(toolbarJs).toContain("Include a picture of this page");
    expect(toolbarJs).toContain("tellPic.checked = false");
    expect(toolbarJs).toContain("wantPicture ? shoot() : Promise.resolve(null)");
    expect(toolbarJs).toContain("/__forge/note/picture");
  });

  test("an unticked note sends no image: none is stored or shown", async () => {
    const n = await note("10.9.0.1");
    expect(app.db.query("SELECT 1 FROM app_note_picture WHERE note_id = ?1").get(n.id)).toBeNull();
    expect((await issuePicture(n.number)).status).toBe(404);
  });

  test("a PNG and a JPEG are kept under the data directory and shown on the issue", async () => {
    for (const [source, bytes, type, ext] of [["10.9.0.2", PNG, "image/png", "png"], ["10.9.0.3", JPG, "image/jpeg", "jpeg"]] as const) {
      const n = await note(source);
      const up = await upload(n.id, bytes, n.cookie, type);
      expect(up.status).toBe(201);
      expect(existsSync(join(dataDir, "note-pictures", `${n.id}.${ext}`))).toBe(true);
      const shown = await issuePicture(n.number);
      expect(shown.status).toBe(200);
      expect(shown.headers.get("content-type")).toBe(type);
      expect(shown.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await shown.arrayBuffer())).toEqual(bytes);
      // one picture per note
      expect((await upload(n.id, bytes, n.cookie, type)).status).toBe(409);
    }
    const n = await note("10.9.0.4");
    await upload(n.id, PNG, n.cookie);
    const page = await (await fetch(`${servers.url}/alice/notes/issues/${n.number}`)).text();
    expect(page).toContain(`/alice/notes/issues/${n.number}/picture`);
  });

  test("an oversized upload is refused, and so is one that is not a PNG or JPEG whatever it is called", async () => {
    const n = await note("10.9.0.5");
    const big = new Uint8Array(PICTURE_MAX + 1);
    big.set(PNG);
    expect((await upload(n.id, big, n.cookie)).status).toBe(413);
    const text = new TextEncoder().encode("<svg onload=alert(1)></svg>");
    expect((await upload(n.id, text, n.cookie, "image/png")).status).toBe(415);
    expect((await upload(n.id, new TextEncoder().encode("GIF89a....."), n.cookie, "image/jpeg")).status).toBe(415);
    expect((await issuePicture(n.number)).status).toBe(404);
    // exactly the cap is fine
    const edge = new Uint8Array(PICTURE_MAX);
    edge.set(PNG);
    expect((await upload(n.id, edge, n.cookie)).status).toBe(201);
  });

  test("only the sender adds a picture, from this origin", async () => {
    const n = await note("10.9.0.6");
    const other = await note("10.9.0.7");
    expect((await upload(n.id, PNG, other.cookie)).status).toBe(404);
    expect((await upload(n.id, PNG, "")).status).toBe(404);
    expect((await upload("nope", PNG, n.cookie)).status).toBe(404);
    const cross = await fetch(`${servers.url}/__forge/note/picture?note=${n.id}`, {
      method: "POST", body: PNG, headers: { host: host("notes"), origin: "http://evil.test", cookie: n.cookie },
    });
    expect(cross.status).toBe(403);
    expect((await issuePicture(n.number)).status).toBe(404);
  });

  test("the picture is not readable by someone who cannot read the issue", async () => {
    const n = await note("10.9.0.8");
    await upload(n.id, PNG, n.cookie);
    expect((await issuePicture(n.number)).status).toBe(200);
    app.db.query("UPDATE issue SET sealed = 1 WHERE number = ?1").run(n.number);
    expect((await issuePicture(n.number)).status).toBe(404);
    expect((await fetch(`${servers.url}/alice/notes/issues/${n.number}`)).status).toBe(404);
  });

  test("hiding a note takes its picture down: 404, no row, no file; banning does too", async () => {
    for (const how of ["hide", "ban"] as const) {
      const n = await note(how === "hide" ? "10.9.0.9" : "10.9.0.10");
      await upload(n.id, PNG, n.cookie);
      expect((await issuePicture(n.number)).status).toBe(200);
      const repo = app.db.query<{ id: string }, [string]>("SELECT repo_id AS id FROM app_note WHERE id = ?1").get(n.id)!;
      expect(repo).not.toBeNull();
      const owner = getUserByName(app.db, "alice")!;
      const found = getRepoById(app.db, repo.id)!;
      const done = await moderateNote(app, getAppByRepo(app.db, found.id)!, found, owner, n.id, how);
      expect(done.ok).toBe(true);
      expect((await issuePicture(n.number)).status).toBe(404);
      expect(app.db.query("SELECT 1 FROM app_note_picture WHERE note_id = ?1").get(n.id)).toBeNull();
      expect(existsSync(join(dataDir, "note-pictures", `${n.id}.png`))).toBe(false);
    }
  });

  test("a signed-in non-member gets 404 on a private app's picture", async () => {
    const owner = getUserByName(app.db, "alice")!;
    const repo = getRepo(app.db, "alice", "diary")!;
    const issue = createIssue(app.db, { repoId: repo.id, authorId: owner.id, title: "From the app: The diary header" });
    if (!issue.ok) throw new Error(issue.error);
    const number = issue.value.number;
    const kept = insertNote(app.db, { appId: getAppByRepo(app.db, repo.id)!.id, repoId: repo.id, issueNumber: number, visitor: "u:alice", name: "alice" });
    expect(savePicture(app.db, dataDir, kept, "png", PNG)).toBe(true);
    const alice = `forge_session=${createSession(app.db, owner.id).token}`;
    expect((await fetch(`${servers.url}/alice/diary/issues/${number}/picture`, { headers: { cookie: alice }, redirect: "manual" })).status).toBe(200);
    const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
    if (!b.ok) throw new Error(b.error);
    const session = createSession(app.db, b.value.id);
    const reader = await fetch(`${servers.url}/alice/diary/issues/${number}/picture`, { headers: { cookie: `forge_session=${session.token}` }, redirect: "manual" });
    expect(reader.status).toBe(404);
  });
});
