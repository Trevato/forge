/** Packs: the definition is checked, the shipped two are sound, the deploy keeps its order, and the pages answer. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { catalog } from "../src/packs/catalog.ts";
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
    for (const bad of ["http://github.com/a/b", "https://u:p@github.com/a/b", "git@github.com:a/b", "https://github.com/a", "https://github.com/a/b?x=1", "file:///etc"])
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

describe("shipped packs", () => {
  test("Games and Business ship and parse", () => {
    const c = catalog();
    expect(c.problems).toEqual([]);
    expect(c.packs.map((p) => p.name)).toEqual(["business", "games"]);
    for (const p of c.packs) expect(p.apps.length).toBeGreaterThan(0);
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
      async defaultBranch() {
        return "main";
      },
      async follow(owner, name, source, branch) {
        calls.push(`follow ${owner}/${name} ${source} ${branch}`);
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
    servers = await serve(app);
  });
  afterAll(async () => {
    await servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  test("a stranger reads the list and a pack's page, with the deploy command and what happens to a pull", async () => {
    const list = await fetch(`${servers.url}/packs`);
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).toContain("/packs/games");
    expect(text).toContain("/packs/business");
    const one = await fetch(`${servers.url}/packs/games`);
    expect(one.status).toBe(200);
    const body = await one.text();
    expect(body).toContain("scripts/pack.ts deploy games");
    expect(body).toContain("waits for a person");
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
});
