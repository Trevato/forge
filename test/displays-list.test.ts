/**
 * `/displays` and its terminal screen: both list the displays the viewer may
 * read through `listedDisplays` — title, layout, repository, showcased demo
 * count — hide what the viewer cannot read, name a broken display.json as
 * invalid, say what a display is when there are none, and send a stranger to
 * sign in. Making a display is not tested here: it is not in this pull.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { pinBuild, type Demo } from "../src/git/builds.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { entry as displaysEntry, displaysScreen } from "../src/tui/screens/displays.ts";
import { ENTRIES } from "../src/tui/screens/entries.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { statements } from "./helpers/statements.ts";
import { proveAll } from "./helpers/verified.ts";

const DOMAIN = "apps.test";
const T0 = 1_800_000_000;
const demo = (name: string, version: string, showcase: boolean): Demo => ({ name, version, page: "/", showcase, launch: "shots" });

describe("the displays list, page and terminal screen", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let bob: User;
  let tick = 0;

  const cookie = (u: User) => `forge_session=${createSession(app.db, u.id).token}`;
  const get = (path: string, u?: User, extra: Record<string, string> = {}) =>
    fetch(`${servers.url}${path}`, { headers: { ...(u === undefined ? {} : { cookie: cookie(u) }), ...extra }, redirect: "manual" });
  const text = async (path: string, u?: User) => {
    const r = await get(path, u);
    expect(r.status, path).toBe(200);
    return r.text();
  };
  const repo = (name: string): Repo => getRepo(app.db, "alice", name)!;
  const writeDisplay = async (name: string, config: unknown) => {
    const made = await commitToBranch(app, alice, repo(name), {
      message: "display",
      files: [{ path: "display.json", content: typeof config === "string" ? config : JSON.stringify(config) }],
    });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
  };
  const pin = async (name: string, label: string, d?: Demo, parent?: string) => {
    const made = await commitToBranch(app, alice, repo(name), { message: label, files: [{ path: `${label}.txt`, content: label }] });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    const pinned = await pinBuild(repoDir(app.reposRoot, "alice", name), {
      label,
      oid: made.value.commitOid,
      note: "",
      source: "commit",
      tagger: { name: "alice", email: "alice@forge.local" },
      at: T0 + tick++ * 60,
      ...(d === undefined ? {} : { demo: d }),
      ...(parent === undefined ? {} : { parent }),
    });
    if (!pinned.ok) throw new Error(pinned.error);
  };
  /** The displays a page lists, by repository, with their demo counts. */
  const listed = (page: string) =>
    Object.fromEntries([...page.matchAll(/<tr data-display="([^"]+)">[\s\S]*?<td data-demos>([^<]*)<\/td>/g)].map((m) => [m[1]!, m[2]!]));
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-displays-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, { domain: DOMAIN, scheme: "http", publicPort: servers.port, forgeUrl: servers.url });
    await runtime.start();
    for (const name of ["alice", "bob"]) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username: name, email: `${name}@forge.local`, password: "a-good-passphrase", adminIfFirst: true });
      if (!made.ok) throw new Error(made.error);
      if (name === "alice") alice = made.value;
      else bob = made.value;
    }
    proveAll(app);
    for (const [name, visibility] of [
      ["karts", "public"],
      ["secret", "private"],
      ["arcade", "public"],
      ["shelf", "public"],
      ["hidden", "private"],
      ["broken", "public"],
      ["fresh", "public"],
      ["nova-vanilla", "public"],
      ["plainfam", "public"],
    ] as const) {
      const made = await createRepo(app, alice, { name, visibility });
      if (!made.ok) throw new Error(String(made.error));
    }
    // karts: two showcased demos and a draft; secret: one showcased, private.
    await pin("karts", "fiesta", demo("krazy-karts", "1.0", true));
    await pin("karts", "london", demo("krazy-karts", "2.0", true));
    await pin("karts", "draft", demo("krazy-karts", "3.0", false));
    await pin("secret", "hush", demo("secret-game", "0.1", true));
    await writeDisplay("arcade", { title: "Arcade night", layout: "grid", sources: ["alice/karts", "alice/secret"] });
    await writeDisplay("shelf", { title: "Shelf night", layout: "shelf", sources: ["alice/karts"] });
    await writeDisplay("hidden", { title: "Hidden night", layout: "graph", sources: ["alice/karts"] });
    await writeDisplay("broken", "{ nope");

    // A repository with pins and no display.json is no display.
    await pin("nova-vanilla", "v1");
    await pin("nova-vanilla", "v2", demo("nova", "1", true));
    // plainfam: pins and a demo, none showcased.
    await pin("plainfam", "p1", demo("plain", "1", false));
  }, 60_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  describe("/displays", () => {
    test("lists only the displays the viewer reads, each with its showcased demos counted", async () => {
      const mine = await text("/displays", alice);
      expect(listed(mine)).toEqual({ "alice/arcade": "3", "alice/shelf": "2", "alice/hidden": "2", "alice/broken": "None" });
      expect(mine).toContain('href="/alice/arcade"');
      expect(mine).toContain("Arcade night");
      expect(mine).toContain("display.json is invalid");
      // A private source's showcased demo is published: it counts for another reader too.
      expect(listed(await text("/displays", bob))).toEqual({ "alice/arcade": "3", "alice/shelf": "2", "alice/broken": "None" });
      // Iterations are no display.json display.
      expect(mine).not.toContain('data-display="alice/nova');
    });

    test("a pin that joins the showcase, or a display that changes, is counted again", async () => {
      await pin("karts", "rome", demo("krazy-karts", "5.0", true));
      expect(listed(await text("/displays", alice))["alice/shelf"]).toBe("3");
    });

    test("its statements do not grow with its rows", async () => {
      const cost = () => statements(app.db, async () => void (await get("/displays", alice)).arrayBuffer());
      await get("/displays", alice);
      const few = await cost();
      for (const name of ["more1", "more2", "more3"]) {
        const made = await createRepo(app, alice, { name, visibility: "public" });
        if (!made.ok) throw new Error(String(made.error));
        await writeDisplay(name, { title: name, layout: "grid", sources: ["alice/karts"] });
      }
      await get("/displays", alice);
      expect(Object.keys(listed(await text("/displays", alice)))).toContain("alice/more3");
      expect(await cost()).toBe(few);
    });

    test("the empty page says what a display is and where one comes from", async () => {
      const dir = await mkdtemp(join(tmpdir(), "forge-displays-empty-"));
      const bare = createApp({ dataDir: dir, port: 0 });
      const bareServers = await serve(bare);
      try {
        const made = await createUser(bare.db, { origin: "seed", trusted: true, username: "carol", email: "carol@forge.local", password: "a-good-passphrase", adminIfFirst: true });
        if (!made.ok) throw new Error(made.error);
        const r = await fetch(`${bareServers.url}/displays`, { headers: { cookie: `forge_session=${createSession(bare.db, made.value.id).token}` } });
        const page = await r.text();
        expect(page).toContain("No displays");
        expect(page).toContain("A display shows a repository&#39;s showcased demos.");
        expect(page).toContain("Add a display.json to a repository&#39;s default branch");
      } finally {
        bareServers.stop();
        bare.close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    test("the terminal screen lists the same rows as the page, and is in the palette", async () => {
      const screenText = async (u: User) => {
        const { app: tui, session } = createForgeApp(
          app,
          { sshUsername: u.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: u },
          { terminal: headlessTerminal(200, 40), exitHooks: false },
        );
        tui.start();
        tui.ctx.push(displaysScreen(session, tui.ctx));
        await settleApp(tui);
        const out = tui.screen.toText();
        tui.stop?.();
        return out;
      };
      const mine = await screenText(alice);
      for (const name of Object.keys(listed(await text("/displays", alice)))) expect(mine).toContain(name);
      expect(mine).toContain("Arcade night");
      expect(mine).toContain("display.json is invalid");
      expect(mine).toContain("alice/hidden");
      expect(await screenText(bob)).not.toContain("alice/hidden");
      expect(ENTRIES).toContain(displaysEntry);
    });

    test("a stranger is sent to sign in", async () => {
      const r = await get("/displays");
      expect(r.status).toBe(303);
      expect(r.headers.get("location")).toContain("/signin");
    });

    test("carries the security floor", async () => {
      const r = await get("/displays", alice);
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("content-security-policy")).not.toBeNull();
      expect(r.headers.get("referrer-policy")).not.toBeNull();
    });

    test("names its Server-Timing phases", async () => {
      const r = await get("/displays", alice);
      const names = (r.headers.get("server-timing") ?? "").split(",").map((p) => p.trim().split(";")[0]);
      expect(names).toEqual(expect.arrayContaining(["session", "displays", "render"]));
    });
  });
});
