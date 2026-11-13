/** Home's figures row (#2871): the tiles, their links, studio words only, a sparkline of 24 points and one of 30 days of visitors (#3186). */
import { Database } from "bun:sqlite";
import { bugTables, reachTables } from "./helpers/reach-tables.ts";
import { NO_REACH, readReach } from "../src/flow/reach.ts";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createRepo as createRepoRow } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { id } from "../src/kernel/id.ts";
import { checkTime, kpiLines, sparkText, waitingWords } from "../src/flow/kpi_words.ts";
import { running } from "../src/kernel/version.ts";
import { components } from "../src/web/style/components.ts";
import { liveNow } from "../src/web/studio/kpi_row.ts";

const hours = (n: number) => Array.from({ length: 24 }, (_, i) => (i === 3 ? n : 0));

describe("home kpi row", () => {

  test("the live tile is the running commit, the same as /releases", () => {
    const prev = process.env["FORGE_COMMIT"];
    process.env["FORGE_COMMIT"] = "1234567abcdef";
    try {
      expect(liveNow()?.sha).toBe(running().commit!);
      expect(liveNow()?.sha).toBe("1234567abcdef");
    } finally {
      if (prev === undefined) delete process.env["FORGE_COMMIT"];
      else process.env["FORGE_COMMIT"] = prev;
    }
  });

  test("the note wraps into two reserved lines instead of cutting off on a phone", () => {
    const rule = (sel: string) => new RegExp(`\\${sel} \\{([^}]*)\\}`).exec(components)![1]!;
    expect(rule(".stat-note")).not.toContain("nowrap");
    expect(rule(".stat-note")).toContain("line-clamp: 2");
    expect(rule(".stat-note")).toContain("height: 36px");
    expect(rule(".stat")).toContain("height: 104px");
  });

  test("check time reads as a person would", () => {
    expect(checkTime(null)).toBe("—");
    expect(checkTime(45_000)).toBe("45s");
    expect(checkTime(3_720_000)).toBe("1h 02m");
  });
});

describe("the builders figure from the database", () => {
  test("counts running agent runs against the autonomous repositories' slots", async () => {
    const { Database } = await import("bun:sqlite");
    const db = new Database(":memory:");
    db.run("CREATE TABLE repo (autonomy TEXT, autonomy_slots INTEGER, default_branch TEXT, id TEXT)");
    db.run("CREATE TABLE run (id TEXT, kind TEXT, state TEXT, started_at TEXT, finished_at TEXT, serving_at TEXT, env TEXT, commit_oid TEXT, cost_usd REAL, created_at TEXT)");
    db.run("CREATE TABLE pull (carried INTEGER NOT NULL DEFAULT 0, merged_at TEXT, merged_oid TEXT, base_oid TEXT, base_branch TEXT, issue_id TEXT)");
    db.run("CREATE TABLE issue (id TEXT, repo_id TEXT, kind TEXT, state TEXT, created_at TEXT)");
    bugTables(db);
    reachTables(db);
    db.run("INSERT INTO repo VALUES ('autonomous', 3, 'main', 'a'), ('autonomous', 1, 'main', 'b'), ('off', 8, 'main', 'c')");
    db.run("INSERT INTO run (id, kind, state) VALUES ('1','agent','running'), ('2','agent','running'), ('3','agent','queued'), ('4','check','running')");
    const { readKpis } = await import("../src/flow/kpis.ts");
    expect(readKpis(db, new Date()).builders).toEqual({ running: 2, slots: 4, idle: null });
  });
});

describe("the terminal's figures", () => {
  const k = { landedHours: hours(6), landed: 6, live: { sha: "abcdef0123456", at: new Date().toISOString() }, builders: { running: 2, slots: 4, idle: null }, spend: { todayUsd: 12, ceilingUsd: 40 }, medianCheckMs: 185_000, backupAt: null, reach: NO_REACH };
  test("the same nine figures in the same words", () => {
    const lines = kpiLines(k, { sha: "abcdef0123456", since: "5m ago" });
    expect(lines).toHaveLength(9);
    expect(lines).toContain("Last off-box backup never, overdue");
    expect(lines[4]).toBe("Crew spend today $12 of $40");
    expect(kpiLines({ ...k, spend: { todayUsd: 0.4, ceilingUsd: null } }, null)[4]).toBe("Crew spend today $0.40, no forge ceiling");
    expect(lines[3]).toBe("Builders running 2 of 4");
    expect(kpiLines({ ...k, builders: { running: 0, slots: 0, idle: null } }, null)[3]).toBe("Builders running —, no slots set");
    expect(lines[0]).toContain("Shipped per hour 0.3");
    expect(lines[0]).toContain("6 changes in 24 h");
    expect(lines[1]).toContain("Live version abcdef0");
    expect(lines[2]).toBe("Median check time 3m 05s");
    expect(lines.join(" ")).not.toMatch(/commit|merge|branch|repositor|pull request/i);
  });
  test("the block sparkline has 24 cells, the busy hour tallest", () => {
    const s = sparkText(hours(4));
    expect([...s]).toHaveLength(24);
    expect(s[20]).toBe("█");
  });
});


describe("the spend figure from the database", () => {
  test("only today's agent runs count, not yesterday's", async () => {
    const { Database } = await import("bun:sqlite");
    const { readKpis } = await import("../src/flow/kpis.ts");
    const now = new Date("2026-10-19T15:00:00.000Z");
    const db = new Database(":memory:");
    db.run("CREATE TABLE repo (autonomy TEXT, autonomy_slots INTEGER, default_branch TEXT, id TEXT)");
    db.run("CREATE TABLE run (id TEXT, kind TEXT, state TEXT, started_at TEXT, finished_at TEXT, serving_at TEXT, env TEXT, commit_oid TEXT, cost_usd REAL, created_at TEXT)");
    db.run("CREATE TABLE pull (carried INTEGER NOT NULL DEFAULT 0, merged_at TEXT, merged_oid TEXT, base_oid TEXT, base_branch TEXT, issue_id TEXT)");
    db.run("CREATE TABLE issue (id TEXT, repo_id TEXT, kind TEXT, state TEXT, created_at TEXT)");
    bugTables(db);
    reachTables(db);
    db.run(
      `INSERT INTO run (id, kind, cost_usd, created_at) VALUES
        ('1','agent',5,'2026-10-19T00:00:00.000Z'), ('2','agent',7.5,'2026-10-19T14:00:00.000Z'),
        ('3','agent',100,'2026-10-18T23:59:59.000Z'), ('4','check',9,'2026-10-19T10:00:00.000Z')`,
    );
    expect(readKpis(db, now, { ceilingUsd: 40 }).spend).toEqual({ todayUsd: 12.5, ceilingUsd: 40, hitAt: null });
    expect(readKpis(db, now).spend).toEqual({ todayUsd: 12.5, ceilingUsd: null, hitAt: null });
  });
});


describe("the reach tiles", () => {

  test("the terminal draws the 30 days as one block per day", () => {
    const days = Array.from({ length: 30 }, (_, i) => (i === 29 ? 8 : 0));
    const reach = { usersToday: 0, usersTotal: 1, visitorsToday: 8, visitors7d: 8, visitorDays: days, loadP75: null, inpP75: null, lcpP75: null };
    const line = kpiLines({ landedHours: hours(0), landed: 0, live: null, backupAt: null, reach, medianCheckMs: null, builders: { running: 0, slots: 0, idle: null }, spend: { todayUsd: 0, ceilingUsd: null } }, null).find((l) => l.startsWith("Reporting browsers"))!;
    expect(line).toContain("▁".repeat(29) + "█");
  });

  test("the terminal says the same", () => {
    const lines = kpiLines({ landedHours: hours(0), landed: 0, live: null, backupAt: null, reach: { usersToday: 3, usersTotal: 12, visitorsToday: 5, visitors7d: 31, visitorDays: new Array<number>(30).fill(0), loadP75: 1250, inpP75: 180, lcpP75: 2400 }, medianCheckMs: null, builders: { running: 0, slots: 0, idle: null }, spend: { todayUsd: 0, ceilingUsd: null } }, null);
    expect(lines.find((l) => l.startsWith("Reporting browsers"))).toContain("Reporting browsers 5 today, 31 in 7 days");
    expect(lines).toContain("Accounts 3 of 12 seen today");
    expect(lines.find((l) => l.startsWith("Reporting browsers"))).toContain("▁".repeat(30));
    expect(lines).toContain("Reported page speed loads in 1.3 s, LCP 2.4 s · INP 180 ms");
  });
});

describe("the visitors sparkline", () => {
  test("is 30 points, oldest first, and ends at today", () => {
    const db = new Database(":memory:");
    reachTables(db);
    const NOW = new Date("2026-10-19T15:00:00.000Z");
    db.run("INSERT INTO page_vital (day, visitor) VALUES ('2026-10-19','a'),('2026-10-19','b'),('2026-10-19','a'),('2026-09-20','c'),('2026-09-19','old')");
    const r = readReach(db, NOW);
    expect(r.visitorDays).toHaveLength(30);
    expect(r.visitorDays[29]).toBe(2);
    expect(r.visitorDays[0]).toBe(1); // 2026-09-20 is 29 days back; 09-19 is out
    expect(r.visitorDays.reduce((a, b) => a + b, 0)).toBe(3);
  });
});

describe("readReach", () => {
  const NOW = new Date("2026-10-19T15:00:00.000Z");
  const make = async () => {
    const { Database } = await import("bun:sqlite");
    const db = new Database(":memory:");
    reachTables(db);
    return db;
  };
  const view = (db: import("bun:sqlite").Database, day: string, visitor: string, load: number | null, inp: number | null) =>
    db.run("INSERT INTO page_vital (day, visitor, load, inp) VALUES (?, ?, ?, ?)", [day, visitor, load, inp]);

  test("nothing seeded: zeros and no speed", async () => {
    expect(readReach(await make(), NOW)).toEqual(NO_REACH);
  });

  test("the 7-day window starts six days back; today is the UTC day", async () => {
    const db = await make();
    view(db, "2026-10-19", "a", 100, 10);
    view(db, "2026-10-13", "a", 100, 10); // first day inside
    view(db, "2026-10-12", "b", 9999, 9999); // one day outside
    const r = readReach(db, NOW);
    expect(r.visitorsToday).toBe(1);
    expect(r.visitors7d).toBe(2);
    expect(r.loadP75).toBe(100);
    // Just after midnight the same rows are a day older.
    expect(readReach(db, new Date("2026-10-20T00:00:01.000Z")).visitorsToday).toBe(0);
    expect(readReach(db, new Date("2026-10-20T00:00:01.000Z")).visitors7d).toBe(1);
  });

  test("p75 is nearest rank and skips nulls", async () => {
    const db = await make();
    for (const [i, v] of [10, 20, 30, 40, 50].entries()) view(db, "2026-10-19", `v${i}`, v, null);
    view(db, "2026-10-19", "n", null, 70);
    const r = readReach(db, NOW);
    expect(r.loadP75).toBe(40); // rank ceil(5 * .75) = 4
    expect(r.inpP75).toBe(70); // one value: itself
  });

  test("a visitor seen twice in a day counts once; accounts count distinct users since UTC midnight", async () => {
    const db = await make();
    view(db, "2026-10-19", "a", 1, 1);
    view(db, "2026-10-19", "a", 2, 2);
    db.run("INSERT INTO user VALUES ('u1'), ('u2'), ('u3')");
    db.run("INSERT INTO session VALUES ('u1', '2026-10-19T00:00:00Z'), ('u1', '2026-10-19T09:00:00Z'), ('u2', '2026-10-18T23:59:59Z')");
    const r = readReach(db, NOW);
    expect(r.visitorsToday).toBe(1);
    expect([r.usersToday, r.usersTotal]).toEqual([1, 3]);
  });
});

describe("home waiting line", () => {
  test("words: absent at zero, count and oldest hours otherwise", () => {
    const now = new Date("2026-10-21T12:00:00.000Z");
    expect(waitingWords(0, null, now)).toBeNull();
    expect(waitingWords(3, "2026-10-19T10:00:00.000Z", now)).toBe("3 waiting on you, oldest 2 days");
    expect(waitingWords(1, "2026-10-21T11:40:00.000Z", now)).toBe("1 waiting on you, oldest 20 minutes");
  });

  async function homeWith(stale: number[], title?: string, path = "/feed"): Promise<string> {
    const root = mkdtempSync(join(tmpdir(), "forge-home-wait-"));
    const app = createApp({ dataDir: root, port: 0 });
    const servers = await serve(app);
    try {
      const made = await createUser(app.db, { username: "alice", email: "alice@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
      if (!made.ok) throw new Error(made.error);
      const repo = await createRepoRow(app.db, app.reposRoot, { ownerId: made.value.id, name: "wait", visibility: "public", description: "wait" });
      if (!repo.ok) throw new Error(repo.error);
      stale.forEach((h, i) => {
        const issueId = id();
        const number = app.db.query<{ issue_seq: number }, [string]>("UPDATE repo SET issue_seq = issue_seq + 1 WHERE id = ?1 RETURNING issue_seq").get(repo.value.id)!.issue_seq;
        app.db
          .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', ?4, '', ?5, 'open', ?6)`)
          .run(issueId, repo.value.id, number, title ?? `Stale ${i}`, made.value.id, new Date(Date.now() - h * 3_600_000).toISOString());
        app.db
          .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id) VALUES (?1, 'main', ?2, ?3, ?3, ?4)`)
          .run(issueId, `b/${i}`, "0".repeat(40), repo.value.id);
      });
      const signin = await fetch(`${servers.url}/signin`, {
        method: "POST",
        headers: { origin: servers.url },
        body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
        redirect: "manual",
      });
      const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
      const review = await (await fetch(`${servers.url}/review`, { headers: { cookie } })).text();
      expect(review.split("<li").filter((r) => r.includes('class="row"')).length).toBe(stale.length);
      return await (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();
    } finally {
      await servers.stop();
      app.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("three asks show one line linking to /review", async () => {
    const body = await homeWith([30, 40, 50]);
    expect(body).toMatch(/<p class="small muted break stack stack-tight"><span>3 waiting on you, oldest 2 days<\/span><a href="\/review">Review them<\/a><\/p>/);
  }, 30_000);

  test("the home says it once, as the one line that needs the owner: the real count, the oldest in days, linking to /review", async () => {
    const body = await homeWith([30, 40, 50], undefined, "/");
    expect(body).toMatch(/<p class="hf-need"[^>]*role="status">[\s\S]*?<a href="\/review">3 waiting on you, oldest 2 days<\/a>/);
    expect(body).not.toContain(" h</a>");
    expect(body).not.toContain("Review them");
  }, 30_000);

  test("a 120-character title with no spaces: the line breaks, the link below, the title stays off home", async () => {
    const long = "x".repeat(120);
    const body = await homeWith([30], long);
    const line = body.slice(body.indexOf('<p class="small muted break'), body.indexOf("Review them</a></p>"));
    expect(line).toMatch(/^<p class="[^"]*\bbreak\b[^"]*\bstack\b/);
    expect(line).toContain('</span><a href="/review">');
    expect(line).not.toContain(long);
  }, 30_000);

  test("with none, the line is absent", async () => {
    const body = await homeWith([]);
    expect(body).not.toContain("waiting on you");
    expect(body).not.toContain('href="/review"');
  }, 30_000);
});

describe("the forge ceiling hit (#5798)", () => {
  const base = { landedHours: hours(0), landed: 0, live: null, backupAt: null, reach: NO_REACH, medianCheckMs: null, builders: { running: 0, slots: 0, idle: null } };

  test("under the cap there is no hit; with no cap both doors say no forge ceiling", () => {
    expect(kpiLines({ ...base, spend: { todayUsd: 5, ceilingUsd: null } }, null)[4]).toContain("no forge ceiling");
  });

  test("the hit time is when the run that crossed the cap was created", async () => {
    const { readKpis } = await import("../src/flow/kpis.ts");
    const db = new Database(":memory:");
    db.run("CREATE TABLE repo (autonomy TEXT, autonomy_slots INTEGER, default_branch TEXT, id TEXT)");
    db.run("CREATE TABLE run (id TEXT, kind TEXT, state TEXT, started_at TEXT, finished_at TEXT, serving_at TEXT, env TEXT, commit_oid TEXT, cost_usd REAL, created_at TEXT)");
    db.run("CREATE TABLE pull (carried INTEGER NOT NULL DEFAULT 0, merged_at TEXT, merged_oid TEXT, base_oid TEXT, base_branch TEXT, issue_id TEXT)");
    db.run("CREATE TABLE issue (id TEXT, repo_id TEXT, kind TEXT, state TEXT, created_at TEXT)");
    bugTables(db);
    reachTables(db);
    db.run(
      `INSERT INTO run (id, kind, cost_usd, created_at) VALUES
        ('a','agent',300,'2026-10-25T10:00:00.000Z'), ('b','agent',300,'2026-10-25T12:30:00.000Z'), ('c','agent',1,'2026-10-25T15:00:00.000Z')`,
    );
    const now = new Date("2026-10-25T20:00:00Z");
    expect(readKpis(db, now, { ceilingUsd: 600 }).spend.hitAt).toBe("2026-10-25T12:30:00.000Z");
    expect(readKpis(db, now, { ceilingUsd: 700 }).spend.hitAt).toBeNull();
    expect(readKpis(db, now).spend.hitAt).toBeNull();
  });
});
