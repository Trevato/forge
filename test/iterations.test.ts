/**
 * Iterations (`/:owner/:name/iterations`): a fork family's pins as a tree of
 * runs. A pin hangs under the parent it names, else continues its
 * repository's run; a fork's inherited pins are drawn once, in the parent; a
 * family with no pin, or a private one to a stranger, is not found; every
 * note is escaped; the page's script parses; Builds links to it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { pinBuild } from "../src/actions/builds.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { promote } from "./helpers/members.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { familyRepos } from "../src/core/lineage.ts";
import { lanesOf, type IterationBuild, type IterationFork } from "../src/core/iterations.ts";
import { ITERATIONS_CSS, ITERATIONS_JS, ZOOM_JS, ZOOM_MIN } from "../src/web/pages/iterations.ts";
import { components as STYLE_CSS } from "../src/web/style/components.ts";
import { base as BASE_CSS } from "../src/web/style/base.ts";

const build = (repo: string, label: string, parent: string | null = null, edge: IterationBuild["edge"] = parent === null ? null : "git"): IterationBuild => ({
  key: `${repo}:${label}`,
  label,
  oid: "a".repeat(40),
  at: "2026-01-01T00:00:00Z",
  note: "",
  parent,
  edge,
  repo,
  branch: "",
  by: "alice",
  notes: [],
  tag: "",
  forkHas: { branch: null, tagged: false },
  plays: "none",
  page: "/",
  preview: false,
  canNote: false,
});

describe("lanesOf", () => {
  test("a pin continues its repository's run; a second child of a build starts a branch run under it", () => {
    const forks: IterationFork[] = [
      { repo: "a/g", name: "g", depth: 0, tips: [], forkOf: null, builds: [build("a/g", "v1"), build("a/g", "v2", "a/g:v1"), build("a/g", "side", "a/g:v1")] },
    ];
    const lanes = lanesOf(forks);
    expect(lanes.map((l) => [l.id, l.main, l.builds.map((b) => b.label)])).toEqual([
      ["a/g", true, ["v1", "v2"]],
      ["a/g:side", false, ["side"]],
    ]);
    expect(lanes[1]!.from).toBe("a/g:v1");
    expect(lanes[1]!.kind).toBe("branch");
  });

  test("a fork with no parent pin hangs under its upstream's head; a concept edge keeps its kind", () => {
    const forks: IterationFork[] = [
      { repo: "a/g", name: "g", depth: 0, tips: [], forkOf: null, builds: [build("a/g", "v1")] },
      { repo: "b/g", name: "b/g", depth: 1, tips: [], forkOf: "a/g", builds: [build("b/g", "x1")] },
      { repo: "c/g", name: "c/g", depth: 1, tips: [], forkOf: "a/g", builds: [build("c/g", "y1", "a/g:v1", "concept")] },
    ];
    const lanes = lanesOf(forks);
    const b = lanes.find((l) => l.id === "b/g")!;
    expect([b.from, b.fromRepo, b.kind]).toEqual([null, "a/g", "fork"]);
    const c = lanes.find((l) => l.id === "c/g")!;
    expect([c.from, c.kind]).toEqual(["a/g:v1", "concept"]);
  });

  test("a fork with no builds still has a card; a parent cycle ends", () => {
    const forks: IterationFork[] = [
      { repo: "a/g", name: "g", depth: 0, tips: [], forkOf: null, builds: [build("a/g", "v1", "a/g:v2"), build("a/g", "v2", "a/g:v1")] },
      { repo: "b/g", name: "b/g", depth: 1, tips: [], forkOf: "a/g", builds: [] },
    ];
    expect(lanesOf(forks).map((l) => l.id).sort()).toEqual(["a/g", "b/g"]);
  });
});

describe("iterations page", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let bob: User;
  let carol: User;
  const game = (): Repo => getRepo(app.db, "alice", "game")!;
  const get = (path: string, cookie = "") => fetch(`${base}${path}`, { headers: { cookie } });
  const signIn = async (username: string) =>
    ((await fetch(`${base}/signin`, { method: "POST", body: new URLSearchParams({ username, password: "a-good-passphrase" }), redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0]!;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-iterations-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    for (const name of ["alice", "bob", "carol"]) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username: name, email: `${name}@forge.local`, password: "a-good-passphrase", adminIfFirst: true });
      if (!made.ok) throw new Error(made.error);
      if (name === "alice") alice = made.value;
      if (name === "bob") bob = made.value;
      if (name === "carol") carol = made.value;
    }
    promote(app.db, bob);
    promote(app.db, carol);
    for (const name of ["game", "secret", "empty"]) {
      const made = await createRepo(app, alice, { name, visibility: name === "secret" ? "private" : "public" });
      if (!made.ok) throw new Error(String(made.error));
    }
    const commit = async (repo: Repo, who: User, message: string) => {
      const c = await commitToBranch(app, who, repo, { branch: "main", message, files: [{ path: `${message}.txt`, content: `${message}\n` }] });
      if (!c.ok) throw new Error(JSON.stringify(c.error));
      return c.value.commitOid;
    };
    const pin = async (repo: Repo, who: User, label: string, oid: string, extra: { parent?: string; note?: string } = {}) => {
      const p = await pinBuild(app, who, repo, { label, oid, ...extra });
      if (!p.ok) throw new Error(JSON.stringify(p.error));
    };
    const one = await commit(game(), alice, "one");
    const two = await commit(game(), alice, "two");
    await pin(game(), alice, "v1", one, { note: "first <b>playable</b>" });
    await pin(game(), alice, "v2", two, { parent: "v1" });
    await pin(game(), alice, "side", two, { parent: "v1" });
    const forked = await forkRepo(app, bob, game(), "game");
    if (!forked.ok) throw new Error(String(forked.error));
    const mine = getRepo(app.db, "bob", "game")!;
    await pin(mine, bob, "b1", await commit(mine, bob, "bob one"), { parent: "alice/game:v2" });
    const hush = await forkRepo(app, carol, game(), "hush", { visibility: "private" });
    if (!hush.ok) throw new Error(String(hush.error));
    await pin(hush.value, carol, "hush-pin", await commit(hush.value, carol, "hush one"), { parent: "alice/game:v1" });
    const secret = getRepo(app.db, "alice", "secret")!;
    await pin(secret, alice, "s1", await commit(secret, alice, "s"));
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the family is drawn from any member, each pin once, with the runs as data", async () => {
    for (const path of ["/alice/game/iterations?layout=tree", "/bob/game/iterations?layout=tree", "/alice/game/iterations"]) {
      const res = await get(path);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("Iterations");
      for (const key of ["alice/game:v1", "alice/game:v2", "alice/game:side", "bob/game:b1"]) expect(text).toContain(`data-key="${key}"`);
      expect(text.split('class="it-b').filter((r) => r.includes('data-key="alice/game:v1"')).length).toBe(1);
      expect(text).not.toContain('data-key="bob/game:v1"');
    }
  });

  test("the tree has Align, Reset, zoom with Fit, and Collapse and Expand forks; columns have no Align", async () => {
    const tree = await (await get("/alice/game/iterations?layout=tree")).text();
    for (const id of ["it-align", "it-reset", "it-zfit", "it-zin", "it-zout", "it-zval", "it-fold-all", "it-open-all"]) expect(tree).toContain(`id="${id}"`);
    expect(tree).toContain("Drag a run to move it");
    const lanes = JSON.parse(/<script type="application\/json" id="it-data">(.*?)<\/script>/s.exec(tree)![1]!);
    expect(lanes.here).toBe("alice/game");
    expect(lanes.lanes.map((l: { id: string }) => l.id)).toContain("alice/game");
    const columns = await (await get("/alice/game/iterations")).text();
    expect(columns).toContain('id="it-zfit"');
    expect(columns).not.toContain('id="it-align"');
    expect(columns).not.toContain('"lanes"');
  });

  /** The page's rules as plain data: the media query each sits in ("" at the top), its selectors and its declarations. */
  const rulesOf = (css: string) => {
    const out: { media: string; sel: string[]; decl: string }[] = [];
    const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
    let media = "", depth = 0, i = 0;
    while (i < body.length) {
      const open = body.indexOf("{", i), close = body.indexOf("}", i);
      if (close === -1) break;
      if (open !== -1 && open < close) {
        const head = body.slice(i, open).trim();
        if (head.startsWith("@media")) { media = head; depth = 1; i = open + 1; continue; }
        const end = body.indexOf("}", open);
        out.push({ media: depth ? media : "", sel: head.split(",").map((x) => x.trim()), decl: body.slice(open + 1, end) });
        i = end + 1;
      } else { depth = 0; media = ""; i = close + 1; }
    }
    return out;
  };
  const PHONE = "@media (max-width:760px)";

  test("a 390 px screen: the tree scrolls inside .it-stage, nothing around it is held wider, and a card is held to the canvas", async () => {
    const page = await (await get("/alice/game/iterations")).text();
    const at = (s: string) => page.indexOf(s);
    expect(at('class="it-page"')).toBeGreaterThan(-1);
    expect(at('class="it-page"')).toBeLessThan(at('class="it-stage" id="it-stage"'));
    expect(at('class="it-stage" id="it-stage"')).toBeLessThan(at('class="it-zoom" id="it-zoom"'));
    expect(at('class="it-zoom" id="it-zoom"')).toBeLessThan(at('id="it-grid"'));
    expect(BASE_CSS).toContain("body { overflow-x: clip; }");
    const rules = rulesOf(ITERATIONS_CSS);
    const of = (sel: string) => rules.filter((r) => r.sel.includes(sel));
    expect(of(".it-stage").some((r) => r.media === "" && /(^|;)overflow:auto(;|$)/.test(r.decl))).toBe(true);
    for (const box of [".it-page", ".it-stage", ".it-zoom"]) for (const r of of(box)) expect(r.decl).not.toMatch(/(^|;)(min-)?width:/);
    // The card, 50ch of mono (about 400 px), is the one box wider than the screen: on a phone it is the canvas less the
    // shell's and the stage's padding and the stage's border.
    const card = rules.findIndex((r) => r.media === PHONE && r.sel.includes("#it-grid") && r.decl.includes("--it-card:min(calc(50ch + 26px),calc(100vw - 66px))"));
    expect(card).toBeGreaterThan(rules.findIndex((r) => r.media === "" && r.sel.includes("#it-grid") && r.decl.includes("--it-card:")));
    expect(of(".it-pane").find((r) => r.media === PHONE)!.decl).toBe("grid-template-columns:minmax(0,1fr)");
  });

  test("a phone: the toolbar wraps in its own media block, and its 44 px rule outranks .btn[data-size=sm]", async () => {
    const page = await (await get("/alice/game/iterations?layout=tree")).text();
    expect(page).toContain('class="it-zc"');
    for (const id of ["it-fold-all", "it-open-all", "it-zout", "it-zval", "it-zin", "it-zfit", "it-align", "it-reset"]) expect(page).toContain(`id="${id}"`);
    const rules = rulesOf(ITERATIONS_CSS);
    const pane = rules.find((r) => r.sel.includes(".it-pane") && r.media === PHONE)!;
    const block = rules.filter((r) => r.media === PHONE && r !== pane);
    expect(ITERATIONS_CSS).toContain("@media (max-width:760px){.it-pane{grid-template-columns:minmax(0,1fr)}}\n");
    expect(block.find((r) => r.sel.includes(".it-zc"))!.decl).toContain("flex-wrap:wrap");
    expect(block.find((r) => r.sel.includes(".it-key .it-sp"))!.decl).toContain("width:100%");
    const big = block.find((r) => /min-height:44px/.test(r.decl) && r.sel.some((x) => x.includes(".it-zc .btn")))!;
    expect(big.sel.length).toBe(2);
    const weight = (sel: string) => {
      const attrs = (sel.match(/\[[^\]]*\]/g) ?? []).length;
      const rest = sel.replace(/\[[^\]]*\]/g, "");
      return attrs + (rest.match(/[.:]/g) ?? []).length + (rest.match(/#/g) ?? []).length * 100;
    };
    const btn = Math.max(...[...STYLE_CSS.matchAll(/(\.btn\[data-size="sm"\])\s*\{[^}]*min-height/g)].map((m) => weight(m[1]!)));
    expect(btn).toBeGreaterThan(0);
    for (const sel of big.sel) expect(weight(sel)).toBeGreaterThan(btn);
  });

  test("Fit makes a very wide tree fit whole, below the buttons' zoom floor", () => {
    const make = new Function("document", "localStorage", "getComputedStyle", "window", ZOOM_JS + "; return zoom;");
    const handlers: Record<string, () => void> = {};
    const doc = { getElementById: (id: string) => ({ textContent: "", addEventListener: (_: string, f: () => void) => { handlers[id] = f; } }) };
    const store = { getItem: () => null, setItem() {}, removeItem() {} };
    const cs = () => ({ paddingLeft: "16", paddingRight: "16", paddingTop: "16", paddingBottom: "16", maxHeight: "480", borderLeftWidth: "1", borderRightWidth: "1", borderTopWidth: "1", borderBottomWidth: "1" });
    const stage = { clientWidth: 358, clientHeight: 400, scrollLeft: 0, scrollTop: 0, addEventListener() {} };
    const grid = { offsetWidth: 20000, offsetHeight: 300, style: {} as Record<string, string> };
    const box = { style: {} as Record<string, string> };
    const z = make(doc, store, cs, { innerHeight: 800 })(stage, box, grid, () => {});
    handlers["it-zfit"]!();
    expect(z.z()).toBeLessThan(ZOOM_MIN);
    expect(20000 * z.z()).toBeLessThanOrEqual(358 - 32);
    handlers["it-zin"]!();
    expect(z.z()).toBeGreaterThanOrEqual(ZOOM_MIN);
  });

  test("a Fit below ZOOM_MIN saved in this browser reopens at ZOOM_MIN, not at 1%", () => {
    const make = new Function("document", "localStorage", "getComputedStyle", "window", ZOOM_JS + "; return zoom;");
    const doc = { getElementById: () => ({ textContent: "", addEventListener() {} }) };
    const store = { getItem: () => "0.01", setItem() {}, removeItem() {} };
    const stage = { clientWidth: 1200, clientHeight: 600, scrollLeft: 0, scrollTop: 0, addEventListener() {} };
    const z = make(doc, store, () => ({}), { innerHeight: 800 })(stage, { style: {} }, { offsetWidth: 800, offsetHeight: 300, style: {} }, () => {});
    expect(z.z()).toBe(ZOOM_MIN);
  });

  test("the markup the script relies on is there for a folded run", async () => {
    const text = await (await get("/alice/game/iterations?layout=tree")).text();
    expect(text).toContain('data-lane="alice/game" data-repo="alice/game"');
    expect(text).toMatch(/data-act="fork" data-keys="[^"]*alice\/game:v1/);
    expect(text).toMatch(/data-act="run" data-keys="[^"]*alice\/game:v1/);
    expect(ITERATIONS_JS).toContain("forge:iterations-tree:");
    expect(ITERATIONS_JS).toContain("forge:iterations-folds:");
    expect(ITERATIONS_JS).toContain("forge:iterations-zoom");
  });

  test("a fold hides its rows and shows the one node it leaves", () => {
    const rule = (selector: string) => ITERATIONS_CSS.split("\n").find((l) => l.startsWith(selector) || l.includes(`,${selector}`)) ?? "";
    for (const shut of [".it-lane.it-shut .it-rows", ".it-lane.it-runshut .it-rows", ".it-lane.it-shut .it-ct"]) expect(rule(shut)).toMatch(/\{display:none\}$/);
    expect(rule(".it-lane.it-shut .it-fcoll")).toMatch(/\{display:flex\}$/);
    expect(rule(".it-lane.it-runshut:not(.it-shut) .it-rcoll")).toMatch(/\{display:flex\}$/);
    expect(rule(".it-coll{")).toContain("display:none");
  });

  test("the info panel carries the build, its notes and its actions", async () => {
    const text = await (await get("/alice/game/iterations?build=alice/game:v1")).text();
    expect(text).toContain('id="it-i-');
    for (const word of ["Pin", "Lineage", "Notes", "Actions", "Copy link", "Clone", "Fork"]) expect(text).toContain(word);
    expect(text).toContain("refs/builds/v1");
    // A guest cannot add a note or delete a pin.
    expect(text).not.toContain("Add a note");
    expect(text).not.toContain("Delete pin");
    const mine = await (await get("/alice/game/iterations?build=alice/game:v1", await signIn("alice"))).text();
    expect(mine).toContain("Add a note");
    expect(mine).toContain("Delete pin");
  });

  test("a note is saved from the panel, as the writer who asked, and not by a stranger or another origin", async () => {
    const cookie = await signIn("alice");
    const post = (c: string, origin: string, text: string) =>
      fetch(`${base}/alice/game/builds/v1/note`, { method: "POST", redirect: "manual", headers: { cookie: c, origin, accept: "application/json" }, body: new URLSearchParams({ notes: text }) });
    const bad = await post(cookie, "https://evil.example", "no");
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const guest = await post("", base, "no");
    expect(guest.status).toBe(303);
    const ok = await post(cookie, base, "Tuned <i>the jump</i>\nMore.");
    expect(ok.status).toBe(200);
    const j = (await ok.json()) as { note: string; html: string };
    expect(j.html).toContain("Tuned &lt;i&gt;the jump&lt;/i&gt;");
    expect(j.html).not.toContain("<i>the jump</i>");
    const empty = await post(cookie, base, "   ");
    expect(empty.status).toBe(422);
  });

  test("a private fork and its pin are drawn to its owner and never to a guest", async () => {
    const guest = await (await get("/alice/game/iterations")).text();
    expect(guest).not.toContain("hush");
    expect(guest).not.toContain("hush-pin");
    expect((await get("/carol/hush/iterations")).status).toBe(404);
    const mine = await (await get("/carol/hush/iterations", await signIn("carol"))).text();
    expect(mine).toContain('data-key="carol/hush:hush-pin"');
    // What it carried from alice/game is drawn once, in alice/game.
    expect(mine.split('data-key="alice/game:v1"').length).toBe(2);
    expect(mine.split("carol/hush:v1").length).toBe(1);
  });

  test("a family is the root first, then the forks the viewer may read", () => {
    const ctx = (user: User | undefined) => ({ app, auth: { user } }) as Parameters<typeof familyRepos>[0];
    const all = familyRepos(ctx(carol), game());
    expect(all[0]!.name).toBe("game");
    expect(all.length).toBe(3);
    expect(familyRepos(ctx(bob), game()).length).toBe(2);
    expect(familyRepos(ctx(undefined), game()).map((r) => r.name)).toEqual(["game", "game"]);
  });

  test("a note is escaped", async () => {
    const text = await (await get("/alice/game/iterations")).text();
    expect(text).toContain("first &lt;b&gt;playable&lt;/b&gt;");
    expect(text).not.toContain("<b>playable</b>");
  });

  test("the page keeps the security floor, loosens no frames, and ships a script that parses", async () => {
    const res = await get("/alice/game/iterations");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBeTruthy();
    expect(res.headers.get("content-security-policy") ?? "").not.toContain("frame-src http");
    expect(() => new Function(ITERATIONS_JS)).not.toThrow();
    // A build plays only as a build preview on the forge's own origin: no frame.
    expect(await res.text()).not.toContain("<iframe");
  });

  test("a family with no pin is not found", async () => {
    expect((await get("/alice/empty/iterations")).status).toBe(404);
    expect((await get("/alice/nope/iterations")).status).toBe(404);
  });

  test("a private family is not found to a stranger and drawn to its owner", async () => {
    expect((await get("/alice/secret/iterations")).status).toBe(404);
    const cookie = await signIn("alice");
    expect((await get("/alice/secret/iterations", cookie)).status).toBe(200);
  });

  test("Builds draws the family's pins as a lineage, each under its parent, and the pin form offers them as Parent", async () => {
    const list = await (await get("/alice/game/builds")).text();
    expect(list).toMatch(/data-depth="0"[^>]*>[\s\S]*?>v1</);
    expect(list).toMatch(/data-depth="1"[^>]*>[\s\S]*?>v2</);
    expect(list).toMatch(/<span class="muted">bob\/game:<\/span>b1/);
    const cookie = await signIn("alice");
    const form = await (await get("/alice/game/builds/new", cookie)).text();
    expect(form).toContain('name="parent"');
    expect(form).toContain('value="alice/game:v2"'.replace("alice/game:", ""));
    expect(form).toContain('value="bob/game:b1"');
    expect(form).not.toContain("make_demo");
  });

  test("Builds links to Iterations when it holds a pin", async () => {
    expect(await (await get("/alice/game/builds")).text()).toContain('href="/alice/game/iterations?layout=tree"');
    expect(await (await get("/alice/empty/builds")).text()).not.toContain("/iterations");
  });

  test("the API lists the same pins as the page for a reader, a stranger and a guest", async () => {
    for (const who of ["carol", "bob", ""]) {
      const cookie = who === "" ? "" : await signIn(who);
      const page = await (await get("/alice/game/iterations", cookie)).text();
      const shown = [...page.matchAll(/data-key="([^"]+)"/g)].map((m) => m[1]!);
      const res = await get("/api/v1/repos/alice/game/iterations", cookie);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { forks: IterationFork[]; lanes: { builds: IterationBuild[] }[] };
      const keys = data.forks.flatMap((f) => f.builds.map((b) => b.key));
      expect([...new Set(shown)].sort()).toEqual([...keys].sort());
      expect(data.lanes.flatMap((l) => l.builds.map((b) => b.key)).sort()).toEqual([...keys].sort());
      expect(keys.some((k) => k.includes("hush-pin"))).toBe(who === "carol");
      expect(data.forks.flatMap((f) => f.builds).every((b) => b.label !== "" && /^[0-9a-f]{40}$/.test(b.oid) && b.at !== "")).toBe(true);
    }
  });

  test("the API: a private repository is a 404 to a stranger, an empty family answers empty lists", async () => {
    expect((await get("/api/v1/repos/alice/secret/iterations")).status).toBe(404);
    expect((await get("/api/v1/repos/alice/secret/iterations", await signIn("bob"))).status).toBe(404);
    expect((await get("/api/v1/repos/alice/secret/iterations", await signIn("alice"))).status).toBe(200);
    const res = await get("/api/v1/repos/alice/empty/iterations");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ forks: [], lanes: [] });
  });
});
