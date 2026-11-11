import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { deleteRepo } from "../src/actions/repos.ts";
import { doctorRuns, HOLD_PREFIX, isDoctorHold, noteRed, RUNS_KEPT, treatRed } from "../src/checks/doctor.ts";
import { getHold } from "../src/core/holds.ts";
import { listComments } from "../src/core/issues.ts";
import { doctorWorld, redFor, type Doctor } from "./helpers/doctor.ts";

describe("the batch doctor and a red culprit", () => {
  let w: Doctor;
  beforeAll(async () => {
    w = await doctorWorld("culprit");
  });
  afterAll(() => w.close());

  test("a functional red alone is held with a comment naming test, file, error and command; the batch is recorded", async () => {
    const pull = await w.pull("bad.ts");
    const red = redFor("adds two numbers", "test/add.test.ts", "error: expect(received).toBe(expected)");
    expect(treatRed(w.app, w.repo, w.alice, pull, red, "b".repeat(40))).toBe("held");
    const hold = getHold(w.app.db, pull.id)!;
    expect(hold.until).toBe("green");
    expect(hold.why).toContain("adds two numbers");
    expect(hold.why.startsWith(HOLD_PREFIX)).toBe(true);
    expect(isDoctorHold(hold.why)).toBe(true);
    expect(isDoctorHold("waiting on a person")).toBe(false);
    const said = listComments(w.app.db, pull.id).map((c) => c.body).join("\n");
    expect(said).toContain("adds two numbers");
    expect(said).toContain("test/add.test.ts");
    expect(said).toContain("expect(received).toBe(expected)");
    expect(said).toContain("bun test ./test/add.test.ts");
    const [run] = doctorRuns(w.app.db, w.repo.id);
    expect(run).toMatchObject({ culprit: pull.number, class: "functional", action: "held" });
    expect(run!.batch).toStartWith("bbbbbbbbbbbb:");
    expect(run!.probe).toContain("expect(received)");
  });

  test("a budget-only red is rechecked, not held", async () => {
    const pull = await w.pull("slow.ts");
    const red = redFor("serves /", "test/slow.test.ts", "error: over budget (expectBudget): 90ms");
    expect(treatRed(w.app, w.repo, w.alice, pull, red, "c".repeat(40))).toBe("recheck");
    expect(getHold(w.app.db, pull.id)).toBeUndefined();
    expect(doctorRuns(w.app.db, w.repo.id)[0]).toMatchObject({ class: "budget", action: "recheck" });
  });

  test("the doctor keeps only its newest RUNS_KEPT runs per repository", async () => {
    const pull = await w.pull("many.ts");
    const red = redFor("serves /", "test/slow.test.ts", "error: over budget (expectBudget): 90ms");
    for (let i = 0; i < RUNS_KEPT + 5; i++) treatRed(w.app, w.repo, w.alice, pull, red, "e".repeat(40));
    const kept = w.app.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM maintenance_run WHERE repo_id = ?1")
      .get(w.repo.id)!.n;
    expect(kept).toBe(RUNS_KEPT);
  });

  test("a test name with a backtick and @admin cannot break out of the span in the comment or the hold", async () => {
    const pull = await w.pull("evil.ts");
    const red = redFor("x` @admin [a](http://e.test) `", "test/e`@bob.test.ts", "error: boom` @carol");
    expect(treatRed(w.app, w.repo, w.alice, pull, red, "f".repeat(40))).toBe("held");
    const said = listComments(w.app.db, pull.id).map((c) => c.body).join("\n");
    expect(said).not.toContain("@admin");
    expect(said).not.toContain("@bob");
    expect(said).not.toContain("@carol");
    expect(getHold(w.app.db, pull.id)!.why).not.toContain("@");
    expect(getHold(w.app.db, pull.id)!.why).not.toContain("`");
    expect(said.split("`").length % 2).toBe(1);
    expect(said.match(/`[^`\n]*`/g)!.join("")).not.toContain("@");
  });

  test("deleting the repository deletes its doctor rows", async () => {
    const other = await doctorWorld("culprit-gone");
    try {
      const pull = await other.pull("g.ts");
      treatRed(other.app, other.repo, other.alice, pull, redFor("t", "test/t.test.ts", "error: x"), "a".repeat(40));
      expect(doctorRuns(other.app.db, other.repo.id).length).toBe(1);
      expect((await deleteRepo(other.app, other.alice, other.repo)).ok).toBe(true);
      expect(doctorRuns(other.app.db, other.repo.id).length).toBe(0);
    } finally {
      await other.close();
    }
  });
});

describe("the batch doctor and a red with no single culprit", () => {
  test("a red on top of landed pulls is classed and recorded with its members, and not held", async () => {
    const w = await doctorWorld("together");
    try {
      const pull = await w.pull("mix.ts");
      noteRed(w.app, w.repo, pull, redFor("mixes", "test/mix.test.ts", "error: boom"), "a".repeat(40), [7, 9]);
      expect(getHold(w.app.db, pull.id)).toBeUndefined();
      const [run] = doctorRuns(w.app.db, w.repo.id);
      expect(run).toMatchObject({ culprit: pull.number, class: "functional", action: "recheck" });
      expect(run!.batch).toEndWith("+#7,#9");
      noteRed(w.app, w.repo, pull, redFor("mixes", "test/mix.test.ts", "error: boom"), "a".repeat(40), []);
      expect(doctorRuns(w.app.db, w.repo.id)).toHaveLength(1);
      // The same head and members again is one row; other members are another.
      noteRed(w.app, w.repo, pull, redFor("mixes", "test/mix.test.ts", "error: boom"), "b".repeat(40), [7, 9]);
      expect(doctorRuns(w.app.db, w.repo.id)).toHaveLength(1);
      noteRed(w.app, w.repo, pull, redFor("mixes", "test/mix.test.ts", "error: boom"), "b".repeat(40), [7]);
      expect(doctorRuns(w.app.db, w.repo.id)).toHaveLength(2);
    } finally {
      await w.close();
    }
  });
});
