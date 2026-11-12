/** `/:owner/:name/display`: a repository's display, read only. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { pinBuild } from "../src/git/builds.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";

describe("the display page", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;

  const get = (path: string, u?: User) =>
    fetch(`${servers.url}${path}`, {
      headers: u === undefined ? {} : { cookie: `forge_session=${createSession(app.db, u.id).token}` },
      redirect: "manual",
    });
  const commit = async (name: string, path: string, content: string) => {
    const made = await commitToBranch(app, alice, getRepo(app.db, "alice", name)!, { message: path, files: [{ path, content }] });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    return made.value.commitOid;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-display-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const name of ["alice", "bob"]) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username: name, email: `${name}@forge.local`, password: "a-good-passphrase", adminIfFirst: true });
      if (!made.ok) throw new Error(made.error);
      if (name === "alice") alice = made.value;
      else bob = made.value;
    }
    proveAll(app);
    for (const [name, visibility] of [["karts", "public"], ["vault", "private"], ["plain", "public"]] as const) {
      const made = await createRepo(app, alice, { name, visibility });
      if (!made.ok) throw new Error(String(made.error));
    }
    const oid = await commit("karts", "a.txt", "a");
    const pinned = await pinBuild(repoDir(app.reposRoot, "alice", "karts"), {
      label: "fiesta",
      oid,
      note: "",
      source: "commit",
      tagger: { name: "alice", email: "alice@forge.local" },
      at: 1_800_000_000,
      demo: { name: "krazy-karts", version: "1.0", page: "/", showcase: true, launch: "shots" },
    });
    if (!pinned.ok) throw new Error(pinned.error);
    await commit("karts", "display.json", JSON.stringify({ title: "Kart night", layout: "grid", sources: ["alice/karts"], builds: ["alice/karts:fiesta"] }));
    await commit("vault", "display.json", JSON.stringify({ title: "Vault night", layout: "shelf", sources: ["alice/vault"] }));
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("shows the title and the pinned build, server-rendered, with the security headers", async () => {
    const res = await get("/alice/karts/display", bob);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBeTruthy();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBeTruthy();
    const page = await res.text();
    expect(page).toContain("Kart night");
    expect(page).toContain("krazy-karts");
    expect(page).toContain('href="/alice/karts/builds/fiesta/shots"');
  });

  test("a repository without display.json is a 404", async () => {
    expect((await get("/alice/plain/display", alice)).status).toBe(404);
    expect((await get("/alice/nope/display", alice)).status).toBe(404);
  });

  test("an unreadable repository is a 404, a readable one is not", async () => {
    expect((await get("/alice/vault/display", bob)).status).toBe(404);
    expect((await get("/alice/vault/display")).status).toBe(404);
    expect((await get("/alice/vault/display", alice)).status).toBe(200);
  });

  test("/displays links each entry to its display page", async () => {
    const list = await (await get("/displays", alice)).text();
    expect(list).toContain('href="/alice/karts/display"');
    expect(list).toContain('href="/alice/vault/display"');
  });
});
