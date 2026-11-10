/**
 * A display over many builds reads git once per repository, not once per
 * build per request (#10445): a warm `/:owner/:name/display` and a warm
 * `/displays` spawn no git, for a reader and for a writer. Counted, never
 * timed.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
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

const REPOS = 10;
const PINS = 3;

/** The calls in a spawn spy that ran git, whatever the argv shape. */
function gitCalls(calls: unknown[][]): number {
  return calls.filter((c) => {
    const first = c[0];
    const argv = Array.isArray(first) ? first : (first as { cmd?: unknown } | undefined)?.cmd;
    return Array.isArray(argv) && /(^|\/)git$/.test(String(argv[0]));
  }).length;
}

describe("a warm display reads no git", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;

  const get = (path: string, u: User) =>
    fetch(`${servers.url}${path}`, { headers: { cookie: `forge_session=${createSession(app.db, u.id).token}` }, redirect: "manual" });
  const commit = async (name: string, path: string, content: string) => {
    const made = await commitToBranch(app, alice, getRepo(app.db, "alice", name)!, { message: path, files: [{ path, content }] });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    return made.value.commitOid;
  };
  /** Git spawned by one warm request for `path`. */
  const warm = async (path: string, u: User) => {
    const first = await get(path, u);
    expect(first.status).toBe(200);
    await first.text();
    const spawn = spyOn(Bun, "spawn");
    const spawnSync = spyOn(Bun, "spawnSync");
    try {
      const res = await get(path, u);
      const page = await res.text();
      expect(res.status).toBe(200);
      return { page, git: gitCalls(spawn.mock.calls) + gitCalls(spawnSync.mock.calls) };
    } finally {
      spawn.mockRestore();
      spawnSync.mockRestore();
    }
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-display-warm-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const name of ["alice", "bob"]) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username: name, email: `${name}@forge.local`, password: "a-good-passphrase", adminIfFirst: true });
      if (!made.ok) throw new Error(made.error);
      if (name === "alice") alice = made.value;
      else bob = made.value;
    }
    proveAll(app);
    for (let r = 0; r < REPOS; r++) {
      const name = `game${r}`;
      const made = await createRepo(app, alice, { name, visibility: "public" });
      if (!made.ok) throw new Error(String(made.error));
      // No pages and no launch on the demo: each build's facts come from git (`demoFactsAt`).
      const oid = await commit(name, "a.txt", String(r));
      for (let p = 0; p < PINS; p++) {
        const pinned = await pinBuild(repoDir(app.reposRoot, "alice", name), {
          label: `v${p}`,
          oid,
          note: "",
          source: "commit",
          tagger: { name: "alice", email: "alice@forge.local" },
          at: 1_800_000_000 + p,
          demo: { name: `${name}-v${p}`, version: `${p}.0`, page: "/", showcase: true },
        });
        if (!pinned.ok) throw new Error(pinned.error);
      }
    }
    await createRepo(app, alice, { name: "shelf", visibility: "public" });
    await commit("shelf", "display.json", JSON.stringify({ title: "Game night", layout: "grid", sources: ["alice"] }));
  }, 120_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a reader's display page", async () => {
    const { page, git } = await warm("/alice/shelf/display", bob);
    expect(page).toContain(`${REPOS * PINS} builds`);
    expect(git).toBe(0);
  });

  test("a writer's display page, with its chooser", async () => {
    const { page, git } = await warm("/alice/shelf/display", alice);
    expect(page).toContain("Choose builds");
    // The form's tip is read fresh: it guards the save against a moved branch.
    expect(git).toBeLessThanOrEqual(1);
  });

  test("/displays", async () => {
    const { page, git } = await warm("/displays", bob);
    expect(page).toContain("Game night");
    expect(git).toBe(0);
  });

  test("a new pin shows at once", async () => {
    const dir = repoDir(app.reposRoot, "alice", "game0");
    const oid = (await commit("game0", "b.txt", "b"));
    const pinned = await pinBuild(dir, {
      label: "v9", oid, note: "", source: "commit",
      tagger: { name: "alice", email: "alice@forge.local" },
      demo: { name: "game0-v9", version: "9.0", page: "/", showcase: true },
    });
    expect(pinned.ok).toBe(true);
    const page = await (await get("/alice/shelf/display", bob)).text();
    expect(page).toContain("game0-v9");
  });
});
