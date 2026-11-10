/**
 * What a display keeps in memory is dropped when it should be (#10445): a
 * repository's pin listing after `PINS_FRESH_MS`, and on every push, merge,
 * repository or build event through the bus; a commit's demo facts are kept
 * by oid, and facts borrowed from the branch tip are read again after
 * `PINS_FRESH_MS`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { demoFactsAt } from "../src/actions/pin_demos.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { keptPins, PINS_FRESH_MS } from "../src/git/pins_kept.ts";
import { closeReadersUnder } from "../src/git/read.ts";
import { repoDir } from "../src/git/repos.ts";

let dataDir: string;
let app: App;
let alice: User;
let clock: ReturnType<typeof spyOn> | undefined;

/** Date.now moved `ms` ahead of the real clock until the test ends. */
function later(ms: number): void {
  const real = Date.now.bind(Date);
  clock?.mockRestore();
  clock = spyOn(Date, "now").mockImplementation(() => real() + ms);
}

afterEach(() => {
  clock?.mockRestore();
  clock = undefined;
});

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-display-cache-"));
  app = createApp({ dataDir, port: 0 });
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** A listing read through `keptPins` that counts its reads. */
function counted(dir: string) {
  let reads = 0;
  const list = () => keptPins(dir, async () => ++reads);
  return { list, reads: () => reads };
}

describe("a kept pin listing", () => {
  test("is answered for PINS_FRESH_MS, then read again", async () => {
    const pins = counted(join(dataDir, "ttl"));
    expect(await pins.list()).toBe(1);
    expect(await pins.list()).toBe(1);
    later(PINS_FRESH_MS - 1_000);
    expect(await pins.list()).toBe(1);
    later(PINS_FRESH_MS + 1_000);
    expect(await pins.list()).toBe(2);
  });

  for (const kind of ["push", "pull.merged", "repo.created", "build.pinned"]) {
    test(`is dropped by a ${kind} event on the bus`, async () => {
      const pins = counted(join(dataDir, `event-${kind}`));
      expect(await pins.list()).toBe(1);
      expect(await pins.list()).toBe(1);
      app.bus.append({ kind, payload: {} });
      expect(await pins.list()).toBe(2);
    });
  }

  test("is kept through an event that moves no pins", async () => {
    const pins = counted(join(dataDir, "event-other"));
    expect(await pins.list()).toBe(1);
    app.bus.append({ kind: "issue.opened", payload: {} });
    expect(await pins.list()).toBe(1);
  });
});

describe("a commit's demo facts", () => {
  const manifest = (pages: string[]) =>
    JSON.stringify({ app: { run: "bun run index.ts", pages } });
  let repo: Repo;
  let dir: string;
  const commit = async (path: string, content: string) => {
    const made = await commitToBranch(app, alice, repo, { message: path, files: [{ path, content }] });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    return made.value.commitOid;
  };
  /** `run` with the repository out of reach: whatever it answers was kept. */
  const unreachable = async <T>(run: () => Promise<T>): Promise<T> => {
    const away = `${dir}.away`;
    closeReadersUnder(dir);
    await rename(dir, away);
    try {
      return await run();
    } finally {
      await rename(away, dir);
      closeReadersUnder(dir);
    }
  };

  beforeAll(async () => {
    const made = await createRepo(app, alice, { name: "game", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    dir = repoDir(app.reposRoot, "alice", "game");
  });

  test("are kept by oid: a commit with pages is not read again", async () => {
    const oid = await commit("forge.json", manifest(["/own"]));
    expect((await demoFactsAt(app, repo, oid)).pages).toEqual(["/own"]);
    later(PINS_FRESH_MS + 1_000);
    expect((await unreachable(() => demoFactsAt(app, repo, oid))).pages).toEqual(["/own"]);
  });

  test("borrowed from the tip are kept a while, then read again", async () => {
    const old = await commit("forge.json", manifest([]));
    await commit("forge.json", manifest(["/first"]));
    expect((await demoFactsAt(app, repo, old)).pages).toEqual(["/first"]);
    await commit("forge.json", manifest(["/second"]));
    // Within PINS_FRESH_MS the kept answer stands, git or no git.
    expect((await unreachable(() => demoFactsAt(app, repo, old))).pages).toEqual(["/first"]);
    later(PINS_FRESH_MS + 1_000);
    expect((await demoFactsAt(app, repo, old)).pages).toEqual(["/second"]);
  });
});
