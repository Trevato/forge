/** Packs: the definition is checked, the shipped two are sound, the deploy keeps its order, and the pages answer. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { catalog, refreshCatalog } from "../src/packs/catalog.ts";
import { getUserByName } from "../src/core/users.ts";
import { markedRepos, parseMarked, saveMarkedRepos, updateMarkedRepos } from "../src/packs/marked.ts";
import { fixtureText, seedPackRepo, seedPacks } from "./helpers/packs.ts";
import { deployPack, type Hands } from "../src/packs/deploy.ts";
import { parsePack, sourceOf } from "../src/packs/pack.ts";

const good = {
  pack: 1,
  name: "mini",
  title: "Mini",
  version: "1.0.0",
  description: "One app.",
  apps: [{ name: "one", description: "An app.", source: "https://github.com/a/b" }],
  crew: [{ username: "helper", roles: ["builder"], brief: "Help." }],
};
const parse = (o: unknown) => parsePack(JSON.stringify(o));

describe("pack definition", () => {
  test("a good pack parses", () => {
    const r = parse(good);
    expect(r.ok).toBe(true);
  });
  test("a pack brings no data, secrets or variables, at any depth", () => {
    for (const extra of [{ secrets: {} }, { env: {} }, { apps: [{ ...good.apps[0], variables: [] }] }, { crew: [{ ...good.crew[0], token: "x" }] }]) {
      const r = parse({ ...good, ...extra });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("not allowed");
    }
  });
  test("sources are public https repositories without credentials", () => {
    expect(sourceOf("https://github.com/a/b.git")).toBe("https://github.com/a/b");
    expect(sourceOf("trevato/forge")).toBe("trevato/forge");
    expect(parse({ ...good, apps: [{ name: "one", description: "d", source: "trevato/forge" }] }).ok).toBe(true);
    for (const bad of ["a/b/c", "/a", "a/", "../x", "http://github.com/a/b", "https://u:p@github.com/a/b", "git@github.com:a/b", "https://github.com/a", "https://github.com/a/b?x=1", "file:///etc"])
      expect(sourceOf(bad)).toBeUndefined();
  });
  test("each field is checked", () => {
    expect(parse({ ...good, pack: 2 }).ok).toBe(false);
    expect(parse({ ...good, name: "Bad Name" }).ok).toBe(false);
    expect(parse({ ...good, version: "1" }).ok).toBe(false);
    expect(parse({ ...good, apps: [] }).ok).toBe(false);
    expect(parse({ ...good, crew: [{ ...good.crew[0], roles: ["admin"] }] }).ok).toBe(false);
    expect(parsePack("nope").ok).toBe(false);
  });
});

describe("pack absorb", () => {
  const withAbsorb = (absorb: unknown) => parse({ ...good, apps: [{ ...good.apps[0], absorb }] });
  test("absorb is a boolean on an app; anything else is refused", () => {
    const yes = withAbsorb(true);
    expect(yes.ok && yes.value.apps[0]!.absorb).toBe(true);
    const no = withAbsorb(false);
    expect(no.ok && no.value.apps[0]!.absorb).toBeUndefined();
    for (const v of ["yes", 1, {}, null]) expect(withAbsorb(v).ok).toBe(false);
  });
  const hands = (calls: string[], absorbed: { ok: boolean }): Hands => ({
    async forkFrom() {
      return { ok: false, exists: false, why: "unused" };
    },
    async makeApp(name) {
      return name === "kept" ? { ok: false, exists: true, why: "x", owner: "me" } : { ok: true, owner: "me" };
    },
    async defaultBranch() {
      return "main";
    },
    async carryHistory() {
      return { ok: true };
    },
    async follow() {
      return { ok: true };
    },
    async absorb(owner, name) {
      calls.push(`absorb ${owner}/${name}`);
      return absorbed.ok ? { ok: true } : { ok: false, why: "declares no feature" };
    },
    async makeAgent() {
      return { ok: true };
    },
  });
  const apps = [
    { name: "a", description: "d", source: "https://github.com/a/b", absorb: true },
    { name: "plain", description: "d", source: "https://github.com/a/c" },
    { name: "kept", description: "d", source: "https://github.com/a/d", absorb: true },
  ];
  test("deploy absorbs exactly the apps that ask, made or kept", async () => {
    const calls: string[] = [];
    const pack = parse({ ...good, crew: [], apps });
    if (!pack.ok) throw new Error(pack.error);
    const steps = await deployPack(pack.value, hands(calls, { ok: true }));
    expect(calls).toEqual(["absorb me/a", "absorb me/kept"]);
    expect(steps.filter((s) => s.what.startsWith("absorb")).map((s) => s.state)).toEqual(["done", "done"]);
  });
  test("a refused absorb is reported and leaves the app made", async () => {
    const pack = parse({ ...good, crew: [], apps });
    if (!pack.ok) throw new Error(pack.error);
    const steps = await deployPack(pack.value, hands([], { ok: false }));
    expect(steps[0]!.state).toBe("done");
    expect(steps.find((s) => s.what === "absorb a")).toMatchObject({ state: "failed", note: "declares no feature" });
  });
});

describe("the catalog reads marked repos from git", () => {
  let dir: string;
  let app: App;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-packs-cat-"));
    app = createApp({ dataDir: dir, port: 0 });
  });
  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });
  test("nothing is marked, nothing is listed; a marked repo with a pack.json is, an unmarked one is not", async () => {
    expect((await refreshCatalog(app)).packs).toEqual([]);
    await seedPackRepo(app, "games", fixtureText("games"));
    await seedPackRepo(app, "business", fixtureText("business"), false);
    const c = await refreshCatalog(app);
    expect(c.problems).toEqual([]);
    expect(c.packs.map((p) => p.name)).toEqual(["games"]);
    expect(catalog().packs.length).toBe(1);
    expect(c.packs[0]!.apps.length).toBeGreaterThan(0);
  });
  test("a marked repo that is missing, has no pack.json or a bad one is named, not listed", async () => {
    await seedPackRepo(app, "empty", "{}", false);
    await seedPackRepo(app, "wrong", fixtureText("games").replace('"name": "games"', '"name": "other"'), false);
    saveMarkedRepos(app.db, ["packs/games", "packs/gone", "packs/empty", "packs/wrong"], getUserByName(app.db, "packs")!.id);
    const c = await refreshCatalog(app);
    expect(c.packs.map((p) => p.name)).toEqual(["games"]);
    expect(c.problems.map((p) => p.split(":")[0])).toEqual(["packs/gone", "packs/empty", "packs/wrong"]);
  });
  test("the setting accepts owner/name words and only an admin changes it", () => {
    expect(parseMarked("packs/games, Packs/Games a/b/c ../x nothing")).toEqual({ repos: ["packs/games"], rejected: ["a/b/c", "../x", "nothing"] });
    expect(updateMarkedRepos(app.db, { id: "u", isAdmin: false, kind: "human" }, "packs/games")).toEqual({ ok: false, error: "forbidden" });
    expect(updateMarkedRepos(app.db, { id: "u", isAdmin: true, kind: "agent" }, "packs/games")).toEqual({ ok: false, error: "forbidden" });
    expect(markedRepos(app.db)).toContain("packs/gone");
  });
});

describe("deploy", () => {
  test("makes apps, carries history, adds crew, keeps what exists and reports failures", async () => {
    const calls: string[] = [];
    const hands: Hands = {
      async makeApp(name) {
        calls.push(`app ${name}`);
        return name === "one" ? { ok: true, owner: "me" } : { ok: false, exists: true, why: "x" };
      },
      async carryHistory(source, owner, name) {
        calls.push(`history ${source} -> ${owner}/${name}`);
        return { ok: true };
      },
      async forkFrom() {
        return { ok: false, exists: false, why: "unused" };
      },
      async defaultBranch() {
        return "main";
      },
      async follow(owner, name, source, branch) {
        calls.push(`follow ${owner}/${name} ${source} ${branch}`);
        return { ok: true };
      },
      async absorb() {
        return { ok: true };
      },
      async makeAgent(a) {
        calls.push(`agent ${a.username}`);
        return { ok: false, exists: false, why: "no" };
      },
    };
    const pack = parse({ ...good, apps: [...good.apps, { name: "two", description: "d", source: "https://github.com/c/d" }] });
    if (!pack.ok) throw new Error(pack.error);
    const steps = await deployPack(pack.value, hands);
    expect(calls).toEqual(["app one", "history https://github.com/a/b -> me/one", "follow me/one https://github.com/a/b undefined", "app two", "agent helper"]);
    expect(steps.map((s) => s.state)).toEqual(["done", "kept", "failed"]);
  });
});

describe("pages", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-packs-"));
    app = createApp({ dataDir, port: 0 });
    await seedPacks(app);
    servers = await serve(app);
  });
  afterAll(async () => {
    await servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  test("a stranger reads the list and a pack's page, with the deploy command and what does not come with it", async () => {
    const list = await fetch(`${servers.url}/packs`);
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).toContain("/packs/games");
    expect(text).toContain("/packs/business");
    const one = await fetch(`${servers.url}/packs/games`);
    expect(one.status).toBe(200);
    const body = await one.text();
    expect(body).toContain("scripts/pack.ts deploy games");
    expect(body).toContain("No data, secrets or variables come with it.");
    expect(body).not.toContain("Help build these apps</h2>");
    expect(body).toContain("gabrielecirulli/2048");
    expect((await fetch(`${servers.url}/packs/nothing`)).status).toBe(404);
  });
  test("the home page has one press for each pack, a link in its row; following it finds the command", async () => {
    const { Window } = await import("happy-dom");
    const dom = (h: string) => {
      const w = new Window();
      w.document.body.innerHTML = h;
      return w.document;
    };
    const home = dom(await (await fetch(`${servers.url}/`)).text());
    const presses = [...home.querySelectorAll(".door-press")];
    expect(presses.length).toBe(2);
    for (const name of ["games", "business"]) {
      const press = presses.find((p) => p.querySelector(`h3 > a[href="/packs/${name}"]`) !== null);
      expect(press).toBeDefined();
      expect(press!.querySelector(`.door-press-actions > a[href="/packs/${name}"]`)).not.toBeNull();
      const slot = press!.querySelector('.door-press-actions > [data-slot="host"]');
      expect(slot).not.toBeNull();
      expect(slot!.children.length).toBe(0);
      const page = dom(await (await fetch(`${servers.url}/packs/${name}`)).text());
      const field = page.getElementById("pack-command");
      expect(field).not.toBeNull();
      expect(field!.textContent).toContain(`scripts/pack.ts deploy ${name}`);
      const copy = page.querySelector('[data-copy="pack-command"]');
      expect(copy).not.toBeNull();
      expect(copy!.className).toContain("js-only");
    }
  });
  test("a pack's page puts the deploy command before what it brings; the list is plain rows", async () => {
    const page = await (await fetch(`${servers.url}/packs/games`)).text();
    const cmd = page.indexOf('id="pack-command"');
    expect(cmd).toBeGreaterThan(-1);
    expect(cmd).toBeLessThan(page.indexOf("What it brings"));
    const list = await (await fetch(`${servers.url}/packs`)).text();
    expect(list).toContain('class="list"');
    expect(list).not.toMatch(/class="card[" ]/);
    expect(list).toContain('class="row"');
  });
});
