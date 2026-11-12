/**
 * The 2026-11-11 replay (#11673): production stood on 0.7.535 for 5 h 50 min
 * while main merged pulls, and the no-release alarm said nothing. A merge to
 * another public repository marked every own pull merged before it as live.
 * Here: a fixed running commit, own pulls merged after it, a merge elsewhere,
 * no keeper rows, no new tag. Silent at 89 min, one alarm and one message at
 * 91, cleared when the running commit contains the merges.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { setNotifyUrl, startNotifier } from "../src/crew/notify.ts";
import { firedAlarms } from "../src/flow/alarms.ts";
import { id } from "../src/kernel/id.ts";
import { forgetLive, keepLive } from "../src/release/landings.ts";

const T0 = Date.parse("2026-11-11T12:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const env: Record<string, string | undefined> = {};
const dirs: string[] = [];

beforeAll(() => {
  for (const k of ["FORGE_VERSION", "FORGE_COMMIT", "FORGE_APP_COMMIT"]) env[k] = process.env[k];
  process.env["FORGE_VERSION"] = "0.7.535";
  process.env["FORGE_COMMIT"] = "5e1d0c0ffee5e1d0c0ffee5e1d0c0ffee5e1d0c0";
  delete process.env["FORGE_APP_COMMIT"];
});
afterAll(() => {
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  forgetLive();
});

describe("no release on 2026-11-11", () => {
  test("silent at 89 min, one alarm and one message at 91, clear once the merges run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-1111-"));
    dirs.push(dir);
    const app = createApp({ dataDir: dir, port: 0 });
    const u = await createUser(app.db, { username: "alice", email: "a@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
    if (!u.ok) throw new Error(u.error);
    const own = await createRepo(app.db, app.reposRoot, { ownerId: u.value.id, name: "forge", visibility: "public", description: "f" });
    const other = await createRepo(app.db, app.reposRoot, { ownerId: u.value.id, name: "app", visibility: "public", description: "a" });
    if (!own.ok || !other.ok) throw new Error("repo");
    let n = 0;
    const merge = (repo: typeof own.value, min: number, oid: string) => {
      const issueId = id();
      n++;
      app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', 'P', '', ?4, 'closed', ?5)`).run(issueId, repo.id, n, u.value.id, at(min));
      app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at, merged_oid) VALUES (?1, ?2, ?3, '', '', ?4, ?5, ?6)`).run(issueId, repo.defaultBranch, `b/${n}`, repo.id, at(min), oid);
    };
    // The running commit holds only what merged before it.
    merge(own.value, -30, "a".repeat(40));
    keepLive("alice/forge", ["a".repeat(40)], T0);
    merge(own.value, 10, "b".repeat(40));
    merge(own.value, 40, "c".repeat(40));
    merge(own.value, 70, "d".repeat(40));
    // The merge elsewhere that once marked every own pull before it live.
    merge(other.value, 95, "e".repeat(40));

    const releaseAlarms = (min: number) => firedAlarms(app.db, new Date(T0 + min * 60_000), { dataDir: null }).filter((a) => a.key === "no_release");
    expect(releaseAlarms(10 + 89)).toHaveLength(0);
    const fired = releaseAlarms(10 + 91);
    expect(fired).toHaveLength(1);
    expect(fired[0]!.since).toBe(at(10));
    expect(fired[0]!.says).toBe("3 merged pulls have waited 91 min and nothing has gone live: production runs 0.7.535 · 5e1d0c0.");
    expect(releaseAlarms(10 + 350)[0]!.says).toContain("3 merged pulls have waited 5 h 50 min");

    setNotifyUrl(app.db, u.value.id, "https://ntfy.example.test/topic");
    const posts: string[] = [];
    let now = T0 + 85 * 60_000;
    const notifier = startNotifier(app, {
      forgeUrl: "https://forge.example.test",
      now: () => now,
      drainingSince: () => null,
      causes: () => [],
      alarms: () => firedAlarms(app.db, new Date(now), { dataDir: null }),
      send: async (_u, body) => {
        posts.push(body);
        return true;
      },
    });
    await notifier.settled();
    const wakeAt = async (min: number) => {
      now = T0 + min * 60_000;
      app.bus.append({ kind: "drill.finished", payload: {} });
      await notifier.settled();
    };
    await wakeAt(10 + 89);
    expect(posts).toHaveLength(0);
    await wakeAt(10 + 91);
    await wakeAt(10 + 120);
    await wakeAt(10 + 350);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("production runs 0.7.535 · 5e1d0c0");

    // A release whose commit contains the merges clears it, and nothing more is said.
    keepLive("alice/forge", ["a", "b", "c", "d"].map((c) => c.repeat(40)), T0 + 360 * 60_000);
    expect(releaseAlarms(370)).toHaveLength(0);
    await wakeAt(370);
    expect(posts).toHaveLength(1);
    await notifier.close();
  });
});
