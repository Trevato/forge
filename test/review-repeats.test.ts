/** A reviewer's repeated comment becomes one issue to automate it, and is retired when that issue is done (#8716). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue, getIssue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { promote } from "./helpers/members.ts";
import { sweepRepeats } from "../src/crew/repeat_checks.ts";
import { dueGroups, group, linesOf, readRepeats, REPEATS, wordsOf } from "../src/flow/repeats.ts";
import { flowFor } from "../src/system/telemetry.ts";
import { repeatLines } from "../src/tui/screens/flow.ts";

let root = "";
let app: App;
let repo: Repo;
let builder: User;
let reviewer: User;
const now = new Date("2026-11-02T12:00:00Z");

const person = async (name: string): Promise<User> => {
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: name, email: `${name}@forge.local`, password: "a-good-passphrase" });
  if (!made.ok) throw new Error(made.error);
  return made.value;
};

/** A pull by the builder, reviewed `ago` ms before `now` with the given body. */
function reviewed(body: string, ago = 3_600_000): number {
  const pull = createIssue(app.db, { repoId: repo.id, authorId: builder.id, title: "work", kind: "pull" });
  if (!pull.ok) throw new Error(pull.error);
  app.db
    .query(`INSERT INTO review (id, issue_id, author_id, state, body, created_at) VALUES (?1, ?2, ?3, 'changes_requested', ?4, ?5)`)
    .run(crypto.randomUUID(), pull.value.id, reviewer.id, body, new Date(now.getTime() - ago).toISOString());
  return pull.value.number;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-repeats-"));
  app = createApp({ dataDir: root, port: 0 });
  builder = await person("builder");
  reviewer = await person("critic");
  promote(app.db, builder);
  const r = await createRepo(app, builder, { name: "yard", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  repo = r.value;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("findings are grouped by what they ask for", () => {
  test("words ignore code, links and filler", () => {
    expect(wordsOf("Please validate the `name` field at https://x.y/z in src/a.ts")).toEqual(["field", "validate"]);
  });
  test("list items are separate findings; short lines are not", () => {
    expect(linesOf("- Escape the output in the page\n2. Add a test for the new route\nok")).toEqual([
      "Escape the output in the page",
      "Add a test for the new route",
    ]);
  });
  test("different wording of the same ask is one group", () => {
    const f = (text: string, pull: number) => ({ repo: "r", pull, author: "a", authorId: "i", text });
    const g = group([
      f("Escape the user name before rendering it into the page", 1),
      f("The user name is rendered into the page without being escaped", 2),
      f("Add a test that the route refuses a cross-origin post", 3),
    ]);
    expect(g.map((x) => x.findings.length)).toEqual([2, 1]);
  });
});

describe("a finding repeated four times in a week becomes one issue", () => {
  test("three is not enough; four proposes once, naming the comments", async () => {
    const pulls = [1, 2, 3].map((i) => reviewed(`- Escape the user name before rendering it into the page (${i})`));
    expect((await sweepRepeats(app, repo, now)).proposed).toEqual([]);
    pulls.push(reviewed("- Escape the user name before rendering it into the page"));
    expect(REPEATS).toBe(4);
    const later = new Date(now.getTime() + 7 * 3_600_000);
    const moves = await sweepRepeats(app, repo, later);
    expect(moves.proposed).toHaveLength(1);
    const issue = getIssue(app.db, repo.id, moves.proposed[0]!);
    expect(issue?.title).toContain("Automate a review finding");
    for (const n of pulls) expect(issue?.body).toContain(`#${n} (critic)`);
    // the same finding never opens a second issue
    expect((await sweepRepeats(app, repo, new Date(later.getTime() + 7 * 3_600_000))).proposed).toEqual([]);
  });

  test("a sweep within six hours of the last does nothing", async () => {
    expect(await sweepRepeats(app, repo, new Date(now.getTime() + 8 * 3_600_000))).toEqual({ proposed: [], retired: 0 });
  });

  test("done issue retires the finding; per-pull is shown beside it, reachable in flow", async () => {
    const before = readRepeats(app.db, repo.id, now);
    expect(before).toMatchObject({ proposed: 1, retired: 0 });
    app.db.query(`UPDATE issue SET state = 'closed', close_reason = 'done' WHERE repo_id = ?1 AND title LIKE 'Automate%'`).run(repo.id);
    await sweepRepeats(app, repo, new Date(now.getTime() + 30 * 3_600_000));
    const after = readRepeats(app.db, repo.id, now);
    expect(after.retired).toBe(1);
    expect(after.thisWeek).toMatchObject({ comments: 4, pulls: 4, per: 1 });
    expect(after.says).toContain("1 retired");
    expect(after.says).toContain("per pull 1 this week, 0 last");
    const flow = flowFor(app, { kind: "agent" } as never, now);
    expect(flow.reviewRepeats.retired).toBe(1);
    expect(repeatLines(after, 80).join(" ")).toContain("Review repeats");
    expect(repeatLines(readRepeats(app.db, "none", now), 80)).toEqual([]);
  });

  test("a finding older than a week is not counted", async () => {
    const stale = Array.from({ length: 4 }, () => reviewed("- Rename the exported helper so its name says what it returns", 9 * 86_400_000));
    expect(stale).toHaveLength(4);
    expect((await sweepRepeats(app, repo, new Date(now.getTime() + 60 * 3_600_000))).proposed).toEqual([]);
  });
});

describe("what is not a repeat", () => {
  const f = (text: string, pull: number, repo = "r") => ({ repo, pull, author: "a", authorId: "i", text });
  const at = () => new Date(now.getTime() - 3_600_000).toISOString();
  const pullIn = (r: Repo, author: User): { id: string } => {
    const p = createIssue(app.db, { repoId: r.id, authorId: author.id, title: "w", kind: "pull" });
    if (!p.ok) throw new Error(p.error);
    return p.value;
  };
  const review = (issue: string, by: User, body: string): void => {
    app.db
      .query(`INSERT INTO review (id, issue_id, author_id, state, body, created_at) VALUES (?1, ?2, ?3, 'changes_requested', ?4, ?5)`)
      .run(crypto.randomUUID(), issue, by.id, body, at());
  };

  test("one pull saying a finding twice counts once", () => {
    const ask = "Escape the user name before rendering it into the page";
    expect(group([f(ask, 1), f(ask, 1), f(ask, 1), f(ask, 1)])[0]?.findings).toHaveLength(1);
    expect(group([f(ask, 1), f(ask, 1, "other"), f(ask, 2)])[0]?.findings).toHaveLength(3);
  });

  test("a review body and its line comment on one pull are one finding", async () => {
    const made = await createRepo(app, builder, { name: "solo", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const ask = "Validate the length of the title at the boundary";
    for (let i = 0; i < 3; i++) {
      const p = pullIn(made.value, builder);
      review(p.id, reviewer, `- ${ask}`);
      app.db
        .query(`INSERT INTO comment (id, issue_id, author_id, kind, body, created_at) VALUES (?1, ?2, ?3, 'review', ?4, ?5)`)
        .run(crypto.randomUUID(), p.id, reviewer.id, ask, at());
    }
    // three pulls, each saying it twice: six lines, three repeats
    expect((await sweepRepeats(app, made.value, new Date(now.getTime() + 60 * 3_600_000))).proposed).toEqual([]);
    // one more pull makes four pulls, and proposes
    review(pullIn(made.value, builder).id, reviewer, `- ${ask}`);
    expect((await sweepRepeats(app, made.value, new Date(now.getTime() + 90 * 3_600_000))).proposed).toHaveLength(1);
  });

  test("the pull's own author and other repositories do not add up", async () => {
    const a = await createRepo(app, builder, { name: "left", visibility: "public" });
    const b = await createRepo(app, builder, { name: "right", visibility: "public" });
    if (!a.ok || !b.ok) throw new Error("repo");
    const ask = "Cache the immutable assets with a long max-age";
    for (let i = 0; i < 2; i++) review(pullIn(a.value, builder).id, reviewer, `- ${ask}`);
    for (let i = 0; i < 2; i++) review(pullIn(b.value, builder).id, reviewer, `- ${ask}`);
    for (let i = 0; i < 4; i++) review(pullIn(a.value, builder).id, builder, `- ${ask}`); // own comments
    const later = new Date(now.getTime() + 120 * 3_600_000);
    expect((await sweepRepeats(app, a.value, later)).proposed).toEqual([]);
    expect((await sweepRepeats(app, b.value, later)).proposed).toEqual([]);
  });
});

describe("the web door", () => {
  test("the boards panel shows the line, labelled by scope, escaped", async () => {
    const { flowPanel } = await import("../src/web/pages/flow-panel.ts");
    const draw = (kind: "owner" | "agent") => String(flowPanel(app, { kind }, new URL("http://x/boards"), "/boards"));
    expect(draw("owner")).toContain("Review repeats");
    expect(draw("owner")).toContain("all repositories:");
    expect(draw("owner")).toMatch(/proposed as checks, \d+ retired/);
    app.db.query(`UPDATE review_finding SET sample = '<script>x</script>' WHERE id = (SELECT MAX(id) FROM review_finding)`).run();
    expect(draw("owner")).not.toContain("<script>x");
    expect(draw("owner")).toContain("&lt;script&gt;");
    expect(draw("agent")).toContain("public repositories:");
  });
});

describe("a lead-in line is not a finding (#8838)", () => {
  test("linesOf drops the line that only introduces a list", async () => {
    const { linesOf } = await import("../src/flow/repeats.ts");
    expect(
      linesOf("Smaller, but please fix in the same round:\n- Move these two lines below the spread.\n- Add a test for the agent admin case."),
    ).toEqual(["Move these two lines below the spread.", "Add a test for the agent admin case."]);
    // reviews opening the same way are not a repeated ask
    expect(linesOf("Smaller points, fix in the same round:")).toEqual([]);
    for (const bare of ["**Smaller points:**", "_Fix in the same round:_", "**Smaller points, fix in the same round:** ", "*__Fix them in the same round:__*"])
      expect(linesOf(bare)).toEqual([]);
    // a real ask that merely contains a colon stays
    expect(linesOf("**High:** `flowOnly` is missing from the agent refusal.")).toEqual(["**High:** `flowOnly` is missing from the agent refusal."]);
  });
});

describe("a count is not a finding (#9322)", () => {
  const openers = ["Two things to fix, first one first.", "Two things to fix in one round.", "Two things to fix, one round.", "Two things to fix, in one round."];

  test("linesOf drops a line that only counts what follows, and keeps a request that starts with a count", () => {
    for (const line of [...openers, "Three points, one round.", "**Two things to fix, first one first.**", "2 issues, both small."])
      expect(linesOf(line)).toEqual([]);
    expect(linesOf("Two things to fix, first one first.\n- Escape the user name in the page.")).toEqual(["Escape the user name in the page."]);
    for (const kept of ["Two tests share a port; give each its own", "Two things in `src/flow/repeats.ts` need a test.", "Two fixes in src/flow/repeats.ts must land together."])
      expect(linesOf(kept)).toEqual([kept]);
  });

  test("a week of reviews opening with those lines makes no due group", async () => {
    const r = await createRepo(app, builder, { name: "counts", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    for (const [i, body] of openers.entries()) {
      const pull = createIssue(app.db, { repoId: r.value.id, authorId: builder.id, title: "work", kind: "pull" });
      if (!pull.ok) throw new Error(pull.error);
      app.db
        .query(`INSERT INTO review (id, issue_id, author_id, state, body, created_at) VALUES (?1, ?2, ?3, 'changes_requested', ?4, ?5)`)
        .run(crypto.randomUUID(), pull.value.id, reviewer.id, body, new Date(now.getTime() - (i + 1) * 3_600_000).toISOString());
    }
    expect(await dueGroups(app.db, r.value.id, now)).toEqual([]);
  });
});
