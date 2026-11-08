/**
 * The idle-crew alarm (#6344): fires when work is ready, the spend ceiling is
 * not reached and no agent run has started for 15 minutes. `now` is passed in.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { alarmIdleCrew } from "../src/flow/alarm_idle_crew.ts";

const MIN = 60_000;
const NOW = new Date("2026-10-26T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe("alarmIdleCrew", () => {
  let dataDir: string;
  let app: App;
  let repoId: string;
  let issueId: string[];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-idle-crew-"));
    app = createApp({ dataDir, port: 0 });
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    const made = await createRepo(app, u.value, { name: "shop" });
    if (!made.ok) throw new Error(String(made.error));
    const set = await updateRepoSettings(app, u.value, made.value, {
      autonomy: "assisted",
      autonomyDirection: "keep the shop open",
      autonomySlots: 2,
      autonomyCeilingUsd: 15,
      autonomyBy: u.value.id,
    });
    if (!set.ok) throw new Error(String(set.error));
    repoId = set.value.id;
    issueId = [];
    for (const title of ["Add a cart", "Show the prices"]) {
      const issue = openIssue(app, u.value, set.value, { title });
      if (!issue.ok) throw new Error(String(issue.error));
      issueId.push(issue.value.id);
      app.db.query("UPDATE issue SET created_at = ?1 WHERE id = ?2").run(ago(60 * MIN), issue.value.id);
    }
  });
  afterEach(async () => {
    app.db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const lastRun = (minutesAgo: number, costUsd = 0) => {
    const run = createRun(app.db, { repoId, kind: "agent", reason: "assigned" });
    app.db
      .query("UPDATE run SET created_at = ?1, started_at = ?1, state = 'ok', cost_usd = ?2 WHERE id = ?3")
      .run(ago(minutesAgo * MIN), costUsd, run.id);
  };

  test("fires with ready work and the last run 16 minutes ago", () => {
    lastRun(16);
    const a = alarmIdleCrew(app.db, NOW, { ceilingUsd: 40 });
    expect(a.fired).toBe(true);
    expect(a.since).toBe(ago(16 * MIN));
    expect(a.says).toBe("2 issues are ready and no crew run has started for 16m.");
  });

  test("fires with no run ever, from when the oldest ready issue began waiting", () => {
    const a = alarmIdleCrew(app.db, NOW);
    expect(a.fired).toBe(true);
    expect(a.since).toBe(ago(60 * MIN));
    expect(a.says).toBe("2 issues are ready and no crew run has started for 1h.");
  });

  test("does not fire with a run 14 minutes ago", () => {
    lastRun(14);
    const a = alarmIdleCrew(app.db, NOW, { ceilingUsd: 40 });
    expect(a.fired).toBe(false);
    expect(a.since).toBeUndefined();
  });

  test("does not fire with no ready work", () => {
    lastRun(16);
    for (const id of issueId) app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(id);
    expect(alarmIdleCrew(app.db, NOW, { ceilingUsd: 40 }).fired).toBe(false);
  });

  test("does not fire once the spend ceiling is reached", () => {
    lastRun(16, 40);
    expect(alarmIdleCrew(app.db, NOW, { ceilingUsd: 40 }).fired).toBe(false);
    expect(alarmIdleCrew(app.db, NOW, { ceilingUsd: 50 }).fired).toBe(true);
  });
});
