/**
 * `/boards` and `/flow` draw from a picture a worker reads (`flow/pages.ts`,
 * `pages_read.ts`, `pages_worker.ts`): the worker answers a job with plain
 * data from a read-only handle of its own, what asks git is never waited for
 * (but for the boards' own list), and neither page's handler reads the pulls,
 * the runs or git itself.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { makeBoard } from "../src/actions/boards.ts";
import { createSession } from "../src/core/sessions.ts";
import { forgeCeiling } from "../src/flow/ceiling.ts";
import { boardsPicture, isFailed, usePagesReader } from "../src/flow/pages.ts";
import { readParams } from "../src/boards/params.ts";
import { pagesConfig, readBoardsPicture, readPagePicture, type BoardPicture, type BoardsPicture, type FlowPicture, type PagesEnv, type QueryPicture } from "../src/flow/pages_read.ts";
import type { PagesAnswer, PagesAsk } from "../src/flow/pages_worker.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedHomeFlow, type HomeFlowSeed } from "./helpers/home-flow-seed.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let seed: HomeFlowSeed;
let cookie = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-pages-"));
  app = createApp({ dataDir, port: 0 });
  seed = await seedHomeFlow(app);
  expect((await makeBoard(app, seed.owner, "Mine")).ok).toBe(true);
  servers = await serve(app);
  cookie = `forge_session=${createSession(app.db, seed.owner.id).token}`;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const env = (inline: boolean): PagesEnv => ({ db: app.db, reposRoot: app.reposRoot, config: pagesConfig(app.config), ceilingUsd: forgeCeiling(app.config), inline });

/** One job through a real worker, as the serving thread sends it. */
function ask(worker: Worker, id: number, job: PagesAsk["job"]): Promise<PagesAnswer> {
  return new Promise((resolve) => {
    worker.addEventListener("message", function heard(e: MessageEvent<PagesAnswer>) {
      if (e.data.id !== id) return;
      worker.removeEventListener("message", heard);
      resolve(e.data);
    });
    worker.postMessage({ id, path: app.db.filename, reposRoot: app.reposRoot, config: pagesConfig(app.config), ceilingUsd: null, job, learned: [] } satisfies PagesAsk);
  });
}

describe("the worker reads each page's picture on a handle of its own", () => {
  test("/boards: the figures, the outflow, the ready lists and the boards' own list come back as plain data", async () => {
    app.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const worker = new Worker(new URL("../src/flow/pages_worker.ts", import.meta.url).href);
    try {
      const now = Date.now();
      const answer = await ask(worker, 1, { kind: "boards", viewer: "owner", now, boardsSince: 0, out: null });
      expect(answer.error).toBeUndefined();
      const picture = answer.picture as BoardsPicture;
      expect(picture.at).toBe(now);
      expect(picture.boards.map((b) => b.board.title)).toContain("Mine");
      expect(picture.flow.stages.map((s) => s.key)).toContain("approved");
      expect(picture.fig.pile).toBeDefined();
      expect(picture.held.length).toBeGreaterThan(0);
      // It says what the thread would have read at that moment.
      const inline = await readBoardsPicture(env(true), { kind: "boards", viewer: "owner", now, boardsSince: 0, out: null });
      expect(picture.fig.lead).toEqual(inline.fig.lead);
      expect(picture.held).toEqual(inline.held);
      expect(picture.flow.stages.map((s) => s.day)).toEqual(inline.flow.stages.map((s) => s.day));
      // The items a stage let out cross only for the stage a reader asked to list: the rest are counts.
      expect(picture.flow.stages.every((s) => s.items.length === 0)).toBe(true);
      const listed = (await ask(worker, 3, { kind: "boards", viewer: "owner", now, boardsSince: 0, out: "approved" })).picture as BoardsPicture;
      const approved = listed.flow.stages.find((s) => s.key === "approved")!;
      expect(approved.items.length).toBe(approved.day);
      expect(approved.day).toBeGreaterThan(0);
      expect(listed.flow.stages.filter((s) => s.key !== "approved").every((s) => s.items.length === 0)).toBe(true);
      // What asks git for every open pull is not waited for: the first picture says it is not read yet.
      expect(picture.drifting).toBeNull();
      const flow = (await ask(worker, 2, { kind: "flow", userId: seed.owner.id, now })).picture as FlowPicture;
      expect(flow.pipes.valves.length).toBeGreaterThanOrEqual(0);
      expect(flow.approved.map((a) => a.repo).sort()).toEqual(["trevato/forge", "trevato/glue"]);
      // The crew forks' branches (two git commands a branch) are read behind the job, never inside it.
      expect(flow.unproposed).toBeNull();
    } finally {
      worker.terminate();
    }
  });

  test("a board changed since the kept list was read is read again before the next picture answers", async () => {
    const kept = env(false);
    const first = await readBoardsPicture(kept, { kind: "boards", viewer: "owner", now: 1_000_000, boardsSince: 0, out: null });
    expect(first.boards.map((b) => b.board.title)).toEqual(["Mine"]);
    expect((await makeBoard(app, seed.owner, "Second")).ok).toBe(true);
    // Inside the keep, with nothing said to have changed, the kept list serves: no git is asked.
    const same = await readBoardsPicture(kept, { kind: "boards", viewer: "owner", now: 1_001_000, boardsSince: 0, out: null });
    expect(same.boards.map((b) => b.board.title)).toEqual(["Mine"]);
    const after = await readBoardsPicture(kept, { kind: "boards", viewer: "owner", now: 1_002_000, boardsSince: 1_001_500, out: null });
    expect(after.boards.map((b) => b.board.title).sort()).toEqual(["Mine", "Second"]);
  });
});

describe("a board's panels and the data page's query are read, and a board's charts drawn, by the worker", () => {
  test("a board comes back as its file and every panel's markup; a board that is not there as null", async () => {
    const { writeBoard } = await import("../src/actions/boards.ts");
    const made = await writeBoard(app, seed.owner, "mine", { title: "Mine", range: "7d", refresh: "off", panels: [{ title: "Runs", chart: "line", query: { source: "runs", aggregate: "count", groupBy: { bucket: "day" } }, w: 1, h: 1 }] });
    expect(made.ok).toBe(true);
    app.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const worker = new Worker(new URL("../src/flow/pages_worker.ts", import.meta.url).href);
    try {
      const now = Date.now();
      const board = (await ask(worker, 1, { kind: "board", slug: "mine", now, boardsSince: 0 })).picture as BoardPicture;
      expect(board.board?.title).toBe("Mine");
      expect(board.panels).toHaveLength(1);
      const panel = board.panels[0]!;
      if (!panel.ok) throw new Error(panel.error);
      expect(panel.chart).toStartWith('<div class="chart" data-chart="line"');
      expect(typeof panel.latest).toBe("number");
      const none = (await ask(worker, 2, { kind: "board", slug: "nope", now, boardsSince: 0 })).picture as BoardPicture;
      expect(none.board).toBeNull();
      // The data page's answer comes back drawn: the chart, the table of its points, what stands out, each point's link.
      const params = (search: string) => readParams(new URLSearchParams(search));
      const query = (await ask(worker, 3, { kind: "query", params: params("chart=bar&source=runs&by=kind"), now })).picture as QueryPicture;
      if (!query.answer.ok) throw new Error(query.answer.error);
      expect(query.answer.points).toBe(3);
      expect(query.answer.chart).toStartWith('<div class="chart" data-chart="bar"');
      expect(query.answer.facts?.map((f) => f.label)).toEqual(["Groups", "Highest", "Lowest", "In all"]);
      expect(query.answer.table).toContain('gcolumn=kind&amp;gvalue=check"');
      expect(query.answer.linked).toBe(true);
      const refused = (await ask(worker, 4, { kind: "query", params: params("source=nope"), now })).picture as QueryPicture;
      expect(refused.answer.ok).toBe(false);
    } finally {
      worker.terminate();
    }
  });

  test("the board's page and the data page draw them, and answer ?wait=1 with nothing", async () => {
    const board = await fetch(`${servers.url}/boards/mine`, { headers: { cookie } });
    expect(board.status).toBe(200);
    expect(board.headers.get("server-timing")).toContain("picture;dur=");
    expect(await board.text()).toContain('<div class="chart-box"><div class="chart" data-chart="line"');
    expect((await fetch(`${servers.url}/boards/nope`, { headers: { cookie } })).status).toBe(404);
    for (const path of ["/boards/mine?wait=1", "/boards/data?source=runs&by=day&wait=1"]) {
      const wait = await fetch(`${servers.url}${path}`, { headers: { cookie } });
      expect(wait.status).toBe(204);
    }
    expect((await fetch(`${servers.url}/boards/mine?wait=1`)).status).toBe(404);
  });

  test("neither handler runs a query or asks git itself", () => {
    const imports = (file: string): string => readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("import ")).join("\n");
    expect(imports("src/web/pages/boards.ts")).not.toMatch(/\b(runFor|runQuery|listAllBoards|showBoard)\b/);
    expect(imports("src/web/pages/boards-view.ts")).not.toMatch(/\b(showBoard|listAllBoards|runQuery)\b/);
    // A panel's rows are read on the thread only for a direct caller: the page hands each panel in as drawn.
    expect(readFileSync("src/web/pages/boards-view.ts", "utf8")).toContain("drawPanel(app, board, p, { slug, index }, null, runFor, panels[index])");
  });
});

describe("a reading that fails is said, logged and tried again; it is never 'Reading…' for ever", () => {
  test("the worker is sent the two settings it reads, never the forge's whole settings (the decider and the mailer cannot cross)", () => {
    const real = { ...app.config, issueRunCap: 7, edgeToken: "secret", decider: { decide: () => "x" }, mailer: { send: async () => {} }, disk: () => ({ freeBytes: 1, totalBytes: 2 }) } as unknown as App["config"];
    // The whole settings cannot be posted: this is what left /boards and /flow on "Reading…" in production.
    expect(() => structuredClone(real)).toThrow();
    const sent = structuredClone(pagesConfig(real));
    expect(sent).toEqual({ dataDir: app.config.dataDir, issueRunCap: 7 });
    expect(readFileSync("src/flow/pages.ts", "utf8")).toContain("config: pagesConfig(app.config),");
  });

  test("a reader that fails once: the page says why with a way to try again, ?wait=1 names the reason, and the next request fills the page", async () => {
    let calls = 0;
    usePagesReader(async (a, job) => {
      if (++calls === 1) throw new Error("DataCloneError: The object can not be cloned.");
      return readPagePicture({ db: a.db, reposRoot: a.reposRoot, config: pagesConfig(a.config), ceilingUsd: null, inline: true }, job);
    });
    try {
      const first = await fetch(`${servers.url}/boards`, { headers: { cookie } });
      expect(first.status).toBe(200);
      const said = await first.text();
      expect(said).toContain("The forge could not read this page just now.");
      expect(said).toContain("DataCloneError: The object can not be cloned.");
      expect(said).toMatch(/<a class="btn" href="\/boards">Try again<\/a>/);
      expect(said).not.toContain("data-reading-src");
      expect(calls).toBe(1);
      // The failure is not kept as the answer: the next request reads again, and this one succeeds.
      const second = await fetch(`${servers.url}/boards`, { headers: { cookie } });
      expect(calls).toBe(2);
      const filled = await second.text();
      expect(filled).toContain('id="bottleneck"');
      expect(filled).not.toContain("could not read");
      // A reader that keeps failing: the wait request answers 503 with the reason, at once.
      usePagesReader(async () => {
        throw new Error("unable to open database file");
      });
      const wait = await fetch(`${servers.url}/flow?wait=1`, { headers: { cookie } });
      expect(wait.status).toBe(503);
      expect(wait.headers.get("x-forge-reading")).toBe("unable to open database file");
      const flow = await (await fetch(`${servers.url}/flow`, { headers: { cookie } })).text();
      expect(flow).toContain("unable to open database file");
      expect(flow).not.toContain("data-reading-src");
      const direct = await boardsPicture(app, "owner", "approved", 50);
      expect(isFailed(direct) && direct.failed).toBe("unable to open database file");
    } finally {
      usePagesReader(undefined);
    }
  });
});

describe("the pages draw the picture and read nothing heavy themselves", () => {
  test("/boards draws the boards, the figures and the folds from it", async () => {
    const res = await fetch(`${servers.url}/boards`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('href="/boards/mine"');
    expect(body).toContain('id="bottleneck"');
    expect(body).toContain('id="held"');
    expect(res.headers.get("server-timing")).toContain("picture;dur=");
  });

  test("/flow draws the week from it; ?wait=1 is the reading page's one request and answers with nothing", async () => {
    const res = await fetch(`${servers.url}/flow`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="flow-approved"');
    expect(res.headers.get("server-timing")).toContain("picture;dur=");
    for (const path of ["/flow?wait=1", "/boards?wait=1"]) {
      const wait = await fetch(`${servers.url}${path}`, { headers: { cookie }, redirect: "manual" });
      expect(wait.status).toBe(204);
      expect(await wait.text()).toBe("");
    }
    expect((await fetch(`${servers.url}/flow?wait=1`, { redirect: "manual" })).status).not.toBe(204);
  });

  test("neither handler imports a reader that walks history or asks git", () => {
    const heavy = /\b(readPipes|readClogView|cpuClosedPulls|readWaiting|readHandoverLists|readDrifts|driftingPulls|listAllBoards|cachedAlarms|firedAlarms|alarmUnproposed|systemFor)\b/;
    const imports = (file: string): string => readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("import ")).join("\n");
    for (const file of ["src/web/pages/flow.ts", "src/web/pages/boards-view.ts"]) expect(imports(file).match(heavy)?.[0], file).toBeUndefined();
    // The panel reads its figures on the thread only for a direct caller; a page always hands it the picture.
    expect(readFileSync("src/web/pages/boards-view.ts", "utf8")).toMatch(/flowPanel\(ctx\.app, \{ kind: "owner" \}, ctx\.url, "\/boards", \{ picture,/);
  });
});
