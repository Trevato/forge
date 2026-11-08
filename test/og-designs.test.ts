/**
 * The map's and the audit's link-preview cards (src/web/og/map.ts,
 * audit.ts, graph.ts, score.ts): the thumbnail's scale and the policy
 * score match a hand calculation, the words and the critical path are the
 * map page's own, the findings come worst first — and over HTTP, a signed-out
 * unfurler is served only what a signed-out reader sees: no sealed issue
 * in a public plan, no private repository's plan or policy.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp as createForge, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp } from "../src/core/apps.ts";
import { addDependency, type Graph } from "../src/core/dependencies.ts";
import { createIssue, type Issue } from "../src/core/issues.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { THEMES } from "../src/design/themes.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { NO_MARKS, type Marks } from "../src/web/pages/map.ts";
import { auditInput, findings, type AuditRow } from "../src/web/og/audit.ts";
import { FIGURE_BOX, renderCard } from "../src/web/og/card.ts";
import { graphScale, graphSvg } from "../src/web/og/graph.ts";
import { graphFigure, mapInput, mapLines, mapStat } from "../src/web/og/map.ts";
import { percent, scoreSvg, scoreTone } from "../src/web/og/score.ts";

const T = THEMES.dark.tokens;

const issue = (n: number, state: "open" | "closed" = "open"): Issue =>
  ({
    id: `i${n}`,
    repoId: "r",
    number: n,
    title: `Issue ${n}`,
    state,
    kind: "issue",
    createdAt: `2026-01-${String(n).padStart(2, "0")}T00:00:00.000Z`,
  }) as unknown as Issue;
const edge = (blocker: number, blocked: number) => ({
  issueId: `i${blocked}`,
  blockedById: `i${blocker}`,
});
const graphOf = (issues: Issue[], edges: Graph["edges"]): Graph => ({
  issues,
  edges,
  held: [],
  unadopted: new Set(),
  structural: new Set(),
  deferred: new Map(),
});

function wellFormed(svg: string): void {
  expect(svg.startsWith("<svg")).toBe(true);
  expect(svg.endsWith("</svg>")).toBe(true);
  expect(svg).not.toContain("NaN");
  expect(svg).not.toContain("undefined");
}

describe("the map's thumbnail", () => {
  test("its scale is the smaller of the two fits, capped", () => {
    // 4 slots × 5 levels at the page's proportions (196 × 68, gaps 28 / 44):
    // 4·224 − 28 = 868 wide, 5·112 − 44 = 516 tall. The box is 360 × 330:
    // 360 / 868 = 0.41475…, 330 / 516 = 0.63953… — the width decides.
    expect(FIGURE_BOX).toEqual({ x: 760, y: 150, w: 360, h: 330 });
    expect(graphScale(4, 5, FIGURE_BOX)).toBeCloseTo(360 / 868, 9);
    // 1 × 9: 196 wide, 9·112 − 44 = 964 tall; 330 / 964 = 0.34232 decides.
    expect(graphScale(1, 9, FIGURE_BOX)).toBeCloseTo(330 / 964, 9);
    // One card would be 1.8× the page; it is held to 0.62.
    expect(graphScale(1, 1, FIGURE_BOX)).toBe(0.62);
  });

  // 1 → 3 → 5, 2 (closed) → 3, 4 → 5, and 6 on no edge.
  const graph = graphOf(
    [issue(1), issue(2, "closed"), issue(3), issue(4), issue(5), issue(6)],
    [edge(1, 3), edge(2, 3), edge(3, 5), edge(4, 5)],
  );
  const marks: Marks = {
    ...NO_MARKS,
    crew: new Map([["i1", "running"]]),
    waiting: new Set(["i4"]),
  };

  test("the card counts the page's words and draws the chain in the accent", () => {
    const card = mapInput("alice/engine", graph, marks);
    expect(card.kind).toBe("map");
    expect(card.title).toBe("alice/engine");
    // 1 working; 4 waiting on a pull; 6 ready (on no edge); 3 and 5 blocked; 2 done.
    expect(card.stat).toBe("1 ready · 1 working · 2 blocked · 1 waiting · 1 done");
    // Five open; the longest open chain is 1 → 3 → 5. Next skips 1, which
    // the crew is on, and 4, which a pull is for: 6 is what a free hand takes.
    expect(card.lines).toEqual(["5 open issues", "Critical path: 3 issues, #1 → #5", "Next: #6 Issue 6"]);
    const fig = card.figure;
    if (fig?.kind !== "graph") throw new Error("no graph");
    // Only the open chains are drawn: 6, on no edge, and 2, done, are counted, not drawn.
    expect(fig.nodes.length).toBe(4);
    expect(fig.levels).toBe(3);
    expect(fig.nodes.filter((n) => n.critical).length).toBe(3);
    expect(fig.edges.filter((e) => e.critical).length).toBe(2);
    expect(fig.edges.filter((e) => e.done).length).toBe(0);
    expect(fig.nodes.map((n) => n.word).toSorted()).toEqual(["blocked", "blocked", "waiting", "working"]);
    const svg = renderCard(card);
    wellFormed(svg);
    // Four cards in the figure, the two critical edges in the accent.
    const figure = svg.slice(svg.indexOf("<g>"), svg.indexOf("</g>"));
    expect(figure.match(/<rect /g)?.length).toBe(4);
    expect(figure.match(new RegExp(`<path [^>]*stroke="${T.accent}"`, "g"))?.length).toBe(2);
    expect(svg).not.toContain(">MAP<");
  });

  test("with nothing linked, the loose issues are drawn, four rows at most", () => {
    const loose = graphOf(
      Array.from({ length: 40 }, (_, i) => issue(i + 1)),
      [],
    );
    const words = new Map(loose.issues.map((i) => [i.id, "ready" as const]));
    const fig = graphFigure(loose, words, [])!;
    expect(fig.levels).toBe(4);
    expect(fig.nodes.length).toBe(4 * fig.width);
    expect(fig.nodes.length).toBeLessThan(40);
    expect(graphFigure(graphOf([], []), new Map(), [])).toBeUndefined();
    expect(graphSvg({ kind: "graph", width: 0, levels: 0, nodes: [], edges: [] }, FIGURE_BOX)).toBe("");
  });

  test("the lines say what is open, the chain still to go, and what is next", () => {
    expect(mapLines(0, [], undefined)).toEqual(["Nothing open: every issue on the map is done."]);
    expect(mapLines(1, [], { number: 4, title: "Ship it" })).toEqual([
      "1 open issue",
      "None waits on another",
      "Next: #4 Ship it",
    ]);
    const empty = mapInput("alice/empty", graphOf([], []), NO_MARKS);
    expect(empty.figure).toBeUndefined();
    expect(empty.stat).toBe("0 ready · 0 working · 0 blocked · 0 done");
    wellFormed(renderCard(empty));
  });

  test("a held pull counts as waiting; deferred and held cards are dashed", () => {
    expect(
      mapStat({ ready: 2, working: 0, blocked: 1, waiting: 1, held: 2, parked: 0, deferred: 0, done: 3 }),
    ).toBe("2 ready · 0 working · 1 blocked · 3 waiting · 3 done");
    const svg = graphSvg(
      {
        kind: "graph",
        width: 2,
        levels: 1,
        nodes: [
          { level: 0, slot: 0, word: "held", critical: false },
          { level: 0, slot: 1, word: "deferred", critical: false },
        ],
        edges: [],
      },
      FIGURE_BOX,
    );
    expect(svg.match(/stroke-dasharray/g)?.length).toBe(2);
  });

  test("a title can not break out of the card", () => {
    const svg = renderCard(mapInput(`</text><script>x</script>`, graph, marks));
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;/text&gt;");
  });
});

describe("the audit's score", () => {
  test("percent is held / of, rounded, and nothing to count is 0", () => {
    expect(percent(2, 4)).toBe(50);
    expect(percent(1, 3)).toBe(33); // 33.33…
    expect(percent(2, 3)).toBe(67); // 66.67…
    expect(percent(5, 4)).toBe(100);
    expect(percent(-1, 4)).toBe(0);
    expect(percent(0, 0)).toBe(0);
    expect(scoreTone(4, 4)).toBe("success");
    expect(scoreTone(1, 2)).toBe("attn");
    expect(scoreTone(1, 3)).toBe("danger");
  });

  test("the ring's arc is the share of its circumference", () => {
    const svg = scoreSvg({ kind: "score", held: 1, of: 4, caption: "c", tone: "danger" }, FIGURE_BOX);
    // r = min(360, 330 − 60) / 2 − 26 / 2 = 135 − 13 = 122; 2π·122 = 766.55…
    const circ = 2 * Math.PI * 122;
    expect(svg).toContain(`r="122"`);
    expect(svg).toContain(`stroke-dasharray="${Math.round((circ / 4) * 100) / 100} ${Math.round(circ * 100) / 100}"`);
    expect(svg).toContain(">25%<");
    expect(svg).toContain(`stroke="${T.danger}"`);
    // Nothing held: no arc at all, only the track.
    const none = scoreSvg({ kind: "score", held: 0, of: 4, caption: "c", tone: "danger" }, FIGURE_BOX);
    expect(none.match(/<circle/g)?.length).toBe(1);
  });
});

describe("the audit's findings", () => {
  const row = (name: string, over: Partial<AuditRow> = {}): AuditRow => ({
    name,
    standing: "sound",
    open: 0,
    problems: [],
    disobeys: false,
    ...over,
  });

  test("worst first: disobeys, unsound, most open, then the unread together", () => {
    const rows = [
      row("a/few", { open: 1 }),
      row("a/none", { standing: "unread" }),
      row("a/many", { open: 3 }),
      row("a/broken", { standing: "unsound", problems: ["roles is not a list"] }),
      row("a/liar", { disobeys: true }),
      row("a/none2", { standing: "unread" }),
    ];
    expect(findings(rows)).toEqual([
      "a/liar disobeys its contract",
      "a/broken: unsound — roles is not a list",
      "a/many: 3 doors open to anyone",
      "a/few: 1 door open to anyone",
      "2 apps have no contract.json",
    ]);
  });

  test("the score holds only sound apps that obey: 3 sound, one disobeying, one unread is 2 of 4", () => {
    const card = auditInput([
      row("a/one"),
      row("a/two", { open: 2 }),
      row("a/three", { disobeys: true }),
      row("a/four", { standing: "unread" }),
    ]);
    expect(card.kind).toBe("audit");
    expect(card.figure).toEqual({ kind: "score", held: 2, of: 4, caption: "2 of 4 apps hold", tone: "attn" });
    // Three findings at most: the disobeying app, the open doors, the unread one.
    expect(card.lines).toEqual([
      "a/three disobeys its contract",
      "a/two: 2 doors open to anyone",
      "a/four has no contract.json",
    ]);
    expect(card.stat).toBe("3 read · 2 doors open · 0 unsound · 1 unread");
    const svg = renderCard(card);
    wellFormed(svg);
    expect(svg).toContain(">50%<");
    expect(svg).not.toContain(">AUDIT<");
  });

  test("every app holding says so; no apps draws no ring", () => {
    expect(auditInput([row("a/one")]).lines).toEqual(["Every app holds its contract."]);
    expect(auditInput([row("a/one")]).figure).toMatchObject({ caption: "1 of 1 app holds", tone: "success" });
    const empty = auditInput([]);
    expect(empty.figure).toBeUndefined();
    expect(renderCard(empty)).not.toContain("<circle");
  });
});

describe("over HTTP", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-og-designs-"));
    app = createForge({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "alice-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    for (const [name, visibility, access] of [
      ["shown", "public", "public"],
      ["hidden", "private", "public"],
      ["quiet", "public", "private"],
    ] as const) {
      const made = await createRepo(app, u.value, { name, visibility });
      if (!made.ok) throw new Error(String(made.error));
      const rec = createApp(app.db, { repoId: made.value.id, slug: `${name}-app`, access });
      if (!rec.ok) throw new Error(rec.error);
    }
    const mk = (repo: string, title: string, sealed = false): Issue => {
      const r = getRepo(app.db, "alice", repo)!;
      const i = createIssue(app.db, { repoId: r.id, authorId: u.value.id, title, kind: "issue", sealed });
      if (!i.ok) throw new Error(String(i.error));
      return i.value;
    };
    // shown: #1 → #2, and #3, sealed, waits on #2 too.
    const one = mk("shown", "First");
    const two = mk("shown", "Second");
    const three = mk("shown", "A sealed report", true);
    addDependency(app.db, two, one, u.value.id);
    addDependency(app.db, three, two, u.value.id);
    const h1 = mk("hidden", "Private one");
    const h2 = mk("hidden", "Private two");
    addDependency(app.db, h2, h1, u.value.id);
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const get = (path: string, headers: Record<string, string> = {}) => fetch(base + path, { headers });

  test("a public repo's map is a card of only what a signed-out reader sees", async () => {
    const res = await get("/og/map/alice~shown.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/svg+xml");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{64}"$/);
    const svg = await res.text();
    wellFormed(svg);
    // The sealed #3 is neither counted nor drawn: two open, two cards.
    expect(svg).toContain(">2 open issues<");
    expect(svg).toContain("1 ready · 0 working · 1 blocked · 0 done");
    expect(svg).not.toContain("sealed");
    const figure = svg.slice(svg.indexOf("<g>"), svg.indexOf("</g>"));
    expect(figure.match(/<rect /g)?.length).toBe(2);
    const again = await get("/og/map/alice~shown.svg", { "if-none-match": res.headers.get("etag")! });
    expect(again.status).toBe(304);
  });

  test("a private repo's map, an unknown one and a malformed ref are the same 404", async () => {
    for (const ref of ["alice~hidden", "alice~nothing", "alice", "a~b~c", "..%2Fx"])
      expect((await get(`/og/map/${ref}.svg`)).status).toBe(404);
  });

  test("the audit reads the apps of public repos only, as the page does for someone signed out", async () => {
    const res = await get("/og/audit.svg");
    expect(res.status).toBe(200);
    const svg = await res.text();
    wellFormed(svg);
    // shown and quiet are public repos (a contract.json is as public as its
    // repo, whoever may reach the app); hidden's repo is private. Neither has
    // a contract, so 0 of 2 hold.
    expect(svg).toContain("2 apps have no contract.json");
    expect(svg).toContain(">0%<");
    expect(svg).toContain("0 of 2 apps hold");
    expect(svg).not.toContain("hidden");
  });

  test("the map page names its card only when the repo is public; the audit page always", async () => {
    const page = await (await get("/alice/shown/map")).text();
    expect(page).toContain(`content="${base}/og/map/alice~shown.png"`);
    expect(page).toContain(`content="summary_large_image"`);
    const audit = await (await get("/audit")).text();
    expect(audit).toContain(`content="${base}/og/audit.png"`);
    const home = await (await get("/")).text();
    expect(home).toContain(`content="${base}/og/site.png"`);
    expect(home).toContain(`content="summary_large_image"`);
  });
});
