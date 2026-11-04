/**
 * A polish issue is capped small (#8852): past the cap its run is stopped
 * with one comment; under it, or on any other issue, nothing happens. The
 * clock is a Date handed in, never the wall's.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue, setIssueLabels } from "../src/actions/issues.ts";
import { createLabel, createRepo } from "../src/actions/repos.ts";
import { listComments, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, getRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { isSmall } from "../src/crew/small_share.ts";
import { leftLine, leftOf, pastCap, tickPolish } from "../src/crew/polish_cap.ts";

let dataDir: string;
let app: App;
let alice: User;
let repo: Repo;

function runOn(title: string, labels: string[]) {
  const made = openIssue(app, alice, getRepoById(app.db, repo.id)!, { title });
  if (!made.ok) throw new Error(String(made.error));
  const issue: Issue = made.value;
  if (labels.length > 0) expect(setIssueLabels(app, alice, repo, issue, labels).ok).toBe(true);
  const run = createRun(app.db, { repoId: repo.id, kind: "agent", issueId: issue.id, actorId: alice.id, reason: "assigned" });
  claimRun(app.db, run.id);
  return { issue, run };
}

const startedAt = (id: string) => Date.parse(getRun(app.db, id)!.startedAt!);
const comments = (issue: Issue) => listComments(app.db, issue.id).filter((c) => c.body.includes("polish cap"));

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-polish-"));
  app = createApp({ dataDir, port: 0 });
  const a = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  alice = a.value;
  const made = await createRepo(app, alice, { name: "notes", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  for (const [n, c] of [["polish", "aabbcc"], ["feature", "112233"]] as const) {
    const l = createLabel(app, alice, repo, n, c);
    if (!l.ok && l.error !== "taken") throw new Error(String(l.error));
  }
  // The drive reads the repository as stored, with its autonomy author.
  repo = { ...getRepoById(app.db, repo.id)!, autonomyBy: alice.id };
});

afterAll(async () => {
  await app.close?.();
  await rm(dataDir, { recursive: true, force: true });
});

describe("the rules", () => {
  test("polish counts as small-fixes work", () => {
    expect(isSmall("Round the corners", ["polish"])).toBe(true);
    expect(isSmall("Round the corners", ["Polish"])).toBe(true);
  });

  test("a run is past the cap at exactly 60 minutes, not at 59", () => {
    const at = "2026-11-02T10:00:00.000Z";
    expect(pastCap(at, 60, new Date("2026-11-02T10:59:59.000Z"))).toBe(false);
    expect(pastCap(at, 60, new Date("2026-11-02T11:00:00.000Z"))).toBe(true);
    expect(pastCap(null, 60, new Date("2030-01-01T00:00:00Z"))).toBe(false);
  });

  test("the line names the cap and what is left, plainly", () => {
    expect(leftLine(60, leftOf(undefined))).toBe(
      "Stopped at the 60-minute polish cap, not extended. Left: nothing landed, no pull open.",
    );
    expect(leftLine(45, leftOf(12))).toBe(
      "Stopped at the 45-minute polish cap, not extended. Left: pull #12 is open, unmerged.",
    );
  });
});

describe("the tick", () => {
  test("a polish run under the cap is left running", () => {
    const { issue, run } = runOn("Under: nudge the margin", ["polish"]);
    expect(tickPolish(app, repo, new Date(startedAt(run.id) + 59 * 60_000))).toBe(0);
    expect(getRun(app.db, run.id)!.state).toBe("running");
    expect(comments(issue)).toHaveLength(0);
  });

  test("past the cap it stops with one comment, however often the tick runs; a non-polish issue is untouched", () => {
    const polish = runOn("Past: nudge the padding", ["polish"]);
    const other = runOn("Past: a feature", ["feature"]);
    const unlabelled = runOn("Past: no label", []);
    const late = new Date(startedAt(polish.run.id) + 61 * 60_000);
    // Earlier tests' runs may also be past by now; this run is the one under test.
    expect(tickPolish(app, repo, late)).toBeGreaterThanOrEqual(1);
    expect(tickPolish(app, repo, late)).toBe(0);
    expect(getRun(app.db, polish.run.id)!.state).toBe("cancelled");
    expect(getRun(app.db, polish.run.id)!.summary).toBe("stopped at the 60-minute polish cap");
    const said = comments(polish.issue);
    expect(said).toHaveLength(1);
    expect(said[0]!.body).toContain("Left: nothing landed, no pull open.");
    expect(getRun(app.db, other.run.id)!.state).toBe("running");
    expect(getRun(app.db, unlabelled.run.id)!.state).toBe("running");
    expect(comments(other.issue)).toHaveLength(0);
  });
});

describe("who says it", () => {
  test("with no autonomy author the run's actor says it: the stop is never silent", () => {
    const { issue, run } = runOn("Silent: nudge the gap", ["polish"]);
    const bare = { ...repo, autonomyBy: null };
    tickPolish(app, bare, new Date(startedAt(run.id) + 61 * 60_000));
    expect(getRun(app.db, run.id)!.state).toBe("cancelled");
    const said = comments(issue);
    expect(said).toHaveLength(1);
    expect(said[0]!.authorId).toBe(alice.id);
  });

  test("with no one to say it the run is left, not stopped silently", () => {
    const { issue, run } = runOn("Mute: nudge the gap", ["polish"]);
    app.db.query("UPDATE run SET actor_id = NULL WHERE id = ?1").run(run.id);
    tickPolish(app, { ...repo, autonomyBy: null }, new Date(startedAt(run.id) + 61 * 60_000));
    expect(getRun(app.db, run.id)!.state).toBe("running");
    expect(comments(issue)).toHaveLength(0);
  });
});
