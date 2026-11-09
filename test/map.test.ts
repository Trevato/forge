/**
 * The map, per app and across the forge. Cards say one word each — ready,
 * working, blocked, done, parked, waiting — the layout keeps its curves
 * uncrossed where it can, the drawing is a live region, and `/map` is the
 * same drawing once per repository the viewer can see, at one scale, with
 * idle lanes folded. A lane is exactly the repository's own map, so what
 * the per-repo page says and what `/map` says never disagree.
 */
import { parseLane } from "../src/web/pages/global-map.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import {
  commitToBranch,
  createRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import { addDependency, type Graph } from "../src/core/dependencies.ts";
import { addComment, setIssueState, type Issue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import {
  crossings,
  layout,
  wrapTitle,
  type Layout,
} from "../src/web/pages/map.ts";
import { promote } from "./helpers/members.ts";
import { withScripts } from "./helpers/page-script.ts";

// ---- the layout, on paper ----

function paperIssue(n: number, state: "open" | "closed" = "open"): Issue {
  return {
    id: `i${n}`,
    repoId: "r",
    number: n,
    kind: "issue",
    title: `Issue ${n}`,
    body: "",
    authorId: "u",
    authorName: "u",
    state,
    createdAt: `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`,
    updatedAt: "2026-01-01T00:00:00Z",
    closedAt: null,
    closeReason: null,
    originAuthor: null,
    originUrl: null,
    assigneeId: null,
    assigneeName: null,
    assigneeIsAgent: false,
    authorIsAgent: false,
    sealed: false,
  };
}

/** `issue` waits for `blockedBy`, by number. */
function paperGraph(n: number, edges: [number, number][]): Graph {
  return {
    issues: Array.from({ length: n }, (_, i) => paperIssue(i + 1)),
    edges: edges.map(([issue, blockedBy]) => ({
      issueId: `i${issue}`,
      blockedById: `i${blockedBy}`,
    })),
    held: [],
    deferred: new Map(),
    unadopted: new Set(),
    structural: new Set(),
  };
}

/** The same levels, slots handed out by issue number: no ordering pass. */
function unordered(placed: Layout): Layout {
  const byLevel = new Map<number, typeof placed.nodes>();
  for (const n of placed.nodes)
    byLevel.set(n.level, [...(byLevel.get(n.level) ?? []), n]);
  const slot = new Map<string, number>();
  for (const list of byLevel.values())
    [...list]
      .sort((a, b) => a.issue.number - b.issue.number)
      .forEach((n, i) => slot.set(n.issue.id, i));
  return {
    ...placed,
    nodes: placed.nodes.map((n) => ({ ...n, slot: slot.get(n.issue.id)! })),
  };
}

describe("the layout", () => {
  test("the ordering pass never adds a crossing, and untangles a known braid", () => {
    // Three chains that, by number, would cross every which way: 3→4, 2→5,
    // 1→6 fan across the page; 7 waits for 6 and 4, 8 for 5.
    const braid = paperGraph(8, [
      [4, 3],
      [5, 2],
      [6, 1],
      [7, 6],
      [7, 4],
      [8, 5],
    ]);
    const placed = layout(braid);
    const before = crossings(braid, unordered(placed));
    const after = crossings(braid, placed);
    expect(before).toBeGreaterThan(0);
    expect(after).toBeLessThanOrEqual(before);
    expect(after).toBe(0);
    // Levels are what waits for what; slots are contiguous within a level.
    const at = (n: number) => placed.nodes.find((p) => p.issue.number === n)!;
    expect(at(1).level).toBe(0);
    expect(at(6).level).toBe(1);
    expect(at(7).level).toBe(2);
    for (let level = 0; level < 3; level++) {
      const slots = placed.nodes
        .filter((p) => p.level === level)
        .map((p) => p.slot)
        .sort((a, b) => a - b);
      expect(slots).toEqual(slots.map((_, i) => i));
    }
    expect(placed.islandFrom).toBe(3);
    expect(placed.levels).toBe(3);
  });

  test("a wider tangle comes out no worse than it went in, and the island sits below", () => {
    const wide = paperGraph(14, [
      [5, 4],
      [6, 3],
      [7, 2],
      [8, 1],
      [9, 8],
      [9, 5],
      [10, 7],
      [10, 6],
      [11, 9],
      [11, 10],
      [12, 5],
    ]);
    const placed = layout(wide);
    expect(crossings(wide, placed)).toBeLessThanOrEqual(
      crossings(wide, unordered(placed)),
    );
    const island = placed.nodes.filter((p) => p.island);
    expect(island.map((p) => p.issue.number)).toEqual([13, 14]);
    for (const p of island)
      expect(p.level).toBeGreaterThanOrEqual(placed.islandFrom);
    expect(placed.width).toBe(4);
  });

  test("a title takes two lines of whole words, then an ellipsis", () => {
    expect(wrapTitle("Extract renderer")).toEqual(["Extract renderer", null]);
    expect(
      wrapTitle(
        "Move the scene graph out of the renderer and into its own module",
      ),
    ).toEqual(["Move the scene graph out", "of the renderer and into…"]);
    expect(wrapTitle("Supercalifragilisticexpialidocious rename")).toEqual([
      "Supercalifragilisticexpia…",
      "rename",
    ]);
  });
});

// ---- the pages ----

describe("the map, per app and across the forge", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let bob: User;
  let engine: Repo;
  const engineIssues: Issue[] = [];

  const signIn = async (username: string): Promise<string> =>
    (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username,
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
  const person = async (username: string, admin = false): Promise<User> => {
    const made = await createUser(app.db, { origin: "seed", trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: admin,
    });
    if (!made.ok) throw new Error(made.error);
    promote(app.db, made.value);
    return made.value;
  };
  const repoOf = async (
    owner: User,
    name: string,
    titles: string[],
  ): Promise<{ repo: Repo; issues: Issue[] }> => {
    const made = await createRepo(app, owner, { name, visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    const issues = titles.map((title) => {
      const opened = openIssue(app, owner, made.value, { title });
      if (!opened.ok) throw new Error(String(opened.error));
      return opened.value;
    });
    return { repo: made.value, issues };
  };
  // Struck out: parked twice since anyone re-planned it, the rule that
  // stops dispatch (`crew/parks.ts`).
  const park = (by: User, issue: Issue): void => {
    for (let n = 0; n < 2; n++) {
      const said = addComment(app.db, {
        issueId: issue.id,
        authorId: by.id,
        body: "Parked by the crew: the check stayed red past its tries.",
      });
      if (!said.ok) throw new Error(said.error);
    }
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-map-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    alice = await person("alice", true);
    bob = await person("bob");
    await person("carol");

    // alice/engine: every word on one map.
    //   1 Extract renderer — scout is on it (working); 2 waits for it (blocked)
    //   3 Write the docs — on no edge (ready)
    //   4 Old bootstrap — closed, and 5 waited for it (done → ready)
    //   6 Physics step — an open pull closes it (waiting)
    //   7 Shader hot reload — the crew parked it (parked)
    const made = await repoOf(alice, "engine", [
      "Extract renderer",
      "Scene graph",
      "Write the docs",
      "Old bootstrap",
      "Input mapping",
      "Physics step",
      "Shader hot reload",
    ]);
    engine = made.repo;
    engineIssues.push(...made.issues);
    const issue = (n: number) => engineIssues[n - 1]!;
    expect(addDependency(app.db, issue(2), issue(1), alice.id).ok).toBe(true);
    expect(addDependency(app.db, issue(5), issue(4), alice.id).ok).toBe(true);
    expect(setIssueState(app.db, issue(4).id, "closed")).toBeDefined();
    const scout = await createAgent(app, alice, { username: "scout" });
    if (!scout.ok) throw new Error(String(scout.error));
    expect(addToCrew(app, alice, engine, "scout").ok).toBe(true);
    const scoutUser = getUserByName(app.db, "scout")!;
    const assigned = assignIssue(app, alice, engine, issue(1), scoutUser);
    if (!assigned.ok) throw new Error(String(assigned.error));
    const run = createRun(app.db, {
      repoId: engine.id,
      kind: "agent",
      issueId: issue(1).id,
      actorId: scoutUser.id,
      reason: "assigned",
    });
    expect(claimRun(app.db, run.id)).toBeDefined();
    const seeded = await commitToBranch(app, alice, engine, {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const branch = await commitToBranch(app, alice, engine, {
      branch: "feature/physics",
      base: "main",
      message: "Physics step",
      files: [{ path: "physics.ts", content: "export const step = 1;\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const pull = await openPull(app, alice, engine, {
      title: "Physics step",
      body: "Closes #6",
      baseBranch: "main",
      headBranch: "feature/physics",
    });
    if (!pull.ok) throw new Error(String(pull.error));
    park(scoutUser, issue(7));

    // alice/bare: a repository with nothing open and nobody working.
    await repoOf(alice, "bare", []);
    // alice/dormant: one open issue, parked, nobody on it — a lane that folds.
    const dormant = await repoOf(alice, "dormant", ["Rewrite the loader"]);
    park(alice, dormant.issues[0]!);
    // bob/secret: bob's own, which alice cannot see and bob can; assisted,
    // with no crew, so it has a ceiling its lane no longer draws.
    const secret = await repoOf(bob, "secret", ["Rotate the keys"]);
    const on = await updateRepoSettings(app, bob, secret.repo, {
      autonomy: "assisted",
      autonomyDirection: "Keep the keys fresh.",
      autonomyCeilingUsd: 10,
      autonomySlots: 1,
      autonomyBy: bob.id,
    });
    if (!on.ok) throw new Error(String(on.error));
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the counts line is §5 badges: every word and count present, the old name absent", async () => {
    const cookie = await signIn("alice");
    const page = await (
      await fetch(`${base}/alice/engine/map`, { headers: { cookie } })
    ).text();
    expect(page).not.toContain('class="map-counts"');
    expect(page).not.toMatch(/<[^>]*map-counts/);
    for (const w of ["ready", "working", "blocked", "done"])
      expect(page).toMatch(
        new RegExp(`class="badge"[^>]*data-state="${w}"[^>]*>${w} <b>\\d+</b></span>`),
      );
    expect(page).toContain('class="map-node"');
  });

  test("a card says its word, who is on it, and wears a ring while the crew works", async () => {
    const cookie = await signIn("alice");
    const page = await (
      await fetch(`${base}/alice/engine/map`, { headers: { cookie } })
    ).text();
    const card = (title: string) =>
      page.match(
        new RegExp(
          `<a[^>]*class="map-node"[^>]*>(?:(?!</a>)[\\s\\S])*${title}`,
        ),
      )?.[0] ?? "";
    expect(card("Extract renderer")).toContain('data-state="working"');
    expect(card("Extract renderer")).toContain('data-run="running"');
    expect(card("Extract renderer")).toContain('class="map-breath"');
    expect(card("Scene graph")).toContain('data-state="blocked"');
    expect(card("Write the docs")).toContain('data-state="ready"');
    // Done cards are drawn only on `?done=1` (#6174).
    expect(card("Old bootstrap")).toBe("");
    const withDone = await (
      await fetch(`${base}/alice/engine/map?done=1`, { headers: { cookie } })
    ).text();
    expect(
      withDone.match(
        /<a[^>]*class="map-node"[^>]*>(?:(?!<\/a>)[\s\S])*Old bootstrap/,
      )?.[0],
    ).toContain('data-state="done"');
    expect(card("Input mapping")).toContain('data-state="ready"');
    expect(card("Physics step")).toContain('data-state="waiting"');
    expect(card("Shader hot reload")).toContain('data-state="parked"');
    // Who: the assignee's initial and name on the card.
    expect(page).toContain('class="map-who-n"');
    expect(page).toMatch(/class="map-who-n"[^>]*>scout</);
    // The chain 1 → 2 is the critical path, in the accent.
    expect(page).toContain('class="map-edge map-edge-crit"');
    // The edge from a done issue recedes with it.
    expect(withDone).toContain('class="map-edge map-edge-done"');
    // The line under the drawing counts the words.
    expect(page).toMatch(
      /data-state="ready"[^>]*>ready <b>2<\/b><\/span>/,
    );
    expect(page).toMatch(
      /data-state="working"[^>]*>working <b>1<\/b><\/span>/,
    );
    expect(page).toMatch(
      /data-state="blocked"[^>]*>blocked <b>1<\/b><\/span>/,
    );
    expect(page).toMatch(
      /data-state="done"[^>]*>done <b>1<\/b><\/span>/,
    );
    expect(page).toMatch(
      /data-state="waiting"[^>]*>waiting <b>1<\/b><\/span>/,
    );
    expect(page).toMatch(
      /data-state="parked"[^>]*>parked <b>1<\/b><\/span>/,
    );
    // The lists beside it still read the graph; the critical path is the
    // accent on the canvas alone, and spend and flow live on their boards.
    expect(page).toContain("Ready now");
    expect(page).toContain("Blocked on");
    expect(page).not.toMatch(/class="[^"]*\bmap-list\b/);
    expect(page).not.toMatch(/class="[^"]*\bmap-empty\b/);
    expect(page).toContain('class="row-title"');
    expect(page).toContain("finishing it frees");
    expect(page).not.toContain("Critical path");
    expect(page).not.toContain("Two weeks");
    expect(page).not.toContain("map-autonomy");
  });

  test("the drawing is a live region scoped to its repository, fits, and pans", async () => {
    const cookie = await signIn("alice");
    const page = await (
      await fetch(`${base}/alice/engine/map`, { headers: { cookie } })
    ).text();
    const region = page.match(/<div[^>]*id="map-live"[^>]*>/)?.[0] ?? "";
    expect(region).toContain('data-live="run.queued,run.started,run.finished,issue.*,pull.*"');
    expect(region).toContain('data-live-repo="alice/engine"');
    // The canvas carries its size for the fit, and the tools for the rest.
    expect(page).toMatch(
      /<div[^>]*class="map-canvas"[^>]*id="map-canvas"[^>]*data-w="\d+"[^>]*data-h="\d+"/,
    );
    expect(page).toContain('data-map="fit"');
    expect(await withScripts(servers.url, page)).toContain("new EventSource('/events')");
    expect(await withScripts(servers.url, page)).toContain("forge:swapped");
    // A card is a link to its issue, so it takes keyboard focus.
    expect(page).toMatch(
      /<a[^>]*class="map-node"[^>]*href="\/alice\/engine\/issues\/1"/,
    );
    // The island is ruled off from the chains.
    expect(page).toContain("not linked");
  });

  test("the zoom tools are §5's bar and btn, found by data-map, not by the old names", async () => {
    const cookie = await signIn("alice");
    const page = await (
      await fetch(`${base}/alice/engine/map`, { headers: { cookie } })
    ).text();
    // Neither the markup nor the stylesheet holds the old names (#5251 retired the rules).
    const styles = (page.match(/<style[\s\S]*?<\/style>/g) ?? []).join("");
    expect(styles).toContain(".map-canvas");
    expect(styles).not.toMatch(/\.map-tools?\b/);
    const markup = page.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "");
    expect(markup).not.toMatch(/class="[^"]*\bmap-tools?\b/);
    const group = markup.match(/<div[^>]*role="group"[^>]*aria-label="Zoom"[^>]*>/)?.[0] ?? "";
    expect(group).toMatch(/class="bar js-only"/);
    for (const what of ["out", "fit", "in"]) {
      expect(markup).toMatch(
        new RegExp(`<button[^>]*class="btn[^"]*"[^>]*data-map="${what}"`),
      );
    }
    expect(markup).toContain('aria-label="Zoom out"');
    expect(markup).toContain('aria-label="Zoom in"');
    expect(markup).toContain("Fit the map to view.");
    expect(markup).toMatch(/data-map="fit"[^>]*>\s*fit\s*</);
    expect(markup).toMatch(/data-map="out"[^>]*>\s*−\s*</);
    expect(markup).toMatch(/data-map="in"[^>]*>\s*\+\s*</);
  });

  test("a person sees a lane for each repository they can read, idle lanes folded, at one scale", async () => {
    const cookie = await signIn("alice");
    const page = await (
      await fetch(`${base}/map`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
      })
    ).text();
    expect(page).toContain("<h1>Map</h1>");
    expect(page).toMatch(
      /<div[^>]*id="lanes"[^>]*data-live="run\.queued,run\.started,run\.finished,issue\.\*,pull\.\*"/,
    );
    // A lane is a §5 list row that folds: its <li> and its <details>.
    const lane = (id: string) =>
      page.match(new RegExp(`<li[^>]*>\\s*<details[^>]*id="${id}"[^>]*>`))?.[0] ??
      "";
    // engine has the crew on it: open, with who is working in its header.
    expect(lane("lane-alice-engine")).toMatch(/\sopen\s*>/);
    expect(lane("lane-alice-engine")).not.toContain("data-idle");
    expect(page).toContain('href="/alice/engine/map"');
    expect(page).toContain("Extract renderer");
    expect(page).toMatch(
      /title="Working: s[^"]*"[^>]*>[\s\S]*?class="avatar"[^>]*>s</,
    );
    expect(page).toContain('data-autonomy="off"');
    // dormant has nothing ready and nobody working: it folds to its header.
    expect(lane("lane-alice-dormant")).toContain('data-idle="1"');
    expect(lane("lane-alice-dormant")).not.toMatch(/\sopen\s*>/);
    expect(page).toMatch(
      /data-state="parked"[^>]*>parked <b>1<\/b><\/span>/,
    );
    // The lanes are §5's list and rows, not a page-local component (#3651).
    expect(page).toMatch(/id="lanes"[^>]*>\s*<div\s+class="card"[^>]*>\s*<ul class="list">/);
    expect(page).toMatch(/<details[^>]*id="lane-alice-engine"[^>]*>\s*<summary\s+class="row"/);
    for (const gone of ["map-lane", "map-lane-caret", "map-lane-crew", "map-lane-head", "map-lane-name", "map-lane-word", "map-lanes"])
      expect(page).not.toContain(gone);
    // The first screen draws no graph; a lane's comes when asked for, at one
    // scale: every lane drawn is the widest lane's width.
    expect(page).not.toContain('class="map-canvas"');
    expect(page).toContain('href="/map?lane=alice/engine#lane-alice-engine"');
    const widths = [] as (string | undefined)[];
    for (const lane of ["alice/engine", "alice/dormant", "bob/secret"]) {
      const drawn = await (
        await fetch(`${base}/map?lane=${lane}`, { headers: { cookie } })
      ).text();
      widths.push(
        ...[...drawn.matchAll(/class="map-canvas"[^>]*data-w="(\d+)"/g)].map((m) => m[1]),
      );
    }
    expect(widths.length).toBeGreaterThanOrEqual(3);
    expect(new Set(widths).size).toBe(1);
    // The same card words as the repository's own map.
    const engine = await (
      await fetch(`${base}/map?lane=alice/engine`, { headers: { cookie } })
    ).text();
    expect(engine).toContain('data-state="working"');
    expect(engine).toContain('data-run="running"');
    // A repository with nothing to draw is not a lane.
    expect(page).not.toContain('href="/alice/bare/map"');
    // The forge's admin reads every repository, so bob's is a lane here,
    // saying its mode; today's spend is the board's, not the lane's …
    expect(page).toContain('href="/bob/secret/map"');
    expect(page).toContain('data-autonomy="assisted"');
    expect(page).not.toContain("map-spend");
    expect(page).not.toContain("$0.00 of $10");

    // … and bob, who is nobody's admin, sees his own and not alice's.
    const bobs = await (
      await fetch(`${base}/map`, { headers: { cookie: await signIn("bob") } })
    ).text();
    expect(bobs).toContain('href="/bob/secret/map"');
    expect(bobs).toContain("Rotate the keys");
    expect(bobs).not.toContain("alice/engine");
    expect(bobs).not.toContain("Extract renderer");
  });

  test("the first screen is small and fast, names the next things, and leaves the graphs to ask for (#8693)", async () => {
    const cookie = await signIn("alice");
    const res = await fetch(`${base}/map`, { headers: { cookie } });
    const page = await res.text();
    expect(new TextEncoder().encode(page).length).toBeLessThan(50_000);
    expect(page).not.toContain('class="map-canvas"');
    const next = page.slice(page.indexOf("<h2>Next</h2>"), page.indexOf('id="lanes"'));
    expect(next).toContain("Extract renderer");
    expect((next.match(/<li/g) ?? []).length).toBeLessThanOrEqual(5);
    // Asking for a lane draws it, and only it.
    const one = await (
      await fetch(`${base}/map?lane=alice/engine`, { headers: { cookie } })
    ).text();
    expect((one.match(/class="map-canvas"/g) ?? []).length).toBe(1);
    // The row says how to draw it, or how to go back; the lane's own map is linked.
    expect(page).toContain(">Draw ");
    expect(one).toContain(">Show fewer</a>");
    expect(page).toContain('href="/alice/engine/map"');
    // The lane names are checked at the boundary: unknown, odd and long ones draw nothing.
    for (const bad of ["nobody/nothing", "alice", "../etc/passwd", "a/b/c", `${"x".repeat(300)}/y`, "alice/engine%00"]) {
      const res = await fetch(`${base}/map?lane=${encodeURIComponent(bad)}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain('class="map-canvas"');
    }
    expect(parseLane("alice/engine")).toBe("alice/engine");
    expect(parseLane("alice")).toBeUndefined();
    expect(parseLane(null)).toBeUndefined();
  });

  test("a stranger's first screen and lane asks never name or draw a private lane (#8693)", async () => {
    const carol = await signIn("carol");
    for (const path of ["/map", "/map?lane=bob/secret", "/map?lane=alice/engine"]) {
      const text = await (await fetch(`${base}${path}`, { headers: { cookie: carol } })).text();
      expect(text).not.toContain("Rotate the keys");
      expect(text).not.toContain("bob/secret");
      expect(text).not.toContain('class="map-canvas"');
    }
    const bob = await signIn("bob");
    const text = await (await fetch(`${base}/map?lane=alice/engine`, { headers: { cookie: bob } })).text();
    expect(text).not.toContain("Extract renderer");
  });

  test("an empty map is §5's empty state, with the words and the way on", async () => {
    const { drawMap, layout } = await import("../src/web/pages/map.ts");
    const graph = { issues: [], edges: [] } as unknown as Graph;
    const out = String(
      drawMap({ ownerName: "a", name: "b" } as Repo, graph, layout(graph), {} as never, {
        id: "x",
        empty: { title: "Nothing yet", note: "Say one." },
      }),
    );
    expect(out).toContain('class="empty"');
    expect(out).toContain("Nothing yet");
    expect(out).toContain("Say one.");
    expect(out).not.toContain("map-empty");
  });

  test("nothing to draw anywhere is one quiet sentence; a stranger is sent to sign in", async () => {
    const page = await (
      await fetch(`${base}/map`, { headers: { cookie: await signIn("carol") } })
    ).text();
    expect(page).toContain("Nothing to map");
    expect(page).not.toContain('id="lane-');
    expect(page).not.toContain("No open issues to map");

    const anonymous = await fetch(`${base}/map`, { redirect: "manual" });
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toContain("/signin");
  });

  test("the map is reached from the user menu and the palette on both homes", async () => {
    const cookie = await signIn("alice");
    for (const mode of ["studio", "dev"]) {
      const home = await (
        await fetch(`${base}/`, {
          headers: { cookie: `${cookie}; forge_mode=${mode}` },
        })
      ).text();
      expect(home).toContain('href="/map"');
      expect(home).toContain('"t":"Map","h":"/map"');
    }
  });

  test("the data keeps its shape and gains the words: one entry per visible repository", async () => {
    const token = createToken(app.db, alice.id, "test", "rw").token;
    const res = await fetch(`${base}/api/v1/map`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      repos: {
        repo: { owner: string; name: string };
        autonomy: string;
        spentTodayUsd: number | null;
        ceilingUsd: number | null;
        inFlight: number;
        workers: string[];
        idle: boolean;
        issues: {
          number: number;
          title: string;
          state: string;
          word: string;
        }[];
        ready: { number: number; holdsUp: number }[];
        blockedOn: { number: number; holdsUp: number; waitsFor: number }[];
        critical: number[];
        working: number[];
        counts: Record<string, number>;
        edges: { issue: number; blockedBy: number }[];
      }[];
    };
    const names = data.repos.map((r) => `${r.repo.owner}/${r.repo.name}`);
    expect(names).toContain("alice/engine");
    expect(names).toContain("alice/dormant");
    expect(names).toContain("bob/secret");
    expect(names).not.toContain("alice/bare");
    const lane = data.repos.find((r) => r.repo.name === "engine")!;
    // The fields the crew already reads, unchanged.
    expect(lane.issues.map((i) => i.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(lane.ready.map((r) => r.number)).toEqual([1, 3, 5, 6, 7]);
    expect(lane.blockedOn.map((r) => r.number)).toEqual([1]);
    expect(lane.critical).toEqual([1, 2]);
    expect(lane.edges).toEqual([
      { issue: 2, blockedBy: 1 },
      { issue: 5, blockedBy: 4 },
    ]);
    expect(lane.working).toEqual([1]);
    expect(lane.autonomy).toBe("off");
    expect(lane.spentTodayUsd).toBeNull();
    expect(lane.inFlight).toBe(1);
    // And the words, per issue and counted.
    expect(
      Object.fromEntries(lane.issues.map((i) => [i.number, i.word])),
    ).toEqual({
      1: "working",
      2: "blocked",
      3: "ready",
      4: "done",
      5: "ready",
      6: "waiting",
      7: "parked",
    });
    expect(lane.counts).toEqual({
      ready: 2,
      working: 1,
      blocked: 1,
      deferred: 0,
      done: 1,
      parked: 1,
      waiting: 1,
      held: 0,
    });
    expect(lane.workers).toEqual(["scout"]);
    expect(lane.idle).toBe(false);
    const dormant = data.repos.find((r) => r.repo.name === "dormant")!;
    expect(dormant.idle).toBe(true);
    expect(dormant.workers).toEqual([]);
    const secret = data.repos.find((r) => r.repo.name === "secret")!;
    expect(secret.ceilingUsd).toBe(10);
    expect(secret.spentTodayUsd).toBe(0);

    // The per-repo data says the same.
    const own = (await (
      await fetch(`${base}/api/v1/repos/alice/engine/map`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { working: number[]; counts: Record<string, number> };
    expect(own.working).toEqual([1]);
    expect(own.counts).toEqual(lane.counts);

    // A stranger's token sees only what a stranger can: nothing private.
    const bobToken = createToken(app.db, bob.id, "test", "ro").token;
    const bobs = (await (
      await fetch(`${base}/api/v1/map`, {
        headers: { authorization: `Bearer ${bobToken}` },
      })
    ).json()) as { repos: { repo: { owner: string } }[] };
    expect(bobs.repos.map((r) => r.repo.owner)).toEqual(["bob"]);
  });
});
