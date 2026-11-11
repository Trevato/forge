import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { releaseOnGreen } from "../src/actions/holds.ts";
import { treatRed } from "../src/checks/doctor.ts";
import { getHold } from "../src/core/holds.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { doctorWorld, redFor, type Doctor } from "./helpers/doctor.ts";

describe("a hold the doctor set lifts on a green new head", () => {
  let w: Doctor;
  beforeAll(async () => {
    w = await doctorWorld("lift");
  });
  afterAll(() => w.close());

  const check = (pullId: string, number: number, commitOid: string, state: "ok" | "failed") => {
    const run = createRun(w.app.db, { repoId: w.repo.id, kind: "check", issueId: pullId, env: `pull-${number}`, commitOid, reason: "pull" });
    claimRun(w.app.db, run.id);
    return finishRun(w.app.db, run.id, { state, summary: state })!;
  };

  test("a red check keeps it, a green check of the head lets it go", async () => {
    const pull = await w.pull("lift.ts");
    treatRed(w.app, w.repo, w.alice, pull, redFor("t", "test/t.test.ts", "error: boom"), "e".repeat(40));
    expect(getHold(w.app.db, pull.id)).toBeDefined();
    expect(releaseOnGreen(w.app, check(pull.id, pull.number, pull.headOid, "failed"))).toBe(false);
    expect(getHold(w.app.db, pull.id)).toBeDefined();
    expect(releaseOnGreen(w.app, check(pull.id, pull.number, pull.headOid, "ok"))).toBe(true);
    expect(getHold(w.app.db, pull.id)).toBeUndefined();
  });
});
