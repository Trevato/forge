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
import { readPagePicture, type BoardsPicture, type FlowPicture, type PagesEnv } from "../src/flow/pages_read.ts";
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

const env = (inline: boolean): PagesEnv => ({ db: app.db, reposRoot: app.reposRoot, config: app.config, ceilingUsd: forgeCeiling(app.config), inline });

/** One job through a real worker, as the serving thread sends it. */
function ask(worker: Worker, id: number, job: PagesAsk["job"]): Promise<PagesAnswer> {
  return new Promise((resolve) => {
    worker.addEventListener("message", function heard(e: MessageEvent<PagesAnswer>) {
      if (e.data.id !== id) return;
      worker.removeEventListener("message", heard);
      resolve(e.data);
    });
    const config = Object.fromEntries(Object.entries(app.config).filter(([, v]) => typeof v !== "function")) as App["config"];
    worker.postMessage({ id, path: app.db.filename, reposRoot: app.reposRoot, config, ceilingUsd: null, job, learned: [] } satisfies PagesAsk);
  });
}

describe("the worker reads each page's picture on a handle of its own", () => {
  test("/boards: the figures, the outflow, the ready lists and the boards' own list come back as plain data", async () => {
    app.db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const worker = new Worker(new URL("../src/flow/pages_worker.ts", import.meta.url).href);
    try {
      const now = Date.now();
      const answer = await ask(worker, 1, { kind: "boards", viewer: "owner", now, boardsSince: 0 });
      expect(answer.error).toBeUndefined();
      const picture = answer.picture as BoardsPicture;
      expect(picture.at).toBe(now);
      expect(picture.boards.map((b) => b.board.title)).toContain("Mine");
      expect(picture.flow.stages.map((s) => s.key)).toContain("approved");
      expect(picture.fig.pile).toBeDefined();
      expect(picture.held.length).toBeGreaterThan(0);
      // It says what the thread would have read at that moment.
      const inline = await readPagePicture(env(true), { kind: "boards", viewer: "owner", now, boardsSince: 0 });
      expect(picture.fig.lead).toEqual(inline.fig.lead);
      expect(picture.held).toEqual(inline.held);
      expect(picture.flow.stages.map((s) => s.items.length)).toEqual(inline.flow.stages.map((s) => s.items.length));
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
    const first = await readPagePicture(kept, { kind: "boards", viewer: "owner", now: 1_000_000, boardsSince: 0 });
    expect(first.boards.map((b) => b.board.title)).toEqual(["Mine"]);
    expect((await makeBoard(app, seed.owner, "Second")).ok).toBe(true);
    // Inside the keep, with nothing said to have changed, the kept list serves: no git is asked.
    const same = await readPagePicture(kept, { kind: "boards", viewer: "owner", now: 1_001_000, boardsSince: 0 });
    expect(same.boards.map((b) => b.board.title)).toEqual(["Mine"]);
    const after = await readPagePicture(kept, { kind: "boards", viewer: "owner", now: 1_002_000, boardsSince: 1_001_500 });
    expect(after.boards.map((b) => b.board.title).sort()).toEqual(["Mine", "Second"]);
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
