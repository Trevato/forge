/** One filter, one word: the page, the API and the MCP `explore` tool return the same ordered ids (#10387). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";
import { exploreParams, readExploreLine } from "../src/actions/explore.ts";
/** The href the page gives a line: separate parameters, `&` escaped as in markup. */
const linkOf = (line: string): string => `/explore?${exploreParams(readExploreLine(line).query)}`.replace(/&/g, "&amp;");

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let token: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-explore-parity-"));
  app = createApp({ dataDir: dir, port: 0 });
  for (const name of ["olive", "pine", "birch"]) {
    const made = await createUser(app.db, { origin: "seed", username: name, email: `${name}@forge.local`, password: "a-good-passphrase", adminIfFirst: false });
    if (!made.ok) throw new Error(made.error);
    proveAll(app);
    promote(app.db, made.value);
    if (name === "olive") token = createToken(app.db, made.value.id, "ro", "ro").token;
    for (const r of ["garden", "kiln", "loom"]) {
      const repo = await createRepo(app, made.value, { name: `${r}-${name}`, visibility: "public" });
      if (!repo.ok) throw new Error(String(repo.error));
      const rec = insertApp(app.db, { repoId: repo.value.id, slug: `${name}-${r}`, access: "public" });
      if (!rec.ok) throw new Error(rec.error);
    }
  }
  seedSignals();
  servers = await serve(app);
});
afterAll(async () => {
  await servers.stop();
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;

/** Signals that make every sort a different order: who is forked, shipped, liked, awake, fresh, and archived. */
function seedSignals(): void {
  const repoId = (owner: string, name: string): string => {
    const row = app.db.query<{ id: string }, [string, string]>("SELECT repo.id AS id FROM repo JOIN user ON user.id = repo.owner_id WHERE user.username = ?1 AND repo.name = ?2").get(owner, name);
    if (row === null) throw new Error(`no ${owner}/${name}`);
    return row.id;
  };
  const owner = app.db.query<{ id: string }, [string]>("SELECT id FROM user WHERE username = ?1").get("olive")!.id;
  const now = Date.now();
  // forks: loom-olive 2, garden-olive 1
  const fork = (child: [string, string], parent: [string, string]) =>
    app.db.run("UPDATE repo SET fork_parent_id = ?1 WHERE id = ?2", [repoId(...parent), repoId(...child)]);
  fork(["pine", "kiln-pine"], ["olive", "loom-olive"]);
  fork(["pine", "garden-pine"], ["olive", "loom-olive"]);
  fork(["birch", "kiln-birch"], ["olive", "garden-olive"]);
  // ships (merged pulls): garden-pine 3 (latest 5d ago), loom-birch 2 (latest 1d ago), kiln-olive 1 (45d ago, outside the window)
  const ship = (r: [string, string], ago: number) => {
    const issue = createIssue(app.db, { repoId: repoId(...r), authorId: owner, title: "change", kind: "pull" });
    if (!issue.ok) throw new Error(issue.error);
    app.db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1, 'main', 'b', '', '', ?2)", [issue.value.id, new Date(now - ago).toISOString()]);
  };
  ship(["pine", "garden-pine"], 5 * DAY);
  ship(["pine", "garden-pine"], 6 * DAY);
  ship(["pine", "garden-pine"], 7 * DAY);
  ship(["birch", "loom-birch"], 1 * DAY);
  ship(["birch", "loom-birch"], 2 * DAY);
  ship(["olive", "kiln-olive"], 45 * DAY);
  // likes: garden-birch 3, kiln-olive 2, loom-pine 1
  const like = (r: [string, string], n: number) => {
    for (let i = 0; i < n; i++) app.db.run("INSERT INTO feed_like (viewer_id, item_id, repo_id) VALUES (?1, ?2, ?3)", [owner, `${r[1]}-${i}`, repoId(...r)]);
  };
  like(["birch", "garden-birch"], 3);
  like(["olive", "kiln-olive"], 2);
  like(["pine", "loom-pine"], 1);
  // use (hours awake): kiln-pine 10, garden-olive 5, kiln-birch 2
  const awake = (r: [string, string], hours: number) =>
    app.db.run("INSERT INTO meter (repo_id, env, placement, started_at, beat_at, ended_at) VALUES (?1, 'production', 'owned', ?2, ?3, ?3)", [
      repoId(...r),
      new Date(now - 2 * DAY - hours * 3_600_000).toISOString(),
      new Date(now - 2 * DAY).toISOString(),
    ]);
  awake(["pine", "kiln-pine"], 10);
  awake(["olive", "garden-olive"], 5);
  awake(["birch", "kiln-birch"], 2);
  // put away: loom-pine is only in archived:yes
  app.db.run("UPDATE repo SET archived_at = ?1 WHERE id = ?2", [new Date(now).toISOString(), repoId("pine", "loom-pine")]);
}

const LINES = [
  "",
  "kind:app",
  "kind:person",
  "sort:forks",
  "sort:ships",
  "sort:likes",
  "sort:use",
  "sort:fresh",
  "sort:name",
  "updated:7d",
  "owner:pine",
  "archived:yes",
  "kind:app sort:name garden",
];

/** The row links inside the page's `<ul class="list">`, in order: each row's title is the one link to its own url. */
function pageOrder(html: string): string[] {
  const list = /<ul class="list">([\s\S]*?)<\/ul>/.exec(html);
  if (list === null) return [];
  return [...list[1]!.matchAll(/<li[^>]*>[\s\S]*?<a href="(\/[^"?]*)">[^<]*<\/a>/g)].map((m) => m[1]!);
}

const ids = (items: { kind: string; name: string }[]) => items.map((i) => `${i.kind}:${i.name}`);

async function mcp(line: string): Promise<{ ok: boolean; text: string }> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "explore", arguments: { q: line } } }),
  });
  const out = ((await res.json()) as any).result;
  return { ok: out.isError !== true, text: out.content[0].text };
}

describe("one filter, three surfaces", () => {
  // The orders the seeded signals must give, so a sort that ignores its signal (and falls back to name) fails.
  const EXPECTED: Record<string, string[]> = {
    "kind:app sort:forks": ["olive/loom-olive", "olive/garden-olive"],
    "kind:app sort:ships": ["pine/garden-pine", "birch/loom-birch"],
    "kind:app sort:likes": ["birch/garden-birch", "olive/kiln-olive"],
    "kind:app sort:use": ["pine/kiln-pine", "olive/garden-olive", "birch/kiln-birch"],
    "kind:app sort:fresh": ["birch/loom-birch", "pine/garden-pine", "olive/kiln-olive"],
    "kind:app sort:name": ["birch/garden-birch", "birch/kiln-birch", "birch/loom-birch", "olive/garden-olive", "olive/kiln-olive", "olive/loom-olive", "pine/garden-pine", "pine/kiln-pine"],
    "kind:person sort:forks": ["olive"],
    "kind:app updated:7d": ["pine/garden-pine", "birch/loom-birch"],
    "kind:app archived:yes sort:name": ["birch/garden-birch", "birch/kiln-birch", "birch/loom-birch", "olive/garden-olive", "olive/kiln-olive", "olive/loom-olive", "pine/garden-pine", "pine/kiln-pine", "pine/loom-pine"],
  };
  for (const [line, want] of Object.entries(EXPECTED)) {
    test(`"${line}" puts the seeded signals in their order, the same on the API, the MCP and the page`, async () => {
      const api = (await (await fetch(`${servers.url}/api/v1/explore?q=${encodeURIComponent(line)}`)).json()) as { items: { name: string; url: string }[] };
      // Only the leading rows are pinned: the rest tie at zero and fall to name.
      expect(api.items.map((i) => i.name).slice(0, want.length)).toEqual(want);
      const tool = await mcp(line);
      expect(tool.ok).toBe(true);
      expect((JSON.parse(tool.text) as typeof api).items.map((i) => i.name)).toEqual(api.items.map((i) => i.name));
      const html = await (await fetch(`${servers.url}/explore?q=${encodeURIComponent(line)}`)).text();
      expect(pageOrder(html)).toEqual(api.items.map((i) => i.url));
    });
  }

  test("the sorts are different orders, not one order under seven names", async () => {
    const seen = new Set<string>();
    for (const sort of ["score", "forks", "ships", "likes", "use", "fresh", "name"]) {
      const api = (await (await fetch(`${servers.url}/api/v1/explore?q=${encodeURIComponent(`kind:app sort:${sort}`)}`)).json()) as { items: { name: string }[] };
      seen.add(api.items.map((i) => i.name).join(","));
    }
    expect(seen.size).toBe(7);
  });

  for (const line of LINES) {
    test(`"${line}" gives the same ordered rows on the API and the MCP, and the page lists them in that order`, async () => {
      const api = (await (await fetch(`${servers.url}/api/v1/explore?q=${encodeURIComponent(line)}`, { headers: { authorization: `Bearer ${token}` } })).json()) as { items: { kind: string; name: string; url: string }[] };
      const tool = await mcp(line);
      expect(tool.ok).toBe(true);
      const viaMcp = JSON.parse(tool.text) as { items: { kind: string; name: string; url: string }[] };
      expect(ids(viaMcp.items)).toEqual(ids(api.items));
      if (line === "") expect(api.items.length).toBeGreaterThan(0);
      // The page, anonymous, sees the same public rows; its order is the API's order.
      const anon = (await (await fetch(`${servers.url}/api/v1/explore?q=${encodeURIComponent(line)}`)).json()) as { items: { kind: string; name: string; url: string }[] };
      const html = await (await fetch(`${servers.url}/explore?q=${encodeURIComponent(line)}`)).text();
      expect(pageOrder(html)).toEqual(anon.items.map((i) => i.url));
    });
  }

  test("the page's chips are links whose q is a line the API takes", async () => {
    const html = await (await fetch(`${servers.url}/explore`)).text();
    for (const line of ["kind:app", "sort:forks", "sort:ships", "sort:likes", "sort:use", "sort:fresh", "updated:7d", "kind:person"]) {
      expect(html).toContain(`href="${linkOf(line)}"`);
      expect((await fetch(`${servers.url}/api/v1/explore?q=${encodeURIComponent(line)}`)).status).toBe(200);
    }
  });

  test("an unknown filter is a 422 naming the allowed words, on all three", async () => {
    const q = encodeURIComponent("sort:bogus");
    const api = await fetch(`${servers.url}/api/v1/explore?q=${q}`);
    expect(api.status).toBe(422);
    const body = (await api.json()) as { error: string; message: string };
    expect(body.error).toBe("unknown_filter");
    expect(body.message).toContain("use score, forks, ships, likes, use, fresh, name");
    const tool = await mcp("sort:bogus");
    expect(tool.ok).toBe(false);
    expect(tool.text).toContain("use score, forks, ships, likes, use, fresh, name");
    const page = await fetch(`${servers.url}/explore?q=${q}`);
    expect(page.status).toBe(422);
    expect(await page.text()).toContain("use score, forks, ships, likes, use, fresh, name");
    for (const bad of ["kind:x", "updated:2y", "archived:maybe"]) {
      expect((await fetch(`${servers.url}/api/v1/explore?q=${encodeURIComponent(bad)}`)).status).toBe(422);
    }
  });
});

describe("separate parameters", () => {
  const PARAMS: Record<string, string>[] = [
    { kind: "app", sort: "forks" },
    { kind: "app", sort: "name", owner: "pine" },
    { kind: "app", updated: "7d" },
    { kind: "app", archived: "yes", sort: "name" },
  ];
  async function mcpArgs(args: Record<string, string>): Promise<{ ok: boolean; text: string }> {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "explore", arguments: args } }),
    });
    const out = ((await res.json()) as any).result;
    return { ok: out.isError !== true, text: out.content[0].text };
  }
  const names = async (qs: string) =>
    (((await (await fetch(`${servers.url}/api/v1/explore?${qs}`)).json()) as { items: { kind: string; name: string }[] }).items);

  for (const params of PARAMS) {
    test(`${JSON.stringify(params)} gives the same rows on the API, the MCP and the page`, async () => {
      const qs = new URLSearchParams(params).toString();
      const api = await names(qs);
      expect(api.length).toBeGreaterThan(0);
      const tool = await mcpArgs(params);
      expect(tool.ok).toBe(true);
      expect(ids((JSON.parse(tool.text) as { items: typeof api }).items)).toEqual(ids(api));
      // The same as the one-line form.
      const line = Object.entries(params).map(([k, v]) => `${k}:${v}`).join(" ");
      expect(ids(await names(`q=${encodeURIComponent(line)}`))).toEqual(ids(api));
      const html = await (await fetch(`${servers.url}/explore?${qs}`)).text();
      expect(pageOrder(html)).toEqual(
        ((await (await fetch(`${servers.url}/api/v1/explore?${qs}`)).json()) as { items: { url: string }[] }).items.map((i) => i.url),
      );
    });
  }

  test("a parameter wins over the same key in q, on the API, the MCP and the page", async () => {
    const want = ids(await names("kind=app&sort=name"));
    expect(want.every((w) => w.startsWith("app:"))).toBe(true);
    const q = encodeURIComponent("kind:person sort:forks");
    expect(ids(await names(`q=${q}&kind=app&sort=name`))).toEqual(want);
    const tool = await mcpArgs({ q: "kind:person sort:forks", kind: "app", sort: "name" });
    expect(ids((JSON.parse(tool.text) as { items: { kind: string; name: string }[] }).items)).toEqual(want);
    const html = await (await fetch(`${servers.url}/explore?q=${q}&kind=app&sort=name`)).text();
    const urls = (await names("kind=app&sort=name")).map((_, i) => i);
    expect(pageOrder(html).length).toBe(urls.length);
    expect(pageOrder(html).every((u) => u.split("/").length === 3)).toBe(true);
  });
});

describe("last ship on the row", () => {
  test("the page words it as 'shipped 1d ago' with the absolute date in title; the API carries shippedAt", async () => {
    const html = await (await fetch(`${servers.url}/explore?q=${encodeURIComponent("kind:app sort:fresh")}`)).text();
    expect(html).toMatch(/shipped <time datetime="[^"]+" title="\d{4}-\d\d-\d\d \d\d:\d\d UTC"\s*>1d ago<\/time/);
    const api = (await (await fetch(`${servers.url}/api/v1/explore?q=${encodeURIComponent("kind:app sort:fresh")}`)).json()) as { items: { name: string; shippedAt: string | null }[] };
    expect(api.items[0]!.shippedAt).not.toBeNull();
  });
});
