/** The "no release" alarm (#6345): fires 90 min after main moved with nothing live since. */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { forgetLive, keepLive } from "../src/release/landings.ts";
import { noReleaseAlarm } from "../src/flow/alarm_no_release.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const minAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

async function seed() {
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "forge-alarm-")), port: 0 });
  const u = await createUser(app.db, { username: "alice", email: "a@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  const repo = await createRepo(app.db, app.reposRoot, { ownerId: u.value.id, name: "r", visibility: "public", description: "r" });
  if (!repo.ok) throw new Error(repo.error);
  let n = 0;
  return {
    app,
    /** The running commit was made at `at`: it contains every merge before it. */
    release: (at: string) => keepLive("alice/r", [], Date.parse(at)),
    merge: (at: string) => {
      const issueId = id();
      n++;
      app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', 'P', '', ?4, 'closed', ?5)`).run(issueId, repo.value.id, n, u.value.id, at);
      app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at) VALUES (?1, ?2, ?3, '', '', ?4, ?5)`).run(issueId, repo.value.defaultBranch, `b/${n}`, repo.value.id, at);
    },
  };
}

process.env["FORGE_COMMIT"] = "abcdef1234567890";

describe("no release alarm", () => {
  test("says nothing until the running commit has been read", async () => {
    const s = await seed();
    forgetLive();
    s.merge(minAgo(500));
    expect(noReleaseAlarm(s.app.db, NOW).fired).toBe(false);
  });
  test("fires when main moved 91 min ago and nothing went live since", async () => {
    const s = await seed();
    s.merge(minAgo(91));
    s.release(minAgo(200));
    const a = noReleaseAlarm(s.app.db, NOW);
    expect(a.fired).toBe(true);
    expect(a.since).toBe(minAgo(91));
    expect(a.says).toBe("1 merged pull has waited 91 min and nothing has gone live: production runs dev · abcdef1.");
  });
  test("does not fire at 89 min, with no move, or once a release followed the move", async () => {
    const s = await seed();
    s.release(minAgo(200));
    expect(noReleaseAlarm(s.app.db, NOW).fired).toBe(false);
    s.merge(minAgo(89));
    expect(noReleaseAlarm(s.app.db, NOW).fired).toBe(false);
    const t = await seed();
    t.merge(minAgo(150));
    t.release(minAgo(100));
    expect(noReleaseAlarm(t.app.db, NOW).fired).toBe(false);
  });
});
