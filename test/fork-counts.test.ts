/**
 * A fork count never includes a private fork (#751). Every place a count
 * or a list of forks appears — the repository's Forks tab, the forks page
 * and its family tree, the API, explore and the front page's signals —
 * counts only forks the viewer may read. The private fork's owner still
 * sees it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitToBranch,
  createRepo,
  forkRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { frontSignals } from "../src/core/front.ts";
import { lineageOf } from "../src/core/following.ts";
import { canRead, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("fork counts hold only the forks the viewer may read", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let lib: Repo;
  let bob: User;
  let carol: User;
  const cookies: Record<string, string> = {};

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-fork-counts-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const users: Record<string, User> = {};
    for (const [name, first] of [
      ["alice", true],
      ["bob", false],
      ["carol", false],
    ] as const) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: name,
        email: `${name}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!made.ok) throw new Error(made.error);
      users[name] = made.value;
    }
    bob = users["bob"]!;
    carol = users["carol"]!;
    promote(app.db, bob, carol);
    const made = await createRepo(app, users["alice"]!, {
      name: "lib",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    lib = made.value;
    const seeded = await commitToBranch(app, users["alice"]!, lib, {
      message: "Start",
      files: [{ path: "README.md", content: "# lib\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    // Bob's fork is private, and the only fork there is.
    const forked = await forkRepo(app, bob, lib);
    if (!forked.ok) throw new Error(String(forked.error));
    const closed = await updateRepoSettings(app, bob, forked.value, {
      visibility: "private",
    });
    if (!closed.ok) throw new Error(String(closed.error));
    for (const name of ["bob", "carol"]) {
      const res = await fetch(`${base}/signin`, {
        method: "POST",
        body: new URLSearchParams({
          username: name,
          password: "a-good-passphrase",
        }),
        redirect: "manual",
      });
      cookies[name] =
        `${(res.headers.get("set-cookie") ?? "").split(";")[0]}; forge_mode=dev`;
    }
    cookies[""] = "forge_mode=dev";
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const page = (path: string, who: string) =>
    fetch(`${base}${path}`, { headers: { cookie: cookies[who]! } }).then((r) =>
      r.text(),
    );

  test("an anonymous visitor and a stranger see no fork; its owner sees one", async () => {
    for (const who of ["", "carol"]) {
      const home = await page("/alice/lib", who);
      expect(home).not.toContain('href="/alice/lib/forks"');
      const forks = await page("/alice/lib/forks", who);
      expect(forks).toContain("0 forks");
      expect(forks).not.toContain("bob/lib");
      const api = await fetch(`${base}/api/v1/repos/alice/lib/forks`, {
        headers: { cookie: cookies[who]! },
      });
      expect(await api.json()).toEqual({ parent: null, items: [], next_cursor: null });
    }
    const owners = await page("/alice/lib/forks", "bob");
    expect(owners).toContain("1 fork");
    expect(owners).toContain("bob/lib");
    expect(await page("/alice/lib", "bob")).toContain(
      'href="/alice/lib/forks"',
    );
  });

  test("the family tree neither shows a private fork nor hints one is cut off", async () => {
    for (const viewer of [undefined, carol]) {
      const tree = await lineageOf(app, lib, (r) => canRead(app.db, r, viewer));
      expect(tree.size).toBe(1);
      expect(tree.truncated).toBe(false);
    }
    const bobs = await lineageOf(app, lib, (r) => canRead(app.db, r, bob));
    expect(bobs.size).toBe(2);
  });

  test("explore and the front page count public forks only", () => {
    const signals = frontSignals(app.db, [lib.id]);
    expect(signals.get(lib.id)?.forks ?? 0).toBe(0);
  });

  test("past the family tree's depth bound, a private fork is not hinted at either", async () => {
    // A chain of public forks as deep as the tree goes, then a private one.
    const alice = (await import("../src/core/users.ts")).getUserByName(app.db, "alice")!;
    let parent = lib;
    for (let depth = 1; depth <= 6; depth++) {
      const next = await forkRepo(app, alice, parent, `deep${depth}`);
      if (!next.ok) throw new Error(String(next.error));
      parent = next.value;
    }
    const hidden = await forkRepo(app, bob, parent, "deep-private");
    if (!hidden.ok) throw new Error(String(hidden.error));
    const closed = await updateRepoSettings(app, bob, hidden.value, {
      visibility: "private",
    });
    expect(closed.ok).toBe(true);
    const tree = await lineageOf(app, lib, (r) => canRead(app.db, r, carol));
    expect(tree.truncated).toBe(false);
    const bobs = await lineageOf(app, lib, (r) => canRead(app.db, r, bob));
    expect(bobs.truncated).toBe(true);
  });
});
