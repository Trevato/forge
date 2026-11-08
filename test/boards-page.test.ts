/**
 * /boards/data: seeded runs draw a path with one point per bucket, a query
 * is a link, points link to their rows, every chart type draws the same
 * seeded query with the elements it should, and anyone but a person who is
 * an admin gets the not-found page.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { barChart, drawChart, CHARTS, gridOf, heatStrip, lineChart, numberChart, stackedArea, tableChart } from "../src/boards/chart.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { makeBoard } from "../src/actions/boards.ts";
import { serve } from "../src/http/server.ts";

let dir: string;
let admin: User;
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
      origin: "seed",
      trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", ...(adminIfFirst ? { adminIfFirst } : {}),
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const alice = await mk("alice", true);
  admin = alice;
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

/** The seeded `m` runs a rows link lists. */
const listed = async (url: string) => {
  const t = await (await get(url, "admin")).text();
  return [...t.matchAll(/<td class="mono">([a-z0-9]+)<\/td>/g)].map((m) => m[1]!).filter((x) => /^m\d$/.test(x)).sort();
};

describe("/boards forms", () => {
  test("the chart and pin forms are §5 fields", async () => {
    const made = await makeBoard(app, admin, "Pins");
    expect(made.ok).toBe(true);
    const body = await (await get("/boards/data?source=runs&by=day", "admin")).text();
    for (const name of ["chart", "source", "aggregate", "column", "by", "series", "from", "to", "fcolumn", "fop", "fvalue"]) {
      expect(body).toMatch(new RegExp(`<div class="field"[^>]*>\\s*<label for="f-${name}-\\d+">[^]*?name="${name}"`));
    }
    expect(body).toMatch(/<span class="hint" id="[^"]*-hint">Column to aggregate<\/span>/);
    expect(body).toContain('name="slug"');
    expect(body).toContain('<label for="f-pin-title">Panel title</label>');
  });

  test("Delete this board asks first on the confirm page, which names the board", async () => {
    const made = await makeBoard(app, admin, "Doomed");
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    const slug = made.value;
    const board = await (await get(`/boards/${slug}`, "admin")).text();
    const to = encodeURIComponent(`/boards/${slug}/delete`);
    expect(board).toContain(`href="/-/confirm?to=${to}"`);
    expect(board).not.toContain(`action="/boards/${slug}/delete"`);
    const res = await get(`/-/confirm?to=${to}`, "admin");
    expect(res.status).toBe(200);
    const confirm = await res.text();
    expect(confirm).toContain(`Delete the board ${slug}?`);
    expect(confirm).toContain("Its panels and pins go with it. Nothing it reads is touched.");
    expect(confirm).toContain(`action="/boards/${slug}/delete"`);
  });
});

describe("/boards/data", () => {
  test("the result is drawn with §5's card and table, not .boards-result", async () => {
    const body = await (await get("/boards/data?source=runs&by=day", "admin")).text();
    expect(body).not.toContain("boards-result");
    expect(body).toMatch(/<table\s+class="table mt"/);
    expect(body).toContain("<h2>runs</h2>");
    expect(body).toContain('<th scope="col" class="num">');
    expect(body).toContain("2026-10-02");
  });

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

  test("the machine source draws its points and says what this machine cannot measure", async () => {
    app.db.run(
      "INSERT INTO machine_sample (at, step, target, cpu_cores, memory_bytes) VALUES ('2026-10-15T12:00:15.000Z', 15, 'forge', 0.25, 1048576)",
    );
    const body = await (await get("/boards/data?source=machine&aggregate=avg&column=cpu_cores&by=target", "admin")).text();
    expect(body).toContain("What this machine measures");
    // Each absent series is named with its file; on a machine with them all, it says so instead.
    expect(body).toMatch(/<li>Absent — [^<]*?\/[^\s<]+[^<]*<\/li>|Every series is readable on this machine/);
    expect(body).toContain("cores in use, mean over the step");
    expect(body).toContain(">forge</a></td>");
    expect(body).toContain(">0.25</td>");
    expect(await (await get("/boards/data?source=runs", "admin")).text()).not.toContain("What this machine measures");
  });

  test("the machine card links per-core CPU and temperature, and the link draws the cores alone", async () => {
    const at = new Date(Date.now() - 60_000).toISOString();
    const put = app.db.prepare("INSERT INTO machine_sample (at, step, target, cpu_cores, celsius) VALUES (?, 15, ?, ?, ?)");
    put.run(at, "cpu:000", 0.75, 71);
    put.run(at, "cpu:001", 0.5, 82);
    put.run(at, "node", 1.25, null);
    const body = await (await get("/boards/data?source=machine&aggregate=count&by=target", "admin")).text();
    const href = (label: string) => {
      const m = new RegExp(`<a href="([^"]+)">${label}</a>`).exec(body);
      expect(m).not.toBeNull();
      return m![1]!.replaceAll("&amp;", "&");
    };
    const cpu = await (await get(href("CPU per core, last hour"), "admin")).text();
    expect(cpu).toContain(">cpu:000</a></td>");
    expect(cpu).toContain(">0.75</td>");
    expect(cpu).toContain(">cpu:001</a></td>");
    // The filter is `target starts cpu:`: the node is not a core.
    expect(cpu).not.toContain(">node</a></td>");
    const temp = await (await get(href("Temperature per core, last hour \\(max °C\\)"), "admin")).text();
    expect(temp).toContain(">71</td>");
    expect(temp).toContain(">82</td>");
  });
});

describe("every chart type from one seeded query", () => {
  // runs per day split by kind: 10-01 agent 1; 10-02 agent 2; 10-04 agent 1, check 2, deploy 2.
  // Three days, three kinds, five non-empty cells.
  const q = "/boards/data?source=runs&by=day&series=kind";
  const drawn = async (chart: string) => {
    const res = await get(`${q}&chart=${chart}`, "admin");
    expect(res.status).toBe(200);
    return res.text();
  };
  const count = (body: string, re: RegExp) => body.match(re)?.length ?? 0;

  test("line draws one point per day, the series set aside", async () => {
    const body = await drawn("line");
    expect(count(body, /<circle cx="[^"]*" cy="[^"]*" r="4">/g)).toBe(3);
    expect(count(body, /<div class="chart-box"><svg [^>]*class="chart"/g)).toBe(1);
  });
  test("bar draws one bar per day", async () => {
    expect(count(await drawn("bar"), /<rect class="bar"/g)).toBe(3);
  });
  test("stacked area draws one band per kind, with a legend", async () => {
    const body = await drawn("area");
    expect(count(body, /<path class="area"/g)).toBe(3);
    expect(count(body, /<rect class="key"/g)).toBe(3);
  });
  test("number draws the latest day's count and a three-point sparkline", async () => {
    const body = await drawn("number");
    expect(body).toMatch(/<text class="big"[^>]*>5<\/text>/);
    expect(body).toContain("latest of 3: 2026-10-04T00:00:00Z");
    const spark = body.match(/<path class="spark" d="([^"]*)"/)![1]!;
    expect(spark.split(" L").length).toBe(3);
  });
  test("table draws one row per day and kind, and no second table under it", async () => {
    const body = await drawn("table");
    const table = body.match(/<table class="table chart-table">[\s\S]*?<\/table>/)![0];
    expect(count(table, /<tr>/g)).toBe(1 + 5);
    expect(count(body, /<table/g)).toBe(1);
    // The panel is chartBox()'s frame, marked as a table (#4282).
    expect(body).toContain('<div class="chart-box is-table">');
  });
  test("heat strip draws days × kinds cells; each filled cell links to its rows", async () => {
    const body = await drawn("heat");
    expect(count(body, /<rect class="cell"/g)).toBe(9);
    const links = [...body.matchAll(/<a href="([^"]*)"><rect class="cell"/g)].map((m) => m[1]!.replaceAll("&amp;", "&"));
    expect(links.length).toBe(5);
    const check = links.find((l) => l.includes("gvalue=check"))!;
    expect(await listed(check)).toEqual(["m3", "m4"]);
  });
  test("an unknown chart falls back to line", async () => {
    expect(count(await drawn("pie"), /<circle cx="[^"]*" cy="[^"]*" r="4">/g)).toBe(3);
  });
  test("the chart is chosen beside the query", async () => {
    const body = await drawn("heat");
    expect(body).toMatch(/<select class="input" id="f-chart-\d+"\s+name="chart"/);
    expect(body).toMatch(/<option\s+value="heat"\s+selected\s*>\s*heat strip/);
    expect(body).toMatch(/<option\s+value="kind"\s+selected\s*>\s*split by kind/);
  });
});

describe("chart geometry", () => {
  // The plot is 648 × 204 (720 − 56 − 16 by 260 − 16 − 40), its top-left at (56, 16).
  test("bars: two slots of 324, bars 70% wide, heights in proportion", () => {
    const svg = barChart([{ label: "a", value: 1 }, { label: "b", value: 3 }], "t");
    // scale 204/3 = 68 per unit; slot centres 218 and 542; bar 226.8 wide.
    expect(svg).toContain('<rect class="bar" x="104.6" y="152" width="226.8" height="68">');
    expect(svg).toContain('<rect class="bar" x="428.6" y="16" width="226.8" height="204">');
  });
  test("stacked area: bands sit on the ones before them", () => {
    const cells = [
      { label: "t1", series: "a", value: 1 }, { label: "t1", series: "b", value: 2 },
      { label: "t2", series: "a", value: 3 }, { label: "t2", series: "b", value: 1 },
    ];
    const svg = stackedArea(cells, "t");
    // tallest stack 4 → y(v) = 220 − 51v; x is 56 and 704.
    expect(svg).toContain('d="M56 169 L704 67 L704 220 L56 220 Z"');
    expect(svg).toContain('d="M56 67 L704 16 L704 67 L56 169 Z"');
  });
  test("heat: opacity is 0.06 + 0.94 × value / largest", () => {
    const svg = heatStrip([
      { label: "t1", series: "a", value: 1 }, { label: "t1", series: "b", value: 2 },
      { label: "t2", series: "a", value: 3 },
    ], "t");
    const ops = [...svg.matchAll(/fill-opacity="([^"]*)"/g)].map((m) => m[1]);
    // a: 1/3 → 0.37, 3/3 → 1; b: 2/3 → 0.69, missing → 0.06
    expect(ops).toEqual(["0.37", "1", "0.69", "0.06"]);
  });
  test("past the cap the smallest series fold into other", () => {
    const g = gridOf([
      { label: "t", series: "big", value: 9 }, { label: "t", series: "mid", value: 5 }, { label: "t", series: "low", value: 1 },
    ], 2);
    expect(g.names).toEqual(["big", "other"]);
    expect(g.values).toEqual([[9], [6]]);
  });
  test("number with one point, and every type with none, still draws", () => {
    expect(numberChart([{ label: "x", value: 12345 }], "t")).toContain(">12.35k</text>");
    for (const c of CHARTS) expect(drawChart(c, [], "t")).toContain("No points");
  });
  test("every type escapes its labels and series", () => {
    const cells = [{ label: "<b>&", series: "<i>", value: 1, href: "/x?<z>" }];
    for (const c of CHARTS) {
      const out = drawChart(c, cells, "<t>");
      expect(out, c).not.toContain("<b>");
      expect(out, c).not.toContain("<i>");
      expect(out, c).not.toContain("<t>");
      expect(out, c).not.toContain("<z>");
    }
    expect(tableChart(cells, "t")).toContain("&lt;b&gt;&amp;");
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
