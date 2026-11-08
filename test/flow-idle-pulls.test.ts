/** Idle pulls (#6470). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { readIdlePulls } from "../src/flow/idle_pulls.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const ago = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();

let dir: string;
let app: App;
let agent: string;
let person: string;
let n = 100;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "idle-pulls-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first: boolean): Promise<string> => {
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!u.ok) throw new Error(u.error);
    return u.value.id;
  };
  person = await mk("alice", true);
  agent = await mk("scout", false);
  app.db.run("UPDATE user SET is_agent = 1 WHERE id = ?1", [agent]);
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('pub', ?1, 'pub', 'public')", [person]);
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('priv', ?1, 'priv', 'private')", [person]);
});
afterAll(async () => {
  app.close?.();
  await rm(dir, { recursive: true, force: true });
});
const clear = (): void => {
  app.db.run("DELETE FROM issue");
  app.db.run("DELETE FROM event");
};

function pull(opts: { openedH: number; pushedH?: number[]; repo?: string; by?: string; merged?: boolean; body?: string }): number {
  n++;
  const repo = opts.repo ?? "pub";
  app.db.run(
    "INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', 't', ?4, ?5, 'open', ?6)",
    [`p${n}`, repo, n, opts.body ?? "", opts.by ?? agent, ago(opts.openedH)],
  );
  app.db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1, 'main', ?2, '', 'h', ?3)", [
    `p${n}`,
    `b${n}`,
    opts.merged ? ago(1) : null,
  ]);
  (opts.pushedH ?? []).forEach((h, i) =>
    app.db.run("INSERT INTO event (id, kind, repo_id, payload, created_at) VALUES (?1, 'pull.pushed', ?2, ?3, ?4)", [
      `e${n}-${i}`,
      repo,
      JSON.stringify({ number: n }),
      ago(h),
    ]),
  );
  return n;
}

describe("readIdlePulls", () => {
  test("returns only the idle open crew pull", () => {
    clear();
    const idle = pull({ openedH: 200, pushedH: [150, 80], body: "Closes #7" });
    pull({ openedH: 200, pushedH: [150, 1] });
    pull({ openedH: 200, merged: true });
    pull({ openedH: 200, by: person });
    const rows = readIdlePulls(app.db, NOW, false);
    expect(rows).toEqual([{ pull: idle, owner: "alice", repo: "pub", issue: 7, hours: 80 }]);
  });

  test("a pull with no push is idle from its opening, and 72 h is the line", () => {
    clear();
    const a = pull({ openedH: 72 });
    pull({ openedH: 71 });
    expect(readIdlePulls(app.db, NOW, false).map((r) => r.pull)).toEqual([a]);
  });

  test("oldest first, at most 20", () => {
    clear();
    for (let i = 0; i < 25; i++) pull({ openedH: 100 + i });
    const rows = readIdlePulls(app.db, NOW, false);
    expect(rows).toHaveLength(20);
    expect(rows[0]!.hours).toBeGreaterThan(rows[19]!.hours);
  });

  test("publicOnly leaves out a private repository's pull", () => {
    clear();
    const pub = pull({ openedH: 100 });
    const priv = pull({ openedH: 200, repo: "priv" });
    expect(readIdlePulls(app.db, NOW, false).map((r) => r.pull)).toEqual([priv, pub]);
    expect(readIdlePulls(app.db, NOW, true).map((r) => r.pull)).toEqual([pub]);
  });
});
