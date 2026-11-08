/**
 * An issue found already done is the asker's to close, not a park: a builder
 * that names a commit on the base records the outcome, shows it, strikes
 * nothing, and leaves the planner's list. Split from
 * `test/crew-parks.test.ts`, whose `engine` it shares.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  addComment,
  openIssue,
  setIssueState,
} from "../src/actions/issues.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { getIssueById, listComments, type Issue } from "../src/core/issues.ts";
import { createUser } from "../src/core/users.ts";
import { parkedCount, settleAgentRun } from "../src/crew/autonomy.ts";
import {
  alreadyDoneOids,
  alreadyDoneSummary,
  namedCommits,
  onBase,
} from "../src/crew/already.ts";
import { repoDir } from "../src/git/repos.ts";
import { alreadyDone } from "../src/core/done_on_main.ts";
import { askedIn, askedJson } from "../src/core/asked.ts";
import { answerCancelled, cancelRun, createRun } from "../src/core/runs.ts";
import { parkedTwice, struckOut } from "../src/crew/parks.ts";
import { engine, tick, type Engine } from "./helpers/parks-engine.ts";

describe("an issue found already done is the asker's to close, not a park", () => {
  let e: Engine;
  let oid: string;
  const settle = (on: Issue, state: "ok" | "failed", summary: string) =>
    settleAgentRun(e.app, e.fresh(), {
      issueId: on.id,
      state,
      summary,
      reason: "assigned",
      actorId: e.mason.id,
    });

  beforeAll(async () => {
    e = await engine("forge-already-");
    const seeded = await commitToBranch(e.app, e.alice, e.repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    oid = seeded.value.commitOid;
  });
  afterAll(() => e.close());

  test("only a named commit that is on the base counts", async () => {
    const dir = repoDir(e.app.reposRoot, e.repo.ownerName, e.repo.name);
    expect(namedCommits("already done on main in " + oid.slice(0, 9))).toEqual([
      oid.slice(0, 9),
    ]);
    expect(namedCommits("already done on main")).toEqual([]);
    expect(namedCommits("out of scope, see " + oid.slice(0, 9))).toEqual([]);
    expect(await onBase(dir, "main", [oid.slice(0, 9)])).toEqual([oid]);
    expect(await onBase(dir, "main", ["deadbeef"])).toEqual([]);
    expect(await onBase(dir, "nope", [oid.slice(0, 9)])).toEqual([]);
  });

  test("an already-done outcome is recorded, shown, and no strike", async () => {
    const work = e.issue("Already built");
    const summary = alreadyDoneSummary([oid]);
    expect(alreadyDoneOids(summary)).toEqual([oid]);
    for (let n = 0; n < 3; n++) {
      expect(settle(work, "ok", summary)).toBe(true);
      await tick();
    }
    const parks = listComments(e.app.db, work.id).filter((c) =>
      c.body.startsWith("Parked by the crew"),
    );
    expect(parks).toEqual([]);
    expect(parkedCount(e.app, e.fresh(), work.id)).toBe(0);
    expect(struckOut(e.app.db, e.fresh(), [work.id]).has(work.id)).toBe(false);
    expect(alreadyDone(e.app.db, [work.id]).get(work.id)).toEqual([oid]);
    expect(getIssueById(e.app.db, work.id)!.state).toBe("open");

    const signin = await fetch(`${e.servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({
        username: "alice",
        password: "a-good-passphrase",
      }),
      redirect: "manual",
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await (
      await fetch(`${e.servers.url}/alice/engine/issues/${work.number}`, {
        headers: { cookie },
      })
    ).text();
    expect(page).toContain("waiting for you to close it");
    expect(page).toContain(`/commit/${oid}`);

    const closed = await fetch(
      `${e.servers.url}/alice/engine/issues/${work.number}/state`,
      {
        method: "POST",
        headers: { cookie, origin: e.servers.url },
        body: new URLSearchParams({ state: "closed", reason: "done" }),
        redirect: "manual",
      },
    );
    expect(closed.status).toBeLessThan(400);
    expect(getIssueById(e.app.db, work.id)!.state).toBe("closed");
    expect(
      listComments(e.app.db, work.id).some((c) =>
        c.body.startsWith(`Closed: already done on main in [\`${oid.slice(0, 7)}\``),
      ),
    ).toBe(true);
  });

  test("the asked JSON carries the commits; closing through any door writes the note", async () => {
    const work = e.issue("Asked and already built");
    expect(settle(work, "ok", alreadyDoneSummary([oid]))).toBe(true);
    const row = askedIn(e.app.db, [e.fresh()], { show: "all" }).find(
      (a) => a.issue.id === work.id,
    )!;
    expect(askedJson(row).doneBy).toEqual([oid]);
    // Not the web form: the same close the terminal makes.
    expect(setIssueState(e.app, e.alice, e.fresh(), work, "closed").ok).toBe(true);
    const comments = listComments(e.app.db, work.id).filter((c) =>
      c.body.startsWith("Closed: already done on main in "),
    );
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain(oid.slice(0, 7));
    // An issue with no note closes without one.
    const plain = e.issue("Closed plainly");
    expect(setIssueState(e.app, e.alice, e.fresh(), plain, "closed").ok).toBe(true);
    expect(
      listComments(e.app.db, plain.id).some((c) => c.body.startsWith("Closed:")),
    ).toBe(false);
  });

  test("the asked page says done on main, with the commits", async () => {
    const work = e.issue("Asked page");
    expect(settle(work, "ok", alreadyDoneSummary([oid]))).toBe(true);
    const signin = await fetch(`${e.servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({
        username: "alice",
        password: "a-good-passphrase",
      }),
      redirect: "manual",
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await (
      await fetch(`${e.servers.url}/asked`, { headers: { cookie } })
    ).text();
    expect(page).toContain("Done on main");
    expect(page).toContain(`on main in ${oid.slice(0, 7)}, waiting for you to close it`);
  });

  test("an issue parked twice and then found done leaves the planner's list", () => {
    const work = e.issue("Parked, then built");
    e.ended(work, "no changes pushed: DECLINED: out of scope");
    e.ended(work, "no changes pushed: DECLINED: out of scope");
    const listed = () =>
      parkedTwice(e.app.db, [e.fresh()]).some((p) => p.issueId === work.id);
    expect(listed()).toBe(true);
    expect(settle(work, "ok", alreadyDoneSummary([oid]))).toBe(true);
    expect(alreadyDone(e.app.db, [work.id]).get(work.id)).toEqual([oid]);
    expect(listed()).toBe(false);
  });

  test("writes in one millisecond are read in the order they were written", () => {
    // What a fast machine does by chance, every time: one timestamp for all.
    const at = new Date().toISOString();
    const stamp = (...on: Issue[]) => {
      for (const one of on) {
        e.app.db.query("UPDATE issue SET created_at = ?1 WHERE id = ?2").run(at, one.id);
        e.app.db.query("UPDATE comment SET created_at = ?1 WHERE issue_id = ?2").run(at, one.id);
      }
    };
    const now = (on: Issue): Issue => {
      const found = getIssueById(e.app.db, on.id);
      if (found === undefined) throw new Error(`no issue ${on.id}`);
      return found;
    };
    const declined = "no changes pushed: DECLINED: out of scope";
    const split = (on: Issue, into: Issue) => {
      const closed = setIssueState(e.app, e.atlas, e.fresh(), now(on), "closed", {
        reason: "split",
        into: [into.number],
      });
      return closed.ok ? "closed" : closed.error;
    };
    // Parked twice, then found done: the note is the newest word.
    const built = e.issue("Parked, then built");
    e.ended(built, declined);
    e.ended(built, declined);
    expect(settle(built, "ok", alreadyDoneSummary([oid]))).toBe(true);
    stamp(built);
    expect(parkedTwice(e.app.db, [e.fresh()]).some((p) => p.issueId === built.id)).toBe(false);
    expect(alreadyDone(e.app.db, [built.id]).get(built.id)).toEqual([oid]);
    // Found done, then parked: the park is.
    const undone = e.issue("Built, then parked");
    expect(settle(undone, "ok", alreadyDoneSummary([oid]))).toBe(true);
    e.ended(undone, declined);
    stamp(undone);
    expect(alreadyDone(e.app.db, [undone.id]).has(undone.id)).toBe(false);
    // A person's word, then two parks: both count.
    const told = e.issue("Told, then parked");
    expect(addComment(e.app, e.alice, e.fresh(), now(told), "Try it smaller.").ok).toBe(true);
    e.ended(told, declined);
    e.ended(told, declined);
    stamp(told);
    expect(parkedCount(e.app, e.fresh(), told.id)).toBe(2);
    // Handed over, then split into an issue opened after the hand-over.
    const half = e.issue("Told, then parked: the first half");
    stamp(told, half);
    expect(split(told, half)).toBe("closed");
    // Re-planned on its own pass: into the issue opened after it, not before.
    const older = e.issue("Opened first");
    const newer = e.issue("Opened second");
    stamp(older, newer);
    expect(split(newer, older)).toBe("forbidden");
    expect(split(older, newer)).toBe("closed");
  });

  test("the planner re-planning on its own pass: splits, drops what the crew wrote, closes what is done, and no more", async () => {
    const { atlas, mason } = e;
    const state = (on: Issue) => getIssueById(e.app.db, on.id)!;
    const close = (
      on: Issue,
      how?: { reason: "done" | "dropped" | "split"; into?: number[] },
    ) => {
      const closed = setIssueState(e.app, atlas, e.fresh(), state(on), "closed", how);
      return closed.ok ? "closed" : closed.error;
    };
    // Nobody handed any of these over: a person's ask, never parked.
    const asked = e.issue("Re-plan me");
    const stale = e.issue("Opened before the ask");
    const part = e.issue("Re-plan me, the first half");
    // Split, into an issue opened since.
    expect(close(asked, { reason: "split", into: [part.number] })).toBe("closed");
    expect(state(asked).closeReason).toBe("split");
    // Refused: into an issue older than the issue, or a closed one.
    const again = e.issue("Re-plan me too");
    expect(close(again, { reason: "split", into: [stale.number] })).toBe("forbidden");
    expect(close(again, { reason: "split", into: [asked.number] })).toBe("forbidden");
    // Refused: dropping a person's ask.
    expect(close(again, { reason: "dropped" })).toBe("forbidden");
    // Refused: done with no done note, said or not.
    expect(close(again)).toBe("forbidden");
    expect(close(again, { reason: "done" })).toBe("forbidden");
    expect(state(again).state).toBe("open");
    // Dropped: an issue the crew wrote.
    const made = openIssue(e.app, mason, e.fresh(), { title: "Crew's own chore" });
    if (!made.ok) throw new Error(String(made.error));
    expect(close(made.value, { reason: "dropped" })).toBe("closed");
    expect(state(made.value).closeReason).toBe("dropped");
    // Done: when commits on main are named for it.
    const built = e.issue("Already built, found by the planner");
    expect(
      settleAgentRun(e.app, e.fresh(), {
        issueId: built.id,
        state: "ok",
        summary: alreadyDoneSummary([oid]),
        reason: "assigned",
        actorId: mason.id,
      }),
    ).toBe(true);
    expect(close(built, { reason: "done" })).toBe("closed");
    expect(state(built).closeReason).toBe("done");
    // Never a reopen.
    const reopened = setIssueState(e.app, atlas, e.fresh(), state(made.value), "open");
    expect(reopened.ok ? "open" : reopened.error).toBe("forbidden");
    // A builder has none of it.
    const other = e.issue("Not for builders");
    const own = setIssueState(e.app, mason, e.fresh(), other, "closed", { reason: "split", into: [part.number] });
    expect(own.ok ? "closed" : own.error).toBe("forbidden");
  });

  test("the planner closes an umbrella as split into issues that all closed as done since, and no other", async () => {
    const { atlas } = e;
    const state = (on: Issue) => getIssueById(e.app.db, on.id)!;
    const close = (on: Issue, into: number[]) => {
      const closed = setIssueState(e.app, atlas, e.fresh(), state(on), "closed", {
        reason: "split",
        into,
      });
      return closed.ok ? "closed" : closed.error;
    };
    const finish = (on: Issue, reason: "done" | "dropped") => {
      const r = setIssueState(e.app, e.alice, e.fresh(), state(on), "closed", { reason });
      if (!r.ok) throw new Error(String(r.error));
    };
    // Old, unrelated work that closed as done before the umbrella existed.
    const old = e.issue("Old unrelated work");
    finish(old, "done");
    await Bun.sleep(5);
    const umbrella = e.issue("Umbrella");
    await Bun.sleep(5);
    const a = e.issue("Piece A");
    const b = e.issue("Piece B");
    const dropped = e.issue("Piece dropped");
    const open = e.issue("Piece still open, older than nothing");
    finish(a, "done");
    finish(dropped, "dropped");
    // Refused: an old done issue is no piece of it, alone or beside a real one.
    expect(close(umbrella, [old.number])).toBe("forbidden");
    finish(b, "done");
    expect(close(umbrella, [a.number, old.number])).toBe("forbidden");
    // Refused: itself, a dropped piece, an open one, a done beside a fresh open.
    expect(close(umbrella, [a.number, umbrella.number])).toBe("forbidden");
    expect(close(umbrella, [a.number, dropped.number])).toBe("forbidden");
    expect(close(umbrella, [a.number, open.number])).toBe("forbidden");
    await Bun.sleep(5);
    const fresh = e.issue("Fresh piece, open");
    expect(close(umbrella, [a.number, fresh.number])).toBe("forbidden");
    // Refused: a number that is no issue here (another repository's is none of this one's).
    expect(close(umbrella, [a.number, 99999])).toBe("forbidden");
    expect(state(umbrella).state).toBe("open");
    // Allowed: every piece closed as done since.
    expect(close(umbrella, [a.number, b.number])).toBe("closed");
    expect(state(umbrella).closeReason).toBe("split");
  });

  test("another person's comment that reads like the note is that person's word", async () => {
    const carol = await createUser(e.app.db, {
      origin: "seed",
      trusted: true,
      username: "carol",
      email: "carol@forge.local",
      password: "a-good-passphrase",
    });
    if (!carol.ok) throw new Error(carol.error);
    // Anyone who can read may direct the crew here, for this test only.
    e.app.db.run("UPDATE repo SET visibility = 'public', crew_outsiders = 1 WHERE id = ?1", [e.repo.id]);
    try {
      const work = e.issue("Words");
      e.ended(work, "no changes pushed: DECLINED: out of scope");
      expect(parkedCount(e.app, e.fresh(), work.id)).toBe(1);
      await tick();
      addComment(
        e.app,
        carol.value,
        e.fresh(),
        work,
        "Done on main already, waiting for you to close it: try again anyway",
      );
      expect(parkedCount(e.app, e.fresh(), work.id)).toBe(0);
      expect(alreadyDone(e.app.db, [work.id]).has(work.id)).toBe(false);
    } finally {
      e.app.db.run("UPDATE repo SET visibility = 'private', crew_outsiders = 0 WHERE id = ?1", [e.repo.id]);
    }
  });

  test("an ordinary decline, or a claim with no commit, still parks", () => {
    const work = e.issue("Out of scope");
    expect(settle(work, "ok", "no changes pushed: DECLINED: out of scope")).toBe(true);
    expect(parkedCount(e.app, e.fresh(), work.id)).toBe(1);
    expect(alreadyDone(e.app.db, [work.id]).has(work.id)).toBe(false);
    expect(alreadyDoneOids("no changes pushed: already done: " + oid)).toEqual([]);
  });

  test("an issue parked twice whose newest crew note is the done note is not handed to the planner", () => {
    const park = (on: Issue) => {
      for (let n = 0; n < 2; n++)
        addComment(e.app, e.mason, e.fresh(), on, "Parked by the crew: " + nothingNew);
    };
    const nothingNew = "the run ended without a pull: nothing to propose";
    const finished = e.issue("Parked, then found done");
    const open = e.issue("Parked, still open");
    park(finished);
    park(open);
    const numbers = () => parkedTwice(e.app.db, [e.fresh()]).map((i) => i.number);
    expect(numbers()).toEqual([finished.number, open.number]);
    addComment(
      e.app,
      e.mason,
      e.fresh(),
      finished,
      "Done on main already, waiting for you to close it: " + oid,
    );
    // Written in the same instant as the park: the clock cannot order them.
    e.app.db.run(
      `UPDATE comment SET created_at = (SELECT MAX(p.created_at) FROM comment p
         WHERE p.issue_id = ?1 AND p.body LIKE 'Parked by the crew%')
       WHERE issue_id = ?1 AND body LIKE 'Done on main already%'`,
      [finished.id],
    );
    expect(alreadyDone(e.app.db, [finished.id]).get(finished.id)).toEqual([oid]);
    expect(numbers()).toEqual([open.number]);
  });

  const cancelledByItsPull = (on: Issue) => {
    const run = createRun(e.app.db, {
      repoId: e.fresh().id,
      kind: "agent",
      issueId: on.id,
      actorId: e.mason.id,
      reason: "assigned",
    });
    e.app.db.run(`UPDATE run SET state = 'running' WHERE id = ?1`, [run.id]);
    cancelRun(e.app.db, run.id, "the pull closed");
    return run.id;
  };

  test("a run its pull closed under, that had answered already done, notes the issue and holds it", () => {
    const work = e.issue("Closed under its decline");
    const runId = cancelledByItsPull(work);
    const run = answerCancelled(e.app.db, runId, {
      state: "ok",
      summary: alreadyDoneSummary([oid]),
    })!;
    expect(run.summary).toBe(`already done: ${oid}`);
    expect(
      settleAgentRun(e.app, e.fresh(), {
        issueId: work.id,
        state: run.state,
        summary: run.summary,
        reason: "assigned",
        actorId: e.mason.id,
      }),
    ).toBe(true);
    expect(alreadyDone(e.app.db, [work.id]).get(work.id)).toEqual([oid]);
    expect(parkedCount(e.app, e.fresh(), work.id)).toBe(0);
  });

  test("answerCancelled touches only a run its pull cancelled", () => {
    const work = e.issue("Cancelled for another reason");
    const other = createRun(e.app.db, { repoId: e.fresh().id, kind: "agent", issueId: work.id });
    cancelRun(e.app.db, other.id, "cancelled");
    const done = { state: "ok" as const, summary: alreadyDoneSummary([oid]) };
    expect(answerCancelled(e.app.db, other.id, done)).toBeUndefined();
    const runId = cancelledByItsPull(work);
    expect(answerCancelled(e.app.db, runId, done)).toBeDefined();
    expect(answerCancelled(e.app.db, runId, done)).toBeUndefined();
  });
});
