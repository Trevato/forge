/**
 * /boards/data: seeded runs draw a path with one point per bucket, a query
 * is a link, points link to their rows, and anyone but a person who is an
 * admin gets the not-found page.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { lineChart } from "../src/boards/chart.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";

let dir: string;
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
const tok: Record<string, string> = {};
const get = (path: string, who: string | null) =>
  fetch(servers.url + path, { headers: who ? { authorization: `Bearer ${tok[who]}` } : {} });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-boards-page-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, adminIfFirst?: boolean) => {
    const r = await createUser(app.db, {
      trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", ...(adminIfFirst ? { adminIfFirst } : {}),
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const alice = await mk("alice", true);
  const bob = await mk("bob");
  tok.admin = createToken(app.db, alice.id, "t", "admin").token;
  tok.bob = createToken(app.db, bob.id, "t", "admin").token;
  app.db.run("INSERT INTO repo (id, owner_id, name) VALUES ('rb', ?, 'n')", [alice.id]);
  const ins = app.db.prepare("INSERT INTO run (id, repo_id, kind, state, created_at) VALUES (?, 'rb', 'agent', 'ok', ?)");
  ins.run("a", "2026-10-01T10:05:00.000Z");
  ins.run("b", "2026-10-02T10:05:00.000Z");
  ins.run("c", "2026-10-02T11:05:00.000Z");
  ins.run("d", "2026-10-04T11:05:00.000Z");
  const mix = app.db.prepare("INSERT INTO run (id, repo_id, kind, state, turns, created_at) VALUES (?, 'rb', ?, ?, ?, '2026-10-04T12:00:00.000Z')");
  mix.run("m1", "deploy", "failed", 3);
  mix.run("m2", "deploy", "ok", 3);
  mix.run("m3", "check", "failed", 3);
  mix.run("m4", "check", "ok", 5);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("/boards/data", () => {
  test("seeded runs per day draw one path with one point per day", async () => {
    const res = await get("/boards/data?source=runs&by=day", "admin");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body.match(/<path d="M[^"]*" fill="none" stroke="currentColor" stroke-width="2"/g)?.length).toBe(1);
    expect(body.match(/<circle cx="[^"]*" cy="[^"]*" r="4">/g)?.length).toBe(3);
    expect(body).toContain("2026-10-02T00:00:00Z");
  });

  test("a point links to the rows behind it", async () => {
    const body = await (await get("/boards/data?source=runs&by=day", "admin")).text();
    const m = body.match(/href="(\/boards\/data\?[^"]*rows=1[^"]*)"/);
    expect(m).not.toBeNull();
    const rows = await (await get(m![1]!.replaceAll("&amp;", "&"), "admin")).text();
    expect(rows).not.toContain('r="4">');
    expect(rows).toContain("<table");
  });

  const pointLinks = (body: string) =>
    [...body.matchAll(/<a href="(\/boards\/data\?[^"]*rows=1[^"]*)"><circle/g)].map((m) => m[1]!.replaceAll("&amp;", "&"));
  const listed = async (url: string) => {
    const t = await (await get(url, "admin")).text();
    return [...t.matchAll(/<td class="mono">([a-z0-9]+)<\/td>/g)].map((m) => m[1]!).filter((x) => /^m\d$/.test(x)).sort();
  };

  test("a column point keeps the user's filter and adds its group", async () => {
    const body = await (await get("/boards/data?source=runs&by=kind&fcolumn=state&fvalue=failed&from=2026-10-04T12:00:00Z", "admin")).text();
    const links = pointLinks(body);
    expect(links.length).toBe(2);
    const mixk = links.find((l) => l.includes("gvalue=deploy"))!;
    expect(await listed(mixk)).toEqual(["m1"]);
    expect(await listed(links.find((l) => l.includes("gvalue=check"))!)).toEqual(["m3"]);
  });

  test("a numeric point is narrowed as a number; a null point has no link", async () => {
    const body = await (await get("/boards/data?source=runs&by=turns&from=2026-10-04T12:00:00Z", "admin")).text();
    const five = pointLinks(body).find((l) => l.includes("gvalue=5"))!;
    expect(await listed(five)).toEqual(["m4"]);
    const nul = await (await get("/boards/data?source=runs&by=issue_id", "admin")).text();
    expect(pointLinks(nul)).toEqual([]);
  });

  test("a bad query is refused on the page, not thrown", async () => {
    const res = await get("/boards/data?source=nope", "admin");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("That query was refused");
  });

  test("a filter narrows the points", async () => {
    const body = await (await get("/boards/data?source=runs&by=day&from=2026-10-02&to=2026-10-03", "admin")).text();
    expect(body.match(/<circle cx="[^"]*" cy="[^"]*" r="4">/g)?.length).toBe(1);
  });

  test("hostile params are escaped", async () => {
    const body = await (await get('/boards/data?from="><script>x</script>', "admin")).text();
    expect(body).not.toContain("<script>x</script>");
  });

  test("a non-admin and a stranger get 404; the admin's menu links Boards", async () => {
    expect((await get("/boards/data", "bob")).status).toBe(404);
    expect((await get("/boards/data", null)).status).toBe(404);
    expect(await (await get("/", "admin")).text()).toContain('href="/boards"');
    expect(await (await get("/", "bob")).text()).not.toContain('href="/boards"');
  });
});

describe("lineChart", () => {
  test("escapes labels and holds its size", () => {
    const svg = lineChart([{ label: "<b>&", value: 1 }, { label: "x", value: 2 }], "t");
    expect(svg).not.toContain("<b>");
    expect(svg).toContain("&lt;b&gt;&amp;");
    expect(svg).toContain('viewBox="0 0 720 260"');
  });
  test("no points still draws", () => {
    expect(lineChart([], "t")).toContain("No points");
  });
});
