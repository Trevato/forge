/**
 * `/search?q=a` on a forge of production's size (#11168, the last box of #11120).
 *
 * The fixture is `big-forge.ts`'s PRODUCTION (9,000 issues and 9,000 pulls in
 * one repository, with their runs, comments and events) plus REPOS more
 * repositories, public and private, every name, description and title holding
 * an `a`: the worst case for a one-letter query, which matches every row.
 *
 * The bound is read from the answer itself: each request's `Server-Timing`
 * `app` phase is under APP_BUDGET_MS, and its statement count is fixed, so a
 * read that grows with the rows (an N+1, an unbounded scan per repository)
 * fails here in every run. The phases are printed so a pull can show them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { bigForge, PRODUCTION } from "./helpers/big-forge.ts";
import { expectWork, parsePhases, requestStatements } from "./helpers/work.ts";

/** The release proof reads `/search?q=a` as degraded above this. */
const APP_BUDGET_MS = 300;
/** Repositories beside the forge's own: more than production holds. */
const REPOS = 1_000;
/** What one `/search?q=a` costs in SQL, whatever the size of the forge. */
const STATEMENT_CEILING = 40;

let app: App, servers: Servers, dir = "", cookie = "";

beforeAll(async () => {
  ({ app, dir } = bigForge(PRODUCTION));
  const db = app.db;
  db.transaction(() => {
    // Every conversation's title matches the one letter.
    db.run("UPDATE issue SET title = 'a change to area ' || number");
    db.run("INSERT INTO user (id, username, email, password_hash) VALUES ('ana', 'ana', 'ana@x.test', '')");
    for (let n = 1; n <= REPOS; n++)
      db.run(
        // Listed after the forge's own (repos list newest id first), which holds production's conversations.
        "INSERT INTO repo (id, owner_id, name, visibility, description, created_at) VALUES (?1, ?2, ?3, ?4, 'a repository about apps', ?5)",
        [`0${n}`, n % 2 === 0 ? "own" : "ana", `app-${n}`, n % 3 === 0 ? "private" : "public", new Date(Date.parse("2026-01-01T00:00:00Z") + n * 60_000).toISOString()],
      );
  })();
  servers = await serve(app);
  cookie = `forge_session=${createSession(db, "own").token}`;
}, 300_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  if (dir !== "") await rm(dir, { recursive: true, force: true });
});

const viewers: Array<[string, () => RequestInit]> = [
  ["signed out", () => ({})],
  ["signed in", () => ({ headers: { cookie } })],
];

describe("/search?q=a at production's size", () => {
  test("the fixture is production's size, and every row matches", () => {
    const n = (sql: string) => (app.db.query(sql).get() as { n: number }).n;
    expect(n("SELECT COUNT(*) AS n FROM issue WHERE kind = 'issue'")).toBe(PRODUCTION.issues);
    expect(n("SELECT COUNT(*) AS n FROM issue WHERE kind = 'pull'")).toBe(PRODUCTION.pulls);
    expect(n("SELECT COUNT(*) AS n FROM repo")).toBe(REPOS + 1);
    expect(n("SELECT COUNT(*) AS n FROM issue WHERE title LIKE '%a%'")).toBe(PRODUCTION.issues + PRODUCTION.pulls);
  });

  for (const [who, init] of viewers) {
    test(`${who}: the app phase is under ${APP_BUDGET_MS} ms and the statements are fixed`, async () => {
      const url = `${servers.url}/search?q=a`;
      // The first request warms what any page warms (statements, the session).
      await (await fetch(url, init())).text();
      const res = await fetch(url, init());
      const body = await res.text();
      expect(res.status).toBe(200);
      expect(body).toContain("Code is searched for 2 or more characters");
      // Titles are drawn with the letter marked, so the link is what is matched.
      expect(body).toMatch(/href="\/owner\/forge\/(issues|pulls?)\/\d+"/);
      const header = res.headers.get("server-timing") ?? "";
      console.log(`/search?q=a ${who}: ${header}`);
      const phases = parsePhases(header);
      const appMs = phases.find((p) => p.name === "app")?.ms;
      expect(appMs).toBeDefined();
      expect(appMs!).toBeLessThan(APP_BUDGET_MS);
      for (const name of ["repos", "issues", "apps", "render"])
        expect(phases.find((p) => p.name === name)?.ms ?? Infinity).toBeLessThan(APP_BUDGET_MS);
      expectWork(await requestStatements(app.db, url, init()), { max: STATEMENT_CEILING });
    }, 60_000);
  }
});
