/**
 * Estimates, second pass (#11955): `done`, the refusal that says what can still be estimated, the
 * reopen rate, a release shipped by hand.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { recordEstimate } from "../src/actions/estimates.ts";
import { settleDue, settleLiveNow } from "../src/actions/estimates_settle.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { estimatesOf } from "../src/core/estimates.ts";
import { createIssue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { baseRate, historySamples, type HistorySample } from "../src/flow/estimate_base.ts";
import { compareVersions, recordByHand } from "../src/keeper/by_hand.ts";
import { listKeeperReleases } from "../src/keeper/record.ts";

const H = 3_600_000;
const NOW = new Date("2026-11-13T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

describe("estimates: done, reopens, by-hand releases", () => {
  let dir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  const issue = (title: string, body = "") => {
    const o = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title, body });
    if (!o.ok) throw new Error("issue");
    return o.value;
  };
  const pull = (closes: number, mergedAt: string | null) => {
    const pr = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title: `pr for ${closes}`, body: `Closes #${closes}`, kind: "pull" });
    if (!pr.ok) throw new Error("pull");
    app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1,'main','b','a','b',?2)`).run(pr.value.id, mergedAt);
  };
  const close = (id: string, closedAt: string) =>
    app.db.query(`UPDATE issue SET state='closed', close_reason='done', closed_at=?2 WHERE id=?1`).run(id, closedAt);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-estimates-done-"));
    app = createApp({ dataDir: dir, port: 0 });
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const r = await createRepo(app, alice, { name: "forge", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    await commitToBranch(app, alice, repo, { branch: "main", message: "base", files: [{ path: "a.txt", content: "a\n" }] });
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  test("a merged pull refuses `merged` and names the events that can still be estimated", () => {
    const t = issue("several pulls");
    pull(t.number, at(-H));
    const refused = recordEstimate(app, alice, repo, t, { event: "merged", p50: at(H), p90: at(2 * H) }, NOW);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.message).toContain("merged has already happened");
    expect(refused.error.message).toContain("Events that can still be estimated: live, done.");
    // `done` can still be estimated, and says so in the shape message too.
    expect(recordEstimate(app, alice, repo, t, { event: "done", p50: at(H), p90: at(2 * H) }, NOW).ok).toBe(true);
    const shape = recordEstimate(app, alice, repo, t, { event: "finished", p50: at(H), p90: at(2 * H) }, NOW);
    if (!shape.ok) expect(shape.error.message).toContain("live or done");
  });

  test("done resolves when the issue stays closed 24 h; before that it is open; a reopen keeps it open", () => {
    const t = issue("closes later");
    expect(recordEstimate(app, alice, repo, t, { event: "done", p50: at(H), p90: at(2 * H) }, NOW).ok).toBe(true);
    close(t.id, at(-2 * H));
    expect(settleDue(app.db, NOW)).toBe(0);
    expect(estimatesOf(app.db, t.id)[0]!.state).toBe("open");
    expect(settleDue(app.db, new Date(NOW.getTime() + 21 * H))).toBe(0);
    expect(settleDue(app.db, new Date(NOW.getTime() + 22 * H + 1))).toBe(1);
    // The actual instant is when the condition became true: 24 h after the close.
    expect(estimatesOf(app.db, t.id)[0]).toMatchObject({ state: "resolved", actualAt: at(22 * H) });
  });

  test("done resolves at the release that carries the last pull, if that comes before 24 h", () => {
    const t = issue("lands and ships");
    expect(recordEstimate(app, alice, repo, t, { event: "done", p50: at(H), p90: at(2 * H) }, NOW).ok).toBe(true);
    pull(t.number, at(-3 * H));
    close(t.id, at(-3 * H));
    app.db.query(`INSERT INTO keeper_release (version, sha, known_good_version, known_good_image, stage, cut_at, live_at) VALUES ('0.0.1','s','k','i','verified',?1,?2)`).run(at(-2 * H), at(-H));
    expect(settleDue(app.db, NOW)).toBe(1);
    expect(estimatesOf(app.db, t.id)[0]).toMatchObject({ state: "resolved", actualAt: at(-H) });
  });

  test("the basis says how often such issues were reopened after closing", () => {
    const base = (n: number, extra: Partial<HistorySample> = {}): HistorySample => ({
      number: n, size: "large", kind: "", builder: null, pull: H, merged: 2 * H, live: undefined, mergedAtMs: NOW.getTime() - 86_400_000, done: 2 * H, ...extra,
    });
    const samples = [1, 2, 3, 4, 5, 6, 7].map((n) => base(n, n <= 2 ? { reopened: true } : {}));
    // One more reopened and open again: counts toward the rate, never toward a duration.
    samples.push(base(8, { reopened: true, open: true, merged: 99 * H }));
    const r = baseRate(samples, { size: "large", kind: "", builder: null, elapsedMs: 0 }, "trevato/forge", NOW.getTime());
    expect(r.n).toBe(7);
    expect(r.reopened).toEqual({ n: 3, of: 8 });
    expect(r.basis).toContain("reopened after closing: 3 of 8");
    expect(r.events.merged!.p90Ms).toBe(2 * H);
    expect(r.events.done!.p50Ms).toBe(2 * H);
    expect(baseRate([], { size: "large", kind: "", builder: null, elapsedMs: 0 }, "x", NOW.getTime()).basis).toContain("reopened: no history");
  });

  test("history reads the reopen events: a closed-then-reopened issue is counted, even when open again", () => {
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const a = issue("reopened and closed again");
    const b = issue("reopened and still open");
    const c = issue("never reopened");
    for (const t of [a, b, c]) {
      pull(t.number, iso(now - 2 * H));
      app.db.query(`UPDATE issue SET created_at = ?2 WHERE id = ?1`).run(t.id, iso(now - 5 * H));
    }
    close(a.id, iso(now - H));
    close(c.id, iso(now - H));
    for (const t of [a, b]) app.bus.append({ kind: "issue.reopened", repoId: repo.id, actorId: alice.id, payload: { number: t.number } });
    const got = historySamples(app.db, repo.id, now - 30 * 86_400_000, now);
    const by = (n: number) => got.find((s) => s.number === n);
    expect(by(a.number)).toMatchObject({ reopened: true, open: false });
    expect(by(b.number)).toMatchObject({ reopened: true, open: true });
    expect(by(c.number)).toMatchObject({ reopened: false, open: false });
    expect(by(c.number)!.done).toBeGreaterThan(0);
  });

  test("a release shipped by hand is recorded at boot, once, and only when newer", () => {
    const env = { FORGE_VERSION: "v0.7.560", FORGE_COMMIT: "abcdef1234567" };
    const t = issue("live by hand");
    pull(t.number, at(-H));
    expect(recordEstimate(app, alice, repo, t, { event: "live", p50: at(H), p90: at(2 * H) }, NOW).ok).toBe(true);
    expect(recordByHand(app.db, env, NOW)).toBe("0.7.560");
    const row = listKeeperReleases(app.db).find((r) => r.version === "0.7.560")!;
    expect(row).toMatchObject({ sha: "abcdef1234567", stage: "verified" });
    expect(app.db.query<{ how: string }, []>(`SELECT how FROM keeper_release WHERE version = '0.7.560'`).get()!.how).toBe("by hand");
    expect(row.liveAt).not.toBeNull();
    // The open `live` estimate resolves at the boot time.
    expect(settleLiveNow(app.db)).toBeGreaterThanOrEqual(1);
    expect(estimatesOf(app.db, t.id)[0]).toMatchObject({ state: "resolved", actualAt: row.liveAt });
    // Again, and older, and unstamped: nothing.
    expect(recordByHand(app.db, env)).toBeUndefined();
    expect(recordByHand(app.db, { ...env, FORGE_VERSION: "0.7.559", FORGE_COMMIT: "1234567" })).toBeUndefined();
    expect(recordByHand(app.db, {})).toBeUndefined();
    expect(recordByHand(app.db, { FORGE_VERSION: "dev", FORGE_COMMIT: "1234567" })).toBeUndefined();
    expect(recordByHand(app.db, { FORGE_VERSION: "0.7.561" })).toBeUndefined();
    expect(recordByHand(app.db, { FORGE_VERSION: "0.7.561", FORGE_COMMIT: "1234567" })).toBe("0.7.561");
    expect(compareVersions("0.7.560", "0.7.99")).toBeGreaterThan(0);
    expect(compareVersions("0.7.560", "x")).toBeUndefined();
  });
});
