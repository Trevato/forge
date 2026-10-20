/**
 * The map-and-home bench (#2715): p50/p95 and SQL statements per request for
 * `/map` and `/`, as the owner, as a signed-in stranger, and (for `/`) as an
 * anonymous visitor, on a fixture shaped like this forge on 2026-10-19.
 *
 *   bun run bench/map-home.ts            # the forge-sized fixture, 30 hits each
 *   bun run bench/map-home.ts --n 100    # more hits
 *
 * The fixture is not `bench/seed.ts`'s two thousand empty-of-plans repos:
 * the map's cost is the plan — open issues, the edges between them, the
 * runs in flight — so this one is shaped like the plan here. Read from the
 * forge's own API that day: 69 repositories, one carrying ~2,700 issues of
 * which 213 open and 20 open pulls, its graph 926 issues and 1,699 edges;
 * nine more with 27–68 open issues; the rest empty. A few private and a few
 * sealed, so the stranger's view is honestly smaller than the owner's.
 *
 * Everything here goes in as rows — no git history — because neither page
 * reads git for these lanes; repositories are still real bare repos, made
 * through core, so a path that does spawn git finds one.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { addCrew } from "../src/core/agents.ts";
import { createUser, type User } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { setLogLevel } from "../src/kernel/log.ts";
import { serve } from "../src/http/server.ts";
import { countStatements, measure, report, type Sample } from "./run.ts";

/** How big the fixture is. `FORGE_SIZE` is this forge; tests use a small one. */
export interface Shape {
  /** Repositories in all, the plans' included. */
  readonly repos: number;
  /** Issues ever filed on the big repository. */
  readonly bigIssues: number;
  /** Of them, open. */
  readonly bigOpen: number;
  /** Issues on the big repository that sit in its dependency graph. */
  readonly bigGraph: number;
  /** Edges in the big repository's graph. */
  readonly bigEdges: number;
  /** Open pulls on the big repository, each closing an open issue. */
  readonly bigPulls: number;
  /** Other repositories with a plan, and their open issues each. */
  readonly lanes: readonly number[];
  /** Of `lanes`, how many (from the end) are private. */
  readonly privateLanes: number;
  /** Sealed open issues on the big repository. */
  readonly sealed: number;
  /** Agent runs in flight on the big repository. */
  readonly runs: number;
  /** Comments per issue on the big repository. */
  readonly comments: number;
  /** Rows in the event outbox. */
  readonly events: number;
}

export const FORGE_SIZE: Shape = {
  repos: 69,
  bigIssues: 2_700,
  bigOpen: 213,
  bigGraph: 926,
  bigEdges: 1_699,
  bigPulls: 20,
  lanes: [68, 48, 38, 33, 30, 27, 2, 1, 1],
  privateLanes: 2,
  sealed: 3,
  runs: 5,
  comments: 4,
  events: 60_000,
};

export interface Fixture {
  readonly app: App;
  /** A session cookie for the site admin who owns the plans. */
  readonly ownerCookie: string;
  /** A session cookie for a signed-in account with no grant anywhere. */
  readonly strangerCookie: string;
  /** The owner's private lanes, by `owner/name`: what a stranger must never see. */
  readonly privateRepos: readonly string[];
}

const ZERO = "0".repeat(40);

/** Seed `shape` into a fresh forge at `dataDir`. */
export async function seedFixture(
  dataDir: string,
  shape: Shape,
): Promise<Fixture> {
  setLogLevel("error");
  const app = createApp({ dataDir, port: 0 });
  const db = app.db;

  const made = async (username: string, extra: object) => {
    const user = await createUser(db, {
      username,
      email: `${username}@forge.test`,
      // No password: sessions are minted directly, and argon2 across a dozen
      // accounts is the seed's whole cost, which the check machine's load scales.
      origin: "seed",
      trusted: true,
      ...extra,
    });
    if (!user.ok) throw new Error(`seed ${username}: ${user.error}`);
    return user.value;
  };
  const owner = await made("keeper", { isAdmin: true });
  const stranger = await made("passerby", {});
  const others: User[] = [];
  for (let i = 0; i < 8; i++) others.push(await made(`person${i}`, {}));
  const crew: User[] = [];
  for (const name of ["wrench", "compass", "plumb"]) {
    const agent = await createUser(db, {
      username: name,
      email: `${name}@forge.test`,
      agent: true,
      origin: "agent",
    });
    if (!agent.ok) throw new Error(`seed ${name}: ${agent.error}`);
    crew.push(agent.value);
  }

  const repo = async (
    ownerId: string,
    name: string,
    visibility: "public" | "private",
  ) => {
    const r = await createRepo(db, app.reposRoot, {
      ownerId,
      name,
      visibility,
      description: `Bench ${name}`,
    });
    if (!r.ok) throw new Error(`seed repo ${name}: ${r.error}`);
    for (const agent of crew) addCrew(db, r.value.id, agent.id, ownerId);
    return r.value;
  };

  const big = await repo(owner.id, "forge", "public");
  const lanes: Repo[] = [];
  for (let i = 0; i < shape.lanes.length; i++) {
    const isPrivate = i >= shape.lanes.length - shape.privateLanes;
    lanes.push(await repo(owner.id, `plan-${i}`, isPrivate ? "private" : "public"));
  }
  const empty: Repo[] = [];
  for (let i = 0; empty.length + lanes.length + 1 < shape.repos; i++) {
    const who = others[i % others.length]!;
    empty.push(await repo(who.id, `quiet-${i}`, i % 7 === 0 ? "private" : "public"));
  }

  const insertIssue = db.query(
    `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, sealed, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
  );
  const bumpSeq = db.query<{ issue_seq: number }, [string]>(
    "UPDATE repo SET issue_seq = issue_seq + 1 WHERE id = ?1 RETURNING issue_seq",
  );
  const insertEdge = db.query(
    "INSERT OR IGNORE INTO issue_dependency (issue_id, blocked_by_id, actor_id) VALUES (?1, ?2, ?3)",
  );
  const insertComment = db.query(
    `INSERT INTO comment (id, issue_id, author_id, body, kind, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'comment', ?5, ?5)`,
  );
  const insertPull = db.query(
    `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id)
     VALUES (?1, 'main', ?2, ?3, ?3, ?4)`,
  );
  const insertRun = db.query(
    `INSERT INTO run (id, repo_id, kind, issue_id, actor_id, state, reason)
     VALUES (?1, ?2, 'agent', ?3, ?4, ?5, 'assigned')`,
  );
  const insertEvent = db.query(
    "INSERT INTO event (id, kind, repo_id, actor_id, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  );

  const clock = Date.now() - shape.bigIssues * 60_000;
  const at = (i: number): string => new Date(clock + i * 60_000).toISOString();
  const file = (
    repoId: string,
    kind: "issue" | "pull",
    title: string,
    body: string,
    authorId: string,
    open: boolean,
    sealed: boolean,
    i: number,
  ): { issueId: string; number: number } => {
    const issueId = id();
    const number = bumpSeq.get(repoId)!.issue_seq;
    insertIssue.run(
      issueId,
      repoId,
      number,
      kind,
      title,
      body,
      authorId,
      open ? "open" : "closed",
      sealed ? 1 : 0,
      at(i),
    );
    return { issueId, number };
  };

  db.transaction(() => {
    // The big plan: the open issues first in the graph, the rest of the
    // graph the closed issues they waited on, every edge pointing back to
    // an earlier issue so the plan has no cycle.
    const openEvery = Math.max(1, Math.floor(shape.bigIssues / shape.bigOpen));
    const issues: { issueId: string; number: number; open: boolean }[] = [];
    let opened = 0;
    let sealed = 0;
    for (let i = 0; i < shape.bigIssues; i++) {
      const open = opened < shape.bigOpen && i % openEvery === openEvery - 1;
      if (open) opened++;
      const seal = open && sealed < shape.sealed && i > shape.bigIssues / 2;
      if (seal) sealed++;
      const filed = file(
        big.id,
        "issue",
        `${seal ? "Sealed report" : "Issue"} ${i}: ${TITLES[i % TITLES.length]}`,
        "What is wrong, and what done looks like.",
        crew[i % crew.length]!.id,
        open,
        seal,
        i,
      );
      issues.push({ ...filed, open });
      for (let c = 0; c < shape.comments; c++)
        insertComment.run(
          id(),
          filed.issueId,
          crew[(i + c) % crew.length]!.id,
          `Comment ${c}. ${LOREM}`,
          at(i),
        );
    }
    const open = issues.filter((i) => i.open);
    const closed = issues.filter((i) => !i.open);
    const graph = [
      ...open,
      ...closed.slice(-Math.max(0, shape.bigGraph - open.length)),
    ].sort((a, b) => a.number - b.number);
    let edges = 0;
    for (let k = 1; edges < shape.bigEdges && k < 8; k++) {
      for (let j = k; j < graph.length && edges < shape.bigEdges; j += 1) {
        if ((j * 7 + k) % 3 === 0) continue;
        insertEdge.run(graph[j]!.issueId, graph[j - k]!.issueId, owner.id);
        edges++;
      }
    }
    for (let p = 0; p < shape.bigPulls; p++) {
      const closes = open[p % open.length]!;
      const pull = file(
        big.id,
        "pull",
        `Pull ${p}`,
        `Closes #${closes.number}`,
        crew[p % crew.length]!.id,
        true,
        false,
        shape.bigIssues + p,
      );
      insertPull.run(pull.issueId, `crew/${p}`, ZERO, big.id);
    }
    for (let r = 0; r < shape.runs; r++) {
      const on = open[open.length - 1 - r];
      if (on === undefined) break;
      insertRun.run(
        id(),
        big.id,
        on.issueId,
        crew[r % crew.length]!.id,
        r % 2 === 0 ? "running" : "queued",
      );
    }

    // The smaller plans: a chain down each, one edge per two issues.
    lanes.forEach((lane, l) => {
      const filed = [];
      for (let i = 0; i < (shape.lanes[l] ?? 0); i++)
        filed.push(
          file(
            lane.id,
            "issue",
            `Plan ${l} step ${i}`,
            "",
            owner.id,
            true,
            false,
            i,
          ),
        );
      for (let i = 2; i < filed.length; i += 2)
        insertEdge.run(filed[i]!.issueId, filed[i - 2]!.issueId, owner.id);
    });

    const everywhere = [big, ...lanes, ...empty];
    const kinds = ["issue.opened", "issue.commented", "pull.opened", "push", "run.ok"];
    for (let e = 0; e < shape.events; e++)
      insertEvent.run(
        id(),
        kinds[e % kinds.length]!,
        everywhere[e % everywhere.length]!.id,
        crew[e % crew.length]!.id,
        JSON.stringify({ number: (e % 50) + 1 }),
        at(e % shape.bigIssues),
      );
  })();
  db.exec("ANALYZE");

  const cookie = (userId: string): string =>
    `forge_session=${createSession(db, userId).token}`;
  return {
    app,
    ownerCookie: cookie(owner.id),
    strangerCookie: cookie(stranger.id),
    privateRepos: lanes
      .filter((l) => l.visibility === "private")
      .map((l) => `${owner.username}/${l.name}`),
  };
}

/** The six cases #2715 names, measured over one served fixture. */
export async function benchMapHome(
  fixture: Fixture,
  iterations: number,
): Promise<Sample[]> {
  const counter = countStatements(fixture.app.db);
  const servers = await serve(fixture.app);
  const hit =
    (path: string, cookie?: string) =>
    async (): Promise<{ status: number; bytes: number }> => {
      const response = await fetch(`${servers.url}${path}`, {
        headers: cookie === undefined ? {} : { cookie },
        redirect: "manual",
      });
      const body = await response.arrayBuffer();
      return { status: response.status, bytes: body.byteLength };
    };
  const cases: [string, () => Promise<{ status: number; bytes: number }>][] = [
    ["GET /map  owner", hit("/map", fixture.ownerCookie)],
    ["GET /map  stranger", hit("/map", fixture.strangerCookie)],
    ["GET /map  anonymous", hit("/map")],
    ["GET /     owner", hit("/", fixture.ownerCookie)],
    ["GET /     stranger", hit("/", fixture.strangerCookie)],
    ["GET /     anonymous", hit("/")],
  ];
  const samples: Sample[] = [];
  try {
    for (const [name, run] of cases)
      samples.push(await measure(name, iterations, counter, run));
  } finally {
    servers.stop();
    counter.stop();
  }
  return samples;
}

/** `/map`'s Server-Timing phases, p50 and p95 in ms, over `iterations` warm hits. */
export async function benchMapPhases(
  fixture: Fixture,
  iterations: number,
): Promise<string> {
  const servers = await serve(fixture.app);
  const names = ["app", "session", "lanes", "layout", "render"];
  const rows: string[] = [
    "| `GET /map` phase | owner p50 | owner p95 | stranger p50 | stranger p95 |",
    "| ---------------- | --------: | --------: | -----------: | -----------: |",
  ];
  const stats = new Map<string, number[][]>();
  try {
    for (const cookie of [fixture.ownerCookie, fixture.strangerCookie]) {
      const seen = new Map<string, number[]>(names.map((n) => [n, []]));
      for (let i = 0; i < iterations + 1; i++) {
        const response = await fetch(`${servers.url}/map`, { headers: { cookie } });
        await response.arrayBuffer();
        if (i === 0) continue;
        const header = response.headers.get("server-timing") ?? "";
        for (const m of header.matchAll(/([a-z-]+);dur=([\d.]+)/g))
          seen.get(m[1]!)?.push(Number(m[2]));
      }
      for (const n of names) {
        const sorted = seen.get(n)!.sort((a, b) => a - b);
        const at = (p: number) =>
          sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))] ?? 0;
        stats.set(n, [...(stats.get(n) ?? []), [at(50), at(95)]]);
      }
    }
  } finally {
    servers.stop();
  }
  for (const n of names) {
    const [o, s] = stats.get(n)!;
    const label = n === "app" ? "total (`app`)" : `\`${n}\``;
    rows.push(
      `| ${label} | ${o![0]!.toFixed(1)} | ${o![1]!.toFixed(1)} | ${s![0]!.toFixed(1)} | ${s![1]!.toFixed(1)} |`,
    );
  }
  return rows.join("\n");
}

const TITLES = [
  "the map lays out by what waits for what",
  "home paints before the feed",
  "a sealed report stays sealed",
  "the crew parks what it cannot do",
  "checks run once per push",
];

const LOREM =
  "This is roughly what a real comment weighs: a paragraph of prose, a code span, and a link.";

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf("--n");
  const n = i === -1 ? 30 : Number(argv[i + 1]);
  const dir = mkdtempSync(join(tmpdir(), "forge-bench-map-"));
  try {
    const started = performance.now();
    const fixture = await seedFixture(dir, FORGE_SIZE);
    console.log(
      `seeded the forge-sized fixture in ${((performance.now() - started) / 1000).toFixed(1)} s`,
    );
    const samples = await benchMapHome(
      fixture,
      Number.isFinite(n) && n > 0 ? n : 30,
    );
    console.log(report(samples, argv.includes("--verbose")));
    console.log(
      `\n${await benchMapPhases(fixture, Number.isFinite(n) && n > 0 ? n : 30)}`,
    );
    fixture.app.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(0);
}
