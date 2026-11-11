import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { releaseOnGreen } from "../src/actions/holds.ts";
import { doctorRuns, treatRed } from "../src/checks/doctor.ts";
import { getHold, setHold } from "../src/core/holds.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { doctorWorld, redFor, type Doctor } from "./helpers/doctor.ts";

describe("the doctor never touches a hold a person set", () => {
  let w: Doctor;
  beforeAll(async () => {
    w = await doctorWorld("person");
  });
  afterAll(() => w.close());

  test("a person's hold stands through a functional red: kept, not overwritten", async () => {
    const pull = await w.pull("mine.ts");
    setHold(w.app.db, pull.id, w.alice.id, "waiting on design");
    const action = treatRed(w.app, w.repo, w.alice, pull, redFor("t", "test/t.test.ts", "error: boom"), "f".repeat(40));
    expect(action).toBe("kept");
    expect(getHold(w.app.db, pull.id)).toMatchObject({ why: "waiting on design", heldByName: "alice" });
    expect(doctorRuns(w.app.db, w.repo.id)[0]).toMatchObject({ action: "kept" });
  });

  test("a green check does not lift a person's plain hold", async () => {
    const pull = await w.pull("mine2.ts");
    setHold(w.app.db, pull.id, w.alice.id, "waiting on design");
    const run = createRun(w.app.db, { repoId: w.repo.id, kind: "check", issueId: pull.id, env: `pull-${pull.number}`, commitOid: pull.headOid, reason: "pull" });
    claimRun(w.app.db, run.id);
    expect(releaseOnGreen(w.app, finishRun(w.app.db, run.id, { state: "ok", summary: "ok" })!)).toBe(false);
    expect(getHold(w.app.db, pull.id)).toBeDefined();
  });
});
