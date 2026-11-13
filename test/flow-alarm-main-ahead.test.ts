/** Main green and ahead of production (#11507): one alarm past 90 min with the facts, none at 89, closes on catch-up; the heartbeat shows. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { addComment } from "../src/actions/issues.ts";
import { getIssueById } from "../src/core/issues.ts";
import { getRepo } from "../src/core/repos.ts";
import { hunt } from "../src/crew/sentinel.ts";
import { firedAlarms } from "../src/flow/alarms.ts";
import { aheadMinutes, mainAheadAlarm } from "../src/flow/alarm_main_ahead.ts";
import { lastBeat, recordBeat, stepWithBeat } from "../src/keeper/beat.ts";
import { keeperPanel } from "../src/web/pages/keeper-panel.ts";
import { keeperAnswer } from "../src/keeper/landed.ts";
import { tickStep } from "../src/keeper/keeper.ts";
import { keeperForge } from "./helpers/keeper.ts";
import { id } from "../src/kernel/id.ts";
import { forgetLive, keepLive } from "../src/release/landings.ts";
import { alarmLines } from "../src/crew/notify.ts";
import { homeTruth } from "../src/system/home_truth.ts";
import { Session } from "../src/tui/forge.ts";
import { keeperScreen, readKeeper } from "../src/tui/screens/keeper.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { flowFor } from "../src/system/telemetry.ts";
import { flowPanel } from "../src/web/pages/flow-panel.ts";

const NOW = new Date("2026-11-11T12:00:00.000Z");
const ago = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const PROD = "abcdef1234567890abcdef1234567890abcdef12";
const HEAD = "1111111111111111111111111111111111111111";

let root: string;
let app: App;
let repoId: string;
let branch: string;
let userId: string;
let owner: User;
let n = 0;
const saved = { sentinel: process.env["FORGE_SENTINEL_REPO"], commit: process.env["FORGE_COMMIT"], version: process.env["FORGE_VERSION"] };

beforeAll(async () => {
  process.env["FORGE_SENTINEL_REPO"] = "trevato/forge";
  process.env["FORGE_COMMIT"] = PROD;
  process.env["FORGE_VERSION"] = "0.7.535";
  root = mkdtempSync(join(tmpdir(), "forge-main-ahead-"));
  app = createApp({ dataDir: root, port: 0 });
  const u = await createUser(app.db, { username: "trevato", email: "t@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  userId = u.value.id;
  owner = u.value;
  const repo = await createRepo(app.db, app.reposRoot, { ownerId: u.value.id, name: "forge", visibility: "public", description: "f" });
  if (!repo.ok) throw new Error(repo.error);
  repoId = repo.value.id;
  branch = repo.value.defaultBranch;
});
afterAll(() => {
  app.close();
  rmSync(root, { recursive: true, force: true });
  for (const [k, v] of [["FORGE_SENTINEL_REPO", saved.sentinel], ["FORGE_COMMIT", saved.commit], ["FORGE_VERSION", saved.version]] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  forgetLive();
});

function check(state: "ok" | "failed", oid: string): void {
  app.db
    .query(`INSERT INTO run (id, repo_id, kind, env, state, summary, check_detail, commit_oid, created_at, finished_at) VALUES (?1, ?2, 'check', ?3, ?4, '', '{}', ?5, ?6, ?6)`)
    .run(`${String(++n).padStart(4, "0")}${id()}`, repoId, branch, state, oid, ago(1));
}
function merge(minAgo: number, oid: string): void {
  const issueId = id();
  n++;
  app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', 'P', '', ?4, 'closed', ?5)`).run(issueId, repoId, 1000 + n, userId, ago(minAgo));
  app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at, merged_oid) VALUES (?1, ?2, ?3, '', '', ?4, ?5, ?6)`).run(issueId, branch, `b/${n}`, repoId, ago(minAgo), oid);
}
const reset = () => {
  app.db.query(`DELETE FROM run`).run();
  app.db.query(`DELETE FROM pull`).run();
  keepLive("trevato/forge", [], NOW.getTime() - 600 * 60_000);
};

describe("main ahead alarm", () => {
  test("none at 89 minutes, one at 91 with the facts", () => {
    reset();
    check("ok", HEAD);
    merge(89, "2".repeat(40));
    expect(mainAheadAlarm(app.db, NOW).fired).toBe(false);
    expect(firedAlarms(app.db, NOW, { dataDir: null }).filter((a) => a.key === "main_ahead")).toHaveLength(0);
    reset();
    check("ok", HEAD);
    merge(91, "2".repeat(40));
    merge(30, "3".repeat(40));
    recordBeat(app.db, "skipped", "no cut: a hold stands", new Date(NOW.getTime() - 61 * 60_000));
    const fired = firedAlarms(app.db, NOW, { dataDir: null }).filter((a) => a.key === "main_ahead");
    expect(fired).toHaveLength(1);
    const says = fired[0]!.says;
    expect(says).toContain("0.7.535");
    expect(says).toContain("abcdef1");
    expect(says).toContain("2 commits and 2 pulls");
    expect(says).toContain("1 h 31 min");
    expect(says).toContain("1 h 1 min ago");
    expect(fired[0]!.since).toBe(ago(91));
  });

  test("a red head, or production on the head, does not fire", () => {
    reset();
    merge(200, "2".repeat(40));
    check("failed", HEAD);
    expect(mainAheadAlarm(app.db, NOW).fired).toBe(false);
    check("ok", PROD);
    expect(mainAheadAlarm(app.db, NOW).fired).toBe(false);
  });

  test("the limit is a setting", () => {
    reset();
    check("ok", HEAD);
    merge(50, "2".repeat(40));
    expect(mainAheadAlarm(app.db, NOW).fired).toBe(false);
    app.db.query(`INSERT INTO forge_setting (key, value, updated_by, updated_at) VALUES ('release.ahead_minutes', '45', 'test', 'now') ON CONFLICT (key) DO UPDATE SET value = '45'`).run();
    expect(mainAheadAlarm(app.db, NOW).fired).toBe(true);
    app.db.query(`DELETE FROM forge_setting WHERE key = 'release.ahead_minutes'`).run();
  });

  test("it reaches the owner's ask and one Sentinel issue, which closes when production catches up", () => {
    reset();
    check("ok", HEAD);
    merge(120, "2".repeat(40));
    expect(owner.isAdmin).toBe(true);
    const lines = alarmLines(app, owner, NOW.getTime());
    expect(lines.some((l) => l.id.startsWith("alarm:main_ahead@"))).toBe(true);
    hunt(app, "trevato/forge", NOW.getTime());
    hunt(app, "trevato/forge", NOW.getTime() + 60_000);
    const open = () => app.db.query<{ title: string }, []>(`SELECT title FROM issue WHERE state = 'open' AND title LIKE 'Sentinel: Main is green and ahead%'`).all();
    expect(open()).toHaveLength(1);
    // Production catches up: it runs the head and the pull is in the running commit.
    keepLive("trevato/forge", ["2".repeat(40)], NOW.getTime());
    hunt(app, "trevato/forge", NOW.getTime() + 120_000);
    expect(open()).toHaveLength(0);
  });
});

describe("heartbeat", () => {
  test("release_keeper shows the last heartbeat and its reason, and says when it is quiet", () => {
    app.db.query(`DELETE FROM keeper_beat_tick`).run();
    expect(keeperAnswer(app.db, NOW).heartbeat).toBeNull();
    recordBeat(app.db, "skipped", "not cut: a hold stands", new Date(NOW.getTime() - 5 * 60_000));
    const h = keeperAnswer(app.db, NOW).heartbeat!;
    expect(h).toMatchObject({ outcome: "skipped", reason: "not cut: a hold stands", silent: false });
    recordBeat(app.db, "failed", "tag refused", new Date(NOW.getTime() - 61 * 60_000));
    const quiet = keeperAnswer(app.db, NOW).heartbeat!;
    expect(quiet.silent).toBe(true);
    expect(quiet.says).toContain("No heartbeat from the release tick for 1 h 1 min");
    expect(lastBeat(app.db)!.reason).toBe("tag refused");
  });
});

describe("home telemetry", () => {
  test("live names the commit production runs, not main's newest deploy", () => {
    reset();
    app.db.query(`INSERT INTO run (id, repo_id, kind, env, state, commit_oid, created_at, serving_at) VALUES (?1, ?2, 'deploy', 'production', 'ok', ?3, ?4, ?4)`).run(id(), repoId, HEAD, ago(5));
    const t = homeTruth(app, owner, NOW);
    expect(t.live).toEqual({ sha: PROD, version: "0.7.535" });
  });

  test("with the running commit unknown, live is null", () => {
    const commit = process.env["FORGE_COMMIT"];
    delete process.env["FORGE_COMMIT"];
    try {
      expect(homeTruth(app, owner, NOW).live).toBeNull();
    } finally {
      process.env["FORGE_COMMIT"] = commit;
    }
  });
});

describe("the main-ahead issue", () => {
  const open = () => app.db.query<{ id: string; body: string }, []>(`SELECT id, body FROM issue WHERE state = 'open' AND title LIKE 'Sentinel: Main is green and ahead%'`).all();

  test("keeps the tick's reason out of the issue, and stays open once a person spoke on it", async () => {
    reset();
    check("ok", HEAD);
    merge(120, "4".repeat(40));
    recordBeat(app.db, "skipped", "private words from the tick", new Date(NOW.getTime() - 5 * 60_000));
    hunt(app, "trevato/forge", NOW.getTime() + 600_000);
    const filed = open();
    expect(filed).toHaveLength(1);
    expect(filed[0]!.body).toContain("skipped");
    expect(filed[0]!.body).not.toContain("private words");
    const repo = getRepo(app.db, "trevato", "forge")!;
    const said = addComment(app, owner, repo, getIssueById(app.db, filed[0]!.id)!, "Looking at the tick now.");
    expect(said.ok).toBe(true);
    keepLive("trevato/forge", ["4".repeat(40)], NOW.getTime());
    hunt(app, "trevato/forge", NOW.getTime() + 720_000);
    expect(open()).toHaveLength(1);
  });
});

describe("the limit setting", () => {
  const set = (v: string) =>
    app.db.query(`INSERT INTO forge_setting (key, value, updated_by, updated_at) VALUES ('release.ahead_minutes', ?1, 'test', 'now') ON CONFLICT (key) DO UPDATE SET value = ?1`).run(v);
  test("a value out of range or not a whole number is 90", () => {
    for (const bad of ["0", "20000", "abc", "1.5", ""]) {
      set(bad);
      expect(aheadMinutes(app.db)).toBe(90);
    }
    set("10080");
    expect(aheadMinutes(app.db)).toBe(10080);
    app.db.query(`DELETE FROM forge_setting WHERE key = 'release.ahead_minutes'`).run();
    expect(aheadMinutes(app.db)).toBe(90);
  });
});

describe("the tick's beat", () => {
  test("a step's outcome is recorded as the keeper said it, whatever its words", async () => {
    const at = new Date(NOW.getTime() - 60_000);
    const line = await stepWithBeat(app.db, async () => ({ line: "not cut: a failed hold stands", outcome: "skipped" }), () => at);
    expect(line).toBe("not cut: a failed hold stands");
    expect(lastBeat(app.db)).toEqual({ at: at.toISOString(), outcome: "skipped", reason: "not cut: a failed hold stands" });
  });

  test("a step that throws is recorded as failed, and the error goes on", async () => {
    const step = stepWithBeat(app.db, async () => { throw new Error("git is gone"); }, () => NOW);
    await expect(step).rejects.toThrow("git is gone");
    expect(lastBeat(app.db)).toEqual({ at: NOW.toISOString(), outcome: "failed", reason: "step failed: git is gone" });
  });
});

describe("a beat that cannot be written", () => {
  test("a good tick is still reported good", async () => {
    const broken = { query: () => { throw new Error("disk full"); } } as never;
    const line = await stepWithBeat(broken, async () => ({ line: "cut 0.7.9", outcome: "cut" }), () => NOW);
    expect(line).toBe("cut 0.7.9");
  });
});

describe("both doors", () => {
  test("/releases and the terminal's keeper screen show the heartbeat and that main is ahead", () => {
    reset();
    check("ok", HEAD);
    merge(120, "5".repeat(40));
    recordBeat(app.db, "skipped", "<b>hold</b> stands", new Date(NOW.getTime() - 3 * 60_000));
    const page = String(keeperPanel(app.db, false, NOW));
    expect(page).toContain('id="keeper-heartbeat"');
    expect(page).toContain("skipped, 3 min ago: ");
    expect(page).toContain('<dt>Release tick</dt>');
    expect(page).toContain("&lt;b&gt;hold&lt;/b&gt;");
    expect(page).not.toContain("<b>hold");
    expect(page).toMatch(/<dt>Main vs production<\/dt><dd id="keeper-ahead">Main is green and 1 commit and 1 pull ahead/);
    const read = readKeeper(new Session(app, { sshUsername: owner.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: owner }), NOW)!;
    expect(read.heartbeat).toContain("3 min ago (skipped)");
    expect(read.ahead).toContain("for 2 h 0 min");
  });

  test("with main on production, no ahead line, and the heartbeat says when it is quiet", () => {
    reset();
    check("ok", PROD);
    recordBeat(app.db, "cut", "cut 0.7.536", new Date(NOW.getTime() - 90 * 60_000));
    const read = readKeeper(new Session(app, { sshUsername: owner.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: owner }), NOW)!;
    expect(read.ahead).toBeUndefined();
    expect(read.heartbeat).toContain("No heartbeat from the release tick for 1 h 30 min");
    expect(String(keeperPanel(app.db, false, NOW))).toContain("cut, 1 h 30 min ago (silent): cut 0.7.536");
    expect(String(keeperPanel(app.db, false, NOW))).not.toContain("keeper-ahead");
  });
});

describe("the terminal screen and /flow", () => {
  test("the keeper screen draws the heartbeat and the ahead line", async () => {
    reset();
    check("ok", HEAD);
    merge(120, "5".repeat(40));
    recordBeat(app.db, "failed", "tag refused", new Date());
    const id = { sshUsername: owner.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: owner };
    const { app: tui, session } = createForgeApp(app, id, { terminal: headlessTerminal(160, 20), exitHooks: false });
    tui.start();
    tui.ctx.push(keeperScreen(session, tui.ctx));
    await settleApp(tui);
    const text = tui.screen.toText().replace(/\s+/g, " ");
    tui.stop?.();
    expect(text).toContain("The release tick last reported 0 min ago (failed): tag refused");
    expect(text).toContain("Main is green and 1 commit and 1 pull ahead");
  });

  test("/flow shows the heartbeat with its reason to the owner and never to an agent", () => {
    reset();
    recordBeat(app.db, "skipped", "a private reason", new Date(NOW.getTime() - 5 * 60_000));
    expect(flowFor(app, { kind: "owner" }, NOW).heartbeat?.reason).toBe("a private reason");
    expect(flowFor(app, { kind: "agent" }, NOW).heartbeat).toBeNull();
    expect(JSON.stringify(flowFor(app, { kind: "agent" }, NOW))).not.toContain("a private reason");
    const url = new URL("http://forge.test/flow");
    expect(String(flowPanel(app, { kind: "owner" }, url, "/flow"))).toContain("skipped, ");
    expect(String(flowPanel(app, { kind: "agent" }, url, "/flow"))).not.toContain("a private reason");
  });
});

describe("the keeper's own outcome", () => {
  test("a cut, a failed verify, then a skip because the failed hold stands", async () => {
    const f = await keeperForge();
    expect((await tickStep(f.ports)).outcome).toBe("cut");
    f.world.live = "0.7.284";
    f.world.healthz = (n) => (n >= 5 ? { status: 503, ms: 2 } : { status: 200, ms: 2 });
    const failed = await tickStep(f.ports);
    expect(failed.outcome).toBe("failed");
    expect(failed.line).toContain("failed its verify");
    const held = await tickStep(f.ports);
    expect(held.line).toContain("failed");
    expect(held.outcome).toBe("skipped");
  });
});
