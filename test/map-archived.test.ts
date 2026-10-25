/**
 * Archive puts a repository away (#1838): the forge-wide map leaves its
 * lane out, waking it brings the lane back, and its own page still answers.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { moveArchived, type Repo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("the forge-wide map and archived repositories", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie: string;
  let keep: Repo;
  let shelve: Repo;

  const page = async (path: string): Promise<Response> =>
    fetch(`${base}${path}`, { headers: { cookie } });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-map-archived-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = `http://127.0.0.1:${servers.port}`;
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    const alice = made.value;
    const a = await createRepo(app, alice, { name: "keep", visibility: "private" });
    const b = await createRepo(app, alice, { name: "shelve", visibility: "private" });
    if (!a.ok || !b.ok) throw new Error("repo");
    keep = a.value;
    shelve = b.value;
    for (const r of [keep, shelve]) await openIssue(app, alice, r, { title: "Something to draw" });
    const res = await fetch(`${base}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
      redirect: "manual",
    });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an archived repository leaves /map, and waking it brings it back", async () => {
    const lane = (html: string, name: string) => html.includes(`id="lane-alice-${name}"`);
    let html = await (await page("/map")).text();
    expect(lane(html, "keep")).toBe(true);
    expect(lane(html, "shelve")).toBe(true);

    expect(moveArchived(app.db, shelve.id, true)).toBe(true);
    html = await (await page("/map")).text();
    expect(lane(html, "keep")).toBe(true);
    expect(lane(html, "shelve")).toBe(false);
    // Archived, not gone: its own page still answers.
    expect((await page("/alice/shelve")).status).toBe(200);

    expect(moveArchived(app.db, shelve.id, false)).toBe(true);
    html = await (await page("/map")).text();
    expect(lane(html, "shelve")).toBe(true);
    expect(keep.name).toBe("keep");
  });
});
