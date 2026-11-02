/** The old Later-gate holds are found and released, and only those (#7801). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setIssueState } from "../src/actions/issues.ts";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addDependency, dependenciesOf } from "../src/core/dependencies.ts";
import { createIssue, type Issue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { heldByGateAlone, releaseFromGate } from "../src/crew/release_later.ts";
import { adminCookie } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("release the issues the Later gate holds", () => {
  let dataDir = "";
  let app: App;
  let repo: Repo;
  let gate: Issue;
  let alone: Issue;
  let withPillar: Issue;
  let pillar: Issue;
  let free: Issue;
  let closedBlocker: Issue;
  let afterClosed: Issue;
  let crossed: Issue;
  let other: Repo;
  let gateless: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-release-later-"));
    app = createApp({ dataDir, port: 0 });
    await adminCookie(app, { username: "alice", email: "alice@forge.test", password: "a-long-words-passphrase" });
    const alice = getUserByName(app.db, "alice")!;
    const made = await createRepo(app, alice, { name: "garden", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const open = (title: string): Issue => {
      const r = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title });
      if (!r.ok) throw new Error(String(r.error));
      return r.value;
    };
    gate = open("Later gate: not yet");
    pillar = open("An open blocker");
    alone = open("Held by the old rule");
    withPillar = open("Held and also waiting");
    free = open("Never held");
    closedBlocker = open("Done long ago");
    afterClosed = open("Held behind a closed blocker and the gate");
    for (const [i, b] of [[alone, gate], [withPillar, gate], [withPillar, pillar], [afterClosed, closedBlocker], [afterClosed, gate]] as const) {
      const r = addDependency(app.db, i, b, alice.id);
      if (!r.ok) throw new Error(r.error);
    }
    const closed = setIssueState(app, alice, repo, closedBlocker, "closed");
    if (!closed.ok) throw new Error(String(closed.error));
    // Another repository whose own "Later gate" has the same number as ours: it must never be matched.
    const second = await createRepo(app, alice, { name: "orchard", visibility: "public" });
    if (!second.ok) throw new Error(String(second.error));
    other = second.value;
    const mk = (title: string): Issue => {
      const r = createIssue(app.db, { repoId: other.id, authorId: alice.id, title });
      if (!r.ok) throw new Error(String(r.error));
      return r.value;
    };
    const foreign = mk("Later gate: elsewhere");
    // Not reachable through addDependency (it refuses cross-repo edges), so a damaged row stands in.
    crossed = open("Waits on another repository's issue of the gate's number");
    app.db.query("INSERT INTO issue_dependency (issue_id, blocked_by_id) VALUES (?1, ?2)").run(crossed.id, foreign.id);
    // A repository with no Later gate at all, where an issue waits for an ordinary blocker.
    const third = await createRepo(app, alice, { name: "meadow", visibility: "public" });
    if (!third.ok) throw new Error(String(third.error));
    gateless = third.value;
    const mine = (title: string): Issue => {
      const r = createIssue(app.db, { repoId: gateless.id, authorId: alice.id, title });
      if (!r.ok) throw new Error(String(r.error));
      return r.value;
    };
    const waits = addDependency(app.db, mine("Waits"), mine("Blocks"), alice.id);
    if (!waits.ok) throw new Error(waits.error);
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("lists only the issue the gate alone holds, with who linked it", () => {
    expect(heldByGateAlone(app.db, repo.id).map((h) => [h.number, h.linkedBy])).toEqual([
      [alone.number, "alice"],
      [afterClosed.number, "alice"],
    ]);
    expect(heldByGateAlone(app.db, repo.id).some((h) => h.id === crossed.id)).toBe(false);
  });

  test("a repository with no gate lists and releases nothing", () => {
    expect(heldByGateAlone(app.db, gateless.id)).toEqual([]);
    expect(releaseFromGate(app.db, gateless.id, [1, 2])).toEqual([]);
  });

  test("a gate nothing in its own repository waits for lists nothing", () => {
    expect(heldByGateAlone(app.db, other.id)).toEqual([]);
  });

  test("a failure part-way releases none", () => {
    // The second delete aborts; the first must roll back with it.
    app.db.run(
      `CREATE TEMP TRIGGER refuse BEFORE DELETE ON issue_dependency WHEN OLD.issue_id = '${afterClosed.id}'
       BEGIN SELECT RAISE(ABORT, 'refused'); END`,
    );
    try {
      expect(() => releaseFromGate(app.db, repo.id, [alone.number, afterClosed.number])).toThrow("refused");
    } finally {
      app.db.run("DROP TRIGGER refuse");
    }
    expect(heldByGateAlone(app.db, repo.id).map((h) => h.number)).toEqual([alone.number, afterClosed.number]);
  });

  test("releasing deletes that one edge and leaves the others", () => {
    expect(releaseFromGate(app.db, repo.id, [free.number, withPillar.number])).toEqual([]);
    expect(releaseFromGate(app.db, repo.id, [alone.number, crossed.number])).toEqual([alone.number]);
    expect(releaseFromGate(app.db, repo.id, [afterClosed.number])).toEqual([afterClosed.number]);
    expect(heldByGateAlone(app.db, repo.id)).toEqual([]);
    expect(dependenciesOf(app.db, alone.id).blockedBy).toEqual([]);
    expect(dependenciesOf(app.db, withPillar.id).blockedBy.length).toBe(2);
  });

  test("a gate that is closed holds nothing", () => {
    const closed = setIssueState(app, getUserByName(app.db, "alice")!, repo, gate, "closed");
    if (!closed.ok) throw new Error(String(closed.error));
    const again = addDependency(app.db, free, gate, undefined);
    expect(again.ok).toBe(true);
    expect(heldByGateAlone(app.db, repo.id)).toEqual([]);
    expect(releaseFromGate(app.db, repo.id, [free.number])).toEqual([]);
  });
});
