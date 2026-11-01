/** Fired flow alarms (#6346): one line above home's feed and on /boards, one notification per start, in the MCP flow reading. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { forgetLive, keepLive } from "../src/release/landings.ts";
import { serve } from "../src/http/server.ts";
import { firedAlarms, type FiredAlarm } from "../src/flow/alarms.ts";
import { setNotifyUrl, startNotifier } from "../src/crew/notify.ts";
import { flowFor } from "../src/system/telemetry.ts";
import { alarmLines } from "../src/web/studio/alarm_lines.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function seed(mergedMinAgo?: number) {
  const dir = mkdtempSync(join(tmpdir(), "forge-alarm-lines-"));
  dirs.push(dir);
  const app = createApp({ dataDir: dir, port: 0 });
  const u = await createUser(app.db, { username: "alice", email: "a@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  const repo = await createRepo(app.db, app.reposRoot, { ownerId: u.value.id, name: "r", visibility: "public", description: "r" });
  if (!repo.ok) throw new Error(repo.error);
  // The running commit predates every merge here, so a merge is on its way.
  if (mergedMinAgo === undefined) forgetLive();
  else keepLive("alice/r", [], 0);
  if (mergedMinAgo !== undefined) {
    const at = new Date(Date.now() - mergedMinAgo * 60_000).toISOString();
    const issueId = id();
    app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, 1, 'pull', 'P', '', ?3, 'closed', ?4)`).run(issueId, repo.value.id, u.value.id, at);
    app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at) VALUES (?1, ?2, 'b/1', '', '', ?3, ?4)`).run(issueId, repo.value.defaultBranch, repo.value.id, at);
  }
  return { app, user: u.value };
}

const fired: FiredAlarm = { key: "no_release", says: "Main moved 91 min ago and nothing has gone live yet.", since: "2026-10-26T10:29:00.000Z", href: "/releases" };

describe("alarm lines", () => {
  test("a fired alarm is a line linking its item; none fired draws nothing", () => {
    expect(String(alarmLines([fired]))).toContain(`<a href="/releases">Main moved 91 min ago`);
    expect(String(alarmLines([]))).toBe("");
  });

  test("/boards and home show the line when an alarm fires, and nothing when none does", async () => {
    for (const [merged, want] of [[200, true], [undefined, false]] as const) {
      const { app, user } = await seed(merged);
      const servers = await serve(app);
      const headers = { authorization: `Bearer ${createToken(app.db, user.id, "t", "admin").token}` };
      for (const path of ["/boards", "/"]) {
        const body = await (await fetch(servers.url + path, { headers })).text();
        expect(body.includes("nothing has gone live"), `${path} ${String(merged)}`).toBe(want);
        expect(body.includes('role="alert"')).toBe(want);
      }
      await servers.stop?.();
    }
  });

  test("the MCP flow reading carries the fired alarms", async () => {
    const { app } = await seed(200);
    expect(flowFor(app, { kind: "owner" }).alarms.map((a) => a.key)).toEqual(["no_release"]);
    const none = await seed();
    expect(flowFor(none.app, { kind: "owner" }).alarms).toEqual([]);
    expect(firedAlarms(none.app.db, new Date())).toEqual([]);
  });

  test("the owner is told once when an alarm starts firing, not again while it stands", async () => {
    const { app, user } = await seed();
    setNotifyUrl(app.db, user.id, "https://ntfy.example.test/topic");
    const posts: string[] = [];
    let now = Date.parse("2026-10-26T12:00:00.000Z");
    let on: FiredAlarm[] = [];
    const notifier = startNotifier(app, {
      forgeUrl: "https://forge.example.test",
      now: () => now,
      drainingSince: () => null,
      causes: () => [],
      alarms: () => on,
      send: async (_u, body) => {
        posts.push(body);
        return true;
      },
    });
    await notifier.settled();
    const wake = async () => {
      now += 60_000;
      app.bus.append({ kind: "drill.finished", payload: {} });
      await notifier.settled();
    };
    await wake();
    expect(posts).toHaveLength(0);
    on = [fired];
    await wake();
    await wake();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("nothing has gone live");
    expect(posts[0]).toContain("https://forge.example.test/releases");
    await notifier.close();
  });
});
