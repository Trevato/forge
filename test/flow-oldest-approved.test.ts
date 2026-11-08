/** The oldest approved wait (#6422). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { readOldestApproved } from "../src/flow/oldest_approved.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const ago = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();

let dir: string;
let app: App;
let uid: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "oldest-approved-"));
  app = createApp({ dataDir: dir, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  uid = u.value.id;
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('pub', ?1, 'pub', 'public')", [uid]);
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('priv', ?1, 'priv', 'private')", [uid]);
});
afterAll(async () => {
  app.close?.();
  await rm(dir, { recursive: true, force: true });
});
// Each test starts from no pulls.
const clear = (): void => {
  app.db.run("DELETE FROM issue");
};

function pull(opts: { repo?: string; reviews: [string, number][]; merged?: boolean }): number {
  n++;
  const db = app.db;
  db.run(
    "INSERT INTO issue (id, repo_id, number, kind, title, author_id, state) VALUES (?1, ?2, ?3, 'pull', 't', ?4, 'open')",
    [`p${n}`, opts.repo ?? "pub", n, uid],
  );
  db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1, 'main', ?2, '', 'h', ?3)", [
    `p${n}`,
    `b${n}`,
    opts.merged ? ago(1) : null,
  ]);
  opts.reviews.forEach(([state, h], i) =>
    db.run("INSERT INTO review (id, issue_id, author_id, state, created_at) VALUES (?1, ?2, ?3, ?4, ?5)", [`rv${n}-${i}`, `p${n}`, uid, state, ago(h)]),
  );
  return n;
}

describe("readOldestApproved", () => {
  test("names the oldest of three approved pulls", () => {
    clear();
    pull({ reviews: [["approved", 5]] });
    const old = pull({ reviews: [["approved", 132]] });
    pull({ reviews: [["approved", 30]] });
    const r = readOldestApproved(app.db, NOW, false)!;
    expect(r.pull).toBe(old);
    expect(r.repo).toBe("pub");
    expect(r.hours).toBeCloseTo(132, 5);
  });

  test("uses the latest approval of a pull", () => {
    clear();
    const p = pull({ reviews: [["approved", 100], ["approved", 2]] });
    expect(readOldestApproved(app.db, NOW, false)).toEqual({ pull: p, repo: "pub", hours: 2 });
  });

  test("ignores a landed pull", () => {
    clear();
    pull({ reviews: [["approved", 200]], merged: true });
    const open = pull({ reviews: [["approved", 3]] });
    expect(readOldestApproved(app.db, NOW, false)!.pull).toBe(open);
  });

  test("a later changes-requested drops a pull out; a later approval brings it back", () => {
    clear();
    pull({ reviews: [["approved", 50], ["changes_requested", 10]] });
    expect(readOldestApproved(app.db, NOW, false)).toBeNull();
    clear();
    const p = pull({ reviews: [["approved", 50], ["changes_requested", 10], ["approved", 4]] });
    expect(readOldestApproved(app.db, NOW, false)!.pull).toBe(p);
  });

  test("publicOnly hides private repositories", () => {
    clear();
    const priv = pull({ repo: "priv", reviews: [["approved", 90]] });
    const pub = pull({ reviews: [["approved", 6]] });
    expect(readOldestApproved(app.db, NOW, false)!.pull).toBe(priv);
    expect(readOldestApproved(app.db, NOW, true)!.pull).toBe(pub);
  });

  test("none approved gives null", () => {
    clear();
    pull({ reviews: [["commented", 5]] });
    pull({ reviews: [] });
    expect(readOldestApproved(app.db, NOW, false)).toBeNull();
  });
});
