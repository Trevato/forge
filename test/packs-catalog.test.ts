/**
 * The catalog and the doors to the marked list (#10532): the max-age path, reads that
 * overlap, a repo that turns private, the three ways to mark (page, terminal, MCP) and
 * `fetchPack`, which reads a pack from a forge at its default branch.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { updateRepoSettings } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { tool } from "../src/http/mcp/tools/repo_settings.ts";
import { catalog, refreshCatalog, refreshCatalogQuietly } from "../src/packs/catalog.ts";
import { markedRepos, saveMarkedRepos } from "../src/packs/marked.ts";
import { setPackRepos } from "../src/packs/set.ts";
import { createForgeApp, forgeCommands } from "../src/tui/forge.ts";
import { packReposScreen } from "../src/tui/screens/packrepos.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { fetchPack } from "../scripts/pack.ts";
import { quietLogs } from "./helpers/globals.ts";
import { fixtureText, seedPackRepo } from "./helpers/packs.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let admin: User;
let bob: User;
const names = (): string[] => catalog().packs.map((p) => p.name);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-packs-catalog-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!a.ok || !b.ok) throw new Error("users");
  admin = a.value;
  bob = b.value;
  await seedPackRepo(app, "games", fixtureText("games"), false);
  await seedPackRepo(app, "business", fixtureText("business"), false);
});
afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("refreshCatalog", () => {
  test("within max age it answers from memory and does not read again", async () => {
    saveMarkedRepos(app.db, ["packs/games"], admin.id);
    await refreshCatalog(app);
    expect(names()).toEqual(["games"]);
    saveMarkedRepos(app.db, ["packs/games", "packs/business"], admin.id);
    expect((await refreshCatalog(app, 60_000)).packs.map((p) => p.name)).toEqual(["games"]);
    expect((await refreshCatalog(app, 0)).packs.map((p) => p.name)).toEqual(["business", "games"]);
  });

  test("overlapping reads end on the newest list, and each caller sees what was saved before it asked", async () => {
    saveMarkedRepos(app.db, ["packs/games"], admin.id);
    const first = refreshCatalog(app);
    saveMarkedRepos(app.db, ["packs/business"], admin.id);
    const second = refreshCatalog(app);
    const third = refreshCatalog(app);
    expect((await second).packs.map((p) => p.name)).toEqual(["business"]);
    expect(await third).toBe(await second);
    await first;
    expect(names()).toEqual(["business"]);
  });

  test("a repo that turns private after it was marked leaves the catalog and is named", async () => {
    saveMarkedRepos(app.db, ["packs/games", "packs/business"], admin.id);
    expect((await refreshCatalog(app)).packs).toHaveLength(2);
    const owner = getUserOwner();
    const done = await updateRepoSettings(app, owner, getRepo(app.db, "packs", "games")!, { visibility: "private" });
    expect(done.ok).toBe(true);
    const after = await refreshCatalog(app);
    expect(after.packs.map((p) => p.name)).toEqual(["business"]);
    expect(after.problems.join(" ")).toContain("packs/games: a pack repository must be public");
    await updateRepoSettings(app, owner, getRepo(app.db, "packs", "games")!, { visibility: "public" });
  });

  test("a read that throws is logged and leaves the catalog as it was", async () => {
    await refreshCatalog(app);
    const before = names();
    const broken = Object.create(app, { reposRoot: { get: () => { throw new Error("disk gone"); } } }) as App;
    expect((await refreshCatalogQuietly(broken)).packs.map((p) => p.name)).toEqual(before);
    expect(names()).toEqual(before);
    await expect(refreshCatalog(app)).resolves.toBeDefined();
  });
});

function getUserOwner(): User {
  return { ...admin, isAdmin: true };
}

describe("the doors that mark", () => {
  test("setPackRepos is an admin's, and shows in the catalog at once", async () => {
    expect((await setPackRepos(app, bob, "packs/games")).ok).toBe(false);
    expect((await setPackRepos(app, undefined, "packs/games")).ok).toBe(false);
    const bad = await setPackRepos(app, admin, "not a repo/x/y");
    expect(bad.ok).toBe(false);
    const done = await setPackRepos(app, admin, "packs/games");
    expect(done).toMatchObject({ ok: true, repos: ["packs/games"] });
    expect(names()).toEqual(["games"]);
  });

  test("MCP: an admin sets the list, a stranger is refused, a bad word is invalid", async () => {
    const ctx = { app } as never;
    expect((await tool.run(ctx, bob, { packRepos: ["packs/games"] })).ok).toBe(false);
    expect((await tool.run(ctx, admin, { packRepos: ["a/b/c"] })).ok).toBe(false);
    expect((await tool.run(ctx, admin, { packRepos: "packs/games" as never })).ok).toBe(false);
    const done = await tool.run(ctx, admin, { packRepos: ["packs/business", "packs/ghost"] });
    expect(done.ok).toBe(true);
    expect(JSON.stringify(done)).toContain("packs/ghost: no such repository");
    expect(names()).toEqual(["business"]);
    expect(markedRepos(app.db)).toEqual(["packs/business", "packs/ghost"]);
  });

  describe("the terminal", () => {
    const open = (user: User) =>
      createForgeApp(app, { sshUsername: "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user }, { terminal: headlessTerminal(120, 40), exitHooks: false });

    test("an admin is offered the screen and a non-admin is not", () => {
      const a = open(admin);
      const ids = forgeCommands(a.session)(a.app.ctx).map((c) => c.id);
      a.app.stop?.();
      const n = open(bob);
      const idsN = forgeCommands(n.session)(n.app.ctx).map((c) => c.id);
      n.app.stop?.();
      expect(ids).toContain("pack-repos");
      expect(idsN).not.toContain("pack-repos");
    });

    test("editing the list saves it and /packs shows it at once", async () => {
      const { app: tui, session } = open(admin);
      tui.start();
      tui.ctx.push(packReposScreen(session, tui.ctx));
      await settleApp(tui);
      const key = (k: string, ctrl = false) => tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
      key("e");
      await settleApp(tui);
      for (let i = 0; i < 40; i++) key("backspace");
      for (const ch of "packs/games packs/business") key(ch);
      key("enter");
      await settleApp(tui);
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("Saved");
      expect(markedRepos(app.db)).toEqual(["packs/games", "packs/business"]);
      const page = await (await fetch(`${servers.url}/packs`)).text();
      expect(page).toContain(`href="/packs/games"`);
      expect(page).toContain(`href="/packs/business"`);
      tui.stop?.();
    });
  });
});

describe("fetchPack", () => {
  const pack = fixtureText("games");
  test("a 200 is the parsed pack, read at the repository's default branch", async () => {
    let asked = "";
    const got = await fetchPack("games", "https://forge.example/", (async (url: string) => {
      asked = url;
      return new Response(pack, { status: 200 });
    }) as never);
    expect(typeof got).toBe("object");
    expect(asked).toBe("https://forge.example/packs/games/raw/HEAD/pack.json");
  });
  test("a 404 says there is no such pack", async () => {
    const got = await fetchPack("nope", "https://forge.example", (async () => new Response("", { status: 404 })) as never);
    expect(got).toContain("no pack named nope");
    expect(got).toContain("404");
  });
  test("a pack.json that does not parse is named, not returned", async () => {
    const got = await fetchPack("games", "https://forge.example", (async () => new Response("{not json", { status: 200 })) as never);
    expect(typeof got).toBe("string");
    expect(got).toContain("raw/HEAD/pack.json");
  });
  test("a network failure says which address could not be read", async () => {
    const got = await fetchPack("games", "https://forge.example", (async () => { throw new Error("down"); }) as never);
    expect(got).toBe("could not read https://forge.example/packs/games/raw/HEAD/pack.json");
  });
  test("this forge answers HEAD with the pack.json of the repository's default branch", async () => {
    const got = await fetchPack("games", servers.url);
    expect(got).toMatchObject({ name: "games" });
  });
});
