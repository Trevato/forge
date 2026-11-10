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
import { kpiRowFor, liveNow, sparkline } from "../src/web/studio/kpi_row.ts";

const hours = (n: number) => Array.from({ length: 24 }, (_, i) => (i === 3 ? n : 0));

describe("home kpi row", () => {
  test("five tiles with their links and figures", () => {
    const out = kpiRowFor(
      { landedHours: hours(6), landed: 6, live: null, builders: { running: 2, slots: 4, idle: null }, spend: { todayUsd: 0, ceilingUsd: null }, medianCheckMs: 185_000, backupAt: null, reach: NO_REACH },
      { sha: "abcdef0123456", at: "2026-10-19T11:00:00.000Z" },
    ).toString();
    expect(out).toContain('<span class="sha">abcdef0</span>');
    expect(out).toContain("Shipped per hour");
    expect(out).toContain("0.3");
    expect(out).toContain("6 changes in 24 h");
    expect(out).toContain("abcdef0");
    expect(out).not.toContain(">abcdef01"); // shortened on screen; the whole id is in the title
    expect(out).toContain("3m 05s");
    for (const href of ["/board", "/releases", "/boards"]) expect(out).toContain(`href="${href}"`);
  });

  test("the whole figure is in the title and the link's label, rounded and in studio words", () => {
    const out = kpiRowFor(
      { landedHours: hours(7), landed: 7, live: null, builders: { running: 2, slots: 4, idle: null }, spend: { todayUsd: 0, ceilingUsd: null }, medianCheckMs: 185_000, backupAt: null, reach: NO_REACH },
      { sha: "abcdef0123456", at: "2026-10-19T11:00:00.000Z" },
    ).toString();
    expect(out).toContain('title="0.29"');
    expect(out).not.toContain("0.2916");
    expect(out).toContain('title="3m 05s"');
    expect(out).not.toContain(" ms");
    expect(out).toContain('aria-label="Live version: abcdef0123456, Live since 2026-10-19T11:00:00.000Z. The version this forge process is running');
    expect(out).toContain('aria-label="Shipped per hour: 0.29, 7 changes in 24 h. Changes shipped');
  });

  test("empty figures say so", () => {
    const out = kpiRowFor({ landedHours: hours(0), landed: 0, live: null, builders: { running: 2, slots: 4, idle: null }, spend: { todayUsd: 0, ceilingUsd: null }, medianCheckMs: null, backupAt: null, reach: NO_REACH }, null).toString();
    expect(out).toContain("Nothing live yet");
    expect(out).toContain("No check finished in 24 h");
  });

  test("no git words render, not even in a title or label", () => {
    const out = kpiRowFor({ landedHours: hours(1), landed: 1, live: null, builders: { running: 2, slots: 4, idle: null }, spend: { todayUsd: 0, ceilingUsd: null }, medianCheckMs: 1000, backupAt: null, reach: NO_REACH }, null).toString();
    expect(out).not.toMatch(/commit|merge|branch|repositor|pull request|checks (passed|failed)/i);
  });

  test("the sparkline has one point per hour, oldest first", () => {
    const svg = sparkline(hours(4)).toString();
    const pts = /points="([^"]+)"/.exec(svg)![1]!.split(" ");
    expect(pts).toHaveLength(24);
    expect(pts[20]!.endsWith(",2.0")).toBe(true); // hour 3 ago is index 20, at the top
  });

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

  test("a truncated note carries its whole text as a title", () => {
    const out = kpiRowFor({ landedHours: hours(0), landed: 0, live: null, builders: { running: 2, slots: 4, idle: null }, spend: { todayUsd: 0, ceilingUsd: null }, medianCheckMs: null, backupAt: null, reach: NO_REACH }, null).toString();
    expect(out).toContain('title="No check finished in 24 h"');
  });

  test("the note wraps into two reserved lines instead of cutting off on a phone", () => {
    const rule = (sel: string) => new RegExp(`\\${sel} \\{([^}]*)\\}`).exec(components)![1]!;
    expect(rule(".stat-note")).not.toContain("nowrap");
    expect(rule(".stat-note")).toContain("line-clamp: 2");
    expect(rule(".stat-note")).toContain("height: 36px");
    expect(rule(".stat")).toContain("height: 104px");
  });

  test("the builders tile says running of slots, titles it, and links to the crew", () => {
    const out = kpiRowFor({ landedHours: hours(0), landed: 0, live: null, backupAt: null, reach: NO_REACH, medianCheckMs: null, builders: { running: 2, slots: 4, idle: null }, spend: { todayUsd: 0, ceilingUsd: null } }, null).toString();
    expect(out).toContain('href="/settings/crew"');
    expect(out).toContain('class="stat-value num" title="2 of 4">2 of 4<');
    expect(out).toContain('title="Agent runs running now, of the slots set on projects whose autonomy is on. 4 slots set."');
    expect(out).toContain('aria-label="Builders running: 2 of 4, Agent runs running now, of the slots set on projects whose autonomy is on. 4 slots set."');
  });

  test("with no slots set the builders tile shows a dash and says so", () => {
    const out = kpiRowFor({ landedHours: hours(0), landed: 0, live: null, backupAt: null, reach: NO_REACH, medianCheckMs: null, builders: { running: 0, slots: 0, idle: null }, spend: { todayUsd: 0, ceilingUsd: null } }, null).toString();
    expect(out).toContain('class="stat-value num" title="—">—<');
    expect(out).toContain('title="No slots set">No slots set<');
    expect(out).toContain(`aria-label="Builders running: —, No slots set"`);
    expect(out).not.toContain("Builders running: 0 of 0");
  });

  test("the builders note does not repeat the value", () => {
    const out = kpiRowFor({ landedHours: hours(0), landed: 0, live: null, backupAt: null, reach: NO_REACH, medianCheckMs: null, builders: { running: 2, slots: 4, idle: null }, spend: { todayUsd: 0, ceilingUsd: null } }, null).toString();
    expect(out).toContain(">running now<");
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

describe("the spend tile", () => {
  const row = (spend: { todayUsd: number; ceilingUsd: number | null }) =>
    kpiRowFor({ landedHours: hours(0), landed: 0, live: null, backupAt: null, reach: NO_REACH, medianCheckMs: null, builders: { running: 0, slots: 0, idle: null }, spend }, null).toString();

  test("shows today's spend of the ceiling, the cents in the title, linking to the crew page", () => {
    const out = row({ todayUsd: 12.34, ceilingUsd: 40 });
    expect(out).toContain('class="stat-value num" title="$12.34 of $40.00">$12 of $40<');
    expect(out).toContain('aria-label="Crew spend today: $12.34 of $40.00, Crew spend today (UTC) at token list price, of the forge ceiling"');
    expect(out).toContain(">of the forge ceiling<");
  });

  test("a small spend shows cents, not $0", () => {
    expect(row({ todayUsd: 0.4, ceilingUsd: 40 })).toContain('>$0.40 of $40<');
  });

  test("without a ceiling it shows the spend alone and says no ceiling", () => {
    const out = row({ todayUsd: 12.34, ceilingUsd: null });
    expect(out).toContain('title="$12.34">$12<');
    expect(out).toContain(">no forge ceiling<");
    expect(out).not.toContain(" of $");
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

describe("home kpi row: the last off-box backup", () => {
  const NOW = new Date("2026-10-20T12:00:00.000Z");
  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
  const row = (backupAt: string | null) =>
    kpiRowFor({ landedHours: hours(0), landed: 0, live: null, backupAt, reach: NO_REACH, builders: { running: 0, slots: 0, idle: null }, spend: { todayUsd: 0, ceilingUsd: null }, medianCheckMs: null }, null, NOW).toString();
  const tile = (out: string) => /<a class="stat"[^>]*href="\/settings\/backups"[^>]*>/.exec(out)![0];

  test("a backup 2 h old reads its age, with the exact time, and is not flagged", () => {
    const out = row(hoursAgo(2));
    expect(out).toContain("2 h ago");
    expect(out).toContain(`title="${hoursAgo(2)}"`);
    expect(tile(out)).not.toContain("data-tone");
    expect(tile(out)).not.toContain("Overdue");
  });

  test("a backup 25 h old is flagged and its label says overdue", () => {
    const t = tile(row(hoursAgo(25)));
    expect(t).toContain('data-tone="attn"');
    expect(t).toContain("Overdue");
  });

  test("no backup at all reads never and is flagged", () => {
    const out = row(null);
    expect(out).toContain(">never<");
    expect(tile(out)).toContain('data-tone="attn"');
    expect(tile(out)).toContain("Overdue");
  });

  test("readKpis reads the mirror's newest time from the data directory", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { Database } = await import("bun:sqlite");
    const { recordMirror } = await import("../src/snapshot/mirror.ts");
    const { readKpis } = await import("../src/flow/kpis.ts");
    const dir = mkdtempSync(join(tmpdir(), "kpi-backup-"));
    const db = new Database(":memory:");
    db.run("CREATE TABLE repo (autonomy TEXT, autonomy_slots INTEGER, default_branch TEXT, id TEXT)");
    db.run("CREATE TABLE run (id TEXT, kind TEXT, state TEXT, started_at TEXT, finished_at TEXT, serving_at TEXT, env TEXT, commit_oid TEXT, cost_usd REAL, created_at TEXT)");
    db.run("CREATE TABLE pull (carried INTEGER NOT NULL DEFAULT 0, merged_at TEXT, merged_oid TEXT, base_oid TEXT, base_branch TEXT, issue_id TEXT)");
    db.run("CREATE TABLE issue (id TEXT, repo_id TEXT, kind TEXT, state TEXT, created_at TEXT)");
    bugTables(db);
    reachTables(db);
    expect(readKpis(db, NOW, { ceilingUsd: null, dataDir: dir }).backupAt).toBeNull();
    recordMirror(dir, { where: "b2", attemptAt: hoursAgo(1), reachable: true, newest: "s1", newestAt: hoursAgo(3) });
    expect(readKpis(db, NOW, { ceilingUsd: null, dataDir: dir }).backupAt).toBe(hoursAgo(3));
  });
});

describe("the reach tiles", () => {
  test("say what they count in words, each linking to the reach board", () => {
    const reach = { usersToday: 3, usersTotal: 12, visitorsToday: 5, visitors7d: 31, visitorDays: new Array<number>(30).fill(0), loadP75: 1250, inpP75: 180 };
    const out = kpiRowFor({ landedHours: hours(0), landed: 0, live: null, backupAt: null, reach, medianCheckMs: null, builders: { running: 0, slots: 0, idle: null }, spend: { todayUsd: 0, ceilingUsd: null } }, null).toString();
    for (const v of ["1.3 s", "reacts in 180 ms"]) expect(out).toContain(`>${v}<`);
    // Reporting browsers and Accounts feed no decision: only the page speed stays (#10440).
    for (const gone of ["Reporting browsers", "Accounts", "Traffic"]) expect(out).not.toContain(gone);
    expect((out.match(/class="stat" href="\/boards\/reach"/g) ?? []).length).toBe(1);
    expect(out).not.toContain("INP");
    expect(out).not.toContain("p75");
  });

  test("the terminal draws the 30 days as one block per day", () => {
    const days = Array.from({ length: 30 }, (_, i) => (i === 29 ? 8 : 0));
    const reach = { usersToday: 0, usersTotal: 1, visitorsToday: 8, visitors7d: 8, visitorDays: days, loadP75: null, inpP75: null };
    const line = kpiLines({ landedHours: hours(0), landed: 0, live: null, backupAt: null, reach, medianCheckMs: null, builders: { running: 0, slots: 0, idle: null }, spend: { todayUsd: 0, ceilingUsd: null } }, null).find((l) => l.startsWith("Reporting browsers"))!;
    expect(line).toContain("▁".repeat(29) + "█");
  });

  test("the terminal says the same", () => {
    const lines = kpiLines({ landedHours: hours(0), landed: 0, live: null, backupAt: null, reach: { usersToday: 3, usersTotal: 12, visitorsToday: 5, visitors7d: 31, visitorDays: new Array<number>(30).fill(0), loadP75: 1250, inpP75: 180 }, medianCheckMs: null, builders: { running: 0, slots: 0, idle: null }, spend: { todayUsd: 0, ceilingUsd: null } }, null);
    expect(lines.find((l) => l.startsWith("Reporting browsers"))).toContain("Reporting browsers 5 today, 31 in 7 days");
    expect(lines).toContain("Accounts 3 of 12 seen today");
    expect(lines.find((l) => l.startsWith("Reporting browsers"))).toContain("▁".repeat(30));
    expect(lines).toContain("Reported page speed loads in 1.3 s, reacts in 180 ms");
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
    db.run("INSERT INTO page_vital VALUES (?, ?, ?, ?)", [day, visitor, load, inp]);

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
    expect(waitingWords(3, "2026-10-19T10:00:00.000Z", now)).toBe("3 waiting on you, oldest 50 h");
    expect(waitingWords(1, "2026-10-21T11:40:00.000Z", now)).toBe("1 waiting on you, oldest under 1 h");
  });

  async function homeWith(stale: number[], title?: string): Promise<string> {
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
      return await (await fetch(`${servers.url}/feed`, { headers: { cookie } })).text();
    } finally {
      await servers.stop();
      app.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("three asks show one line linking to /review", async () => {
    const body = await homeWith([30, 40, 50]);
    expect(body).toMatch(/<p class="small muted break stack stack-tight"><span>3 waiting on you, oldest 5\d h<\/span><a href="\/review">Review them<\/a><\/p>/);
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
  const over = { todayUsd: 601, ceilingUsd: 600, hitAt: "2026-10-25T14:03:20.000Z" };

  test("past the cap the tile is attention-toned and names the time; the terminal says the same words", () => {
    const out = kpiRowFor({ ...base, spend: over }, null).toString();
    expect(out).toContain("ceiling hit 14:03Z, builders idle");
    expect(out).toContain("attn");
    expect(kpiLines({ ...base, spend: over }, null)[4]).toBe("Crew spend today $601 of $600, ceiling hit 14:03Z, builders idle");
  });

  test("under the cap there is no hit; with no cap both doors say no forge ceiling", () => {
    expect(kpiRowFor({ ...base, spend: { todayUsd: 5, ceilingUsd: 600, hitAt: null } }, null).toString()).not.toContain("ceiling hit");
    expect(kpiRowFor({ ...base, spend: { todayUsd: 5, ceilingUsd: null } }, null).toString()).toContain("no forge ceiling");
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
