/**
 * Review is owed from the check's green, not the preview deploy's (#1216):
 * a slow check queue must not lapse a pull before review was ever sent.
 */

import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import {} from "../src/core/agents.ts";
import type { Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun, listRuns } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { sendToReview, waitsForPerson } from "../src/crew/review.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const T0 = Date.parse("2026-10-13T03:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000);

describe("review is owed from the check's green", () => {
  let dataDir = "";
  let app: App;
  let alice: User;
  let repo: Repo;
  let n = 0;

  const fresh = () => getRepoById(app.db, repo.id)!;
  const reviewRuns = (pull: Pull) =>
    listRuns(app.db, repo.id, { issueId: pull.id }).filter(
      (r) => r.reason === "review",
    );
  const pullOn = async (): Promise<Pull> => {
    const branch = `b${++n}`;
    const c = await commitToBranch(app, alice, repo, {
      branch,
      base: "main",
      message: branch,
      files: [{ path: `${branch}.md`, content: "x\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const o = await openPull(app, alice, repo, {
      title: branch,
      body: "",
      baseBranch: "main",
      headBranch: branch,
    });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
  };
  const green = (pull: Pull, kind: "check" | "deploy", queued: number, done: number) => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind,
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "ok" });
    app.db
      .query("UPDATE run SET created_at = ?2, finished_at = ?3 WHERE id = ?1")
      .run(run.id, at(queued).toISOString(), at(done).toISOString());
  };
  const agentPull = async () => {
    const pull = await pullOn();
    return { ...pull, authorIsAgent: true };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-review-check-"));
    app = createApp({ dataDir, port: 0 });
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const r = await createRepo(app, alice, { name: "garden", visibility: "private" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const agent = await createAgent(app, alice, { username: "quill" });
    if (!agent.ok) throw new Error(String(agent.error));
    addToCrew(app, alice, repo, "quill");
    seatAs(app.db, repo.id, getUserByName(app.db, "quill")!.id, "reviewer");
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a deploy green at t=0 and a check green at t=70 min: sent at t=70, not lapsed", async () => {
    const pull = await agentPull();
    green(pull, "deploy", 0, 0);
    green(pull, "check", 0, 70);
    expect(waitsForPerson(app.db, repo.id, pull, at(70))).toBeUndefined();
    expect(await sendToReview(app, fresh(), pull, at(70))).toBe("sent");
    expect(reviewRuns(pull)).toHaveLength(1);
  });

  test("a head with no check is reviewed from its deploy, as before", async () => {
    const pull = await agentPull();
    green(pull, "deploy", 0, 0);
    expect(await sendToReview(app, fresh(), pull, at(1))).toBe("sent");
    expect(await sendToReview(app, fresh(), pull, at(1))).toBe("wait");
  });

  test("a head that went green long ago and was never sent is sent once, late, and says so if it lapses", async () => {
    const pull = await agentPull();
    green(pull, "check", 0, 72);
    // Green at 72; the first look comes at 140, past the lapse.
    expect(await sendToReview(app, fresh(), pull, at(72 + 70))).toBe("sent");
    const run = reviewRuns(pull)[0]!;
    app.db
      .query("UPDATE run SET created_at = ?2 WHERE id = ?1")
      .run(run.id, at(72 + 70).toISOString());
    // The late review is out: the lapse counts from its sending.
    expect(waitsForPerson(app.db, repo.id, pull, at(72 + 80))).toBeUndefined();
    app.db.query("UPDATE run SET state = 'failed' WHERE id = ?1").run(run.id);
    const wait = waitsForPerson(app.db, repo.id, pull, at(72 + 70 + 61));
    expect(wait?.why).toBe("lapsed");
    expect(wait?.lateCheckMinutes).toBe(72);
  });
});
