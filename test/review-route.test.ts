/**
 * Who reviews a pull, and how a review run ends. A change to the
 * security-bearing paths goes to the reviewer whose brief says it reads for
 * security; everything else to the one who reads for the experience. Every
 * green head an agent wrote is sent, in any repository with a reviewer —
 * not only one that ships on its own. A review run is judged by its verdict:
 * it pushes nothing by design.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { type Agent } from "../src/core/agents.ts";
import type { Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import type { Review } from "../src/core/reviews.ts";
import { claimRun, createRun, finishRun, listRuns } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import {
  pickReviewer,
  reviewLoad,
  reviewsInFlight,
  sendToReview,
  REVIEW_LAPSE_MS,
  REVIEW_WAIT_MS,
  reviewStage,
  SWEEP_SENDS,
  sweepReviews,
  touchesDesign,
  touchesSecurity,
  watchesSecurity,
} from "../src/crew/review.ts";
import { settleReview } from "../src/crew/runner.ts";

const SHARED = "How I work, always:\n- Security is not optional.";
const agent = (name: string, brief: string): Agent =>
  ({ user: { username: name }, brief }) as unknown as Agent;
const juniper = agent(
  "juniper",
  `I am Juniper. I review the experience.\n\n${SHARED}`,
);
const sentinel = agent(
  "sentinel",
  `I am Sentinel. I read every changed line for security.\n\n${SHARED}`,
);

describe("which reviewer", () => {
  test("security is read from what the agent says it is, not the rules every brief shares", () => {
    expect(watchesSecurity(sentinel)).toBe(true);
    expect(watchesSecurity(juniper)).toBe(false);
  });

  test("the security-bearing paths", () => {
    for (const p of [
      "src/http/api.ts",
      "src/core/tokens.ts",
      "src/crew/sandbox.ts",
      "src/web/auth.ts",
      "docs/SECRETS.md",
    ])
      expect(touchesSecurity([p])).toBe(true);
    expect(touchesSecurity(["src/web/pages/board.ts", "README.md"])).toBe(
      false,
    );
  });

  test("a security change to sentinel, any other to juniper, and one reviewer takes all", () => {
    const both = [juniper, sentinel];
    expect(pickReviewer(both, ["src/core/tokens.ts"])).toBe(sentinel);
    expect(pickReviewer(both, ["src/web/pages/board.ts"])).toBe(juniper);
    expect(pickReviewer([juniper], ["src/http/api.ts"])).toBe(juniper);
    expect(pickReviewer([sentinel], ["README.md"])).toBe(sentinel);
    expect(pickReviewer([], ["README.md"])).toBeUndefined();
  });
});

describe("a review that does not come back", () => {
  const green = "2026-10-02T10:00:00.000Z";
  const at = (ms: number) => new Date(Date.parse(green) + ms);
  const sent = (ms: number, active: boolean) => ({
    createdAt: at(ms).toISOString(),
    active,
  });

  test("sent first, waited for while it is out, sent once more, then lapsed", () => {
    expect(reviewStage(green, [], at(1_000))).toBe("send");
    expect(reviewStage(green, [sent(0, true)], at(60_000))).toBe("wait");
    // Out past the wait, or back with nothing: one more.
    expect(reviewStage(green, [sent(0, true)], at(REVIEW_WAIT_MS))).toBe(
      "send",
    );
    expect(reviewStage(green, [sent(0, false)], at(60_000))).toBe("send");
    expect(
      reviewStage(green, [sent(0, false), sent(60_000, true)], at(120_000)),
    ).toBe("wait");
    expect(
      reviewStage(green, [sent(0, false), sent(60_000, false)], at(120_000)),
    ).toBe("lapsed");
  });

  test("a head never sent — at the ceiling, say — still lapses, so nothing is held for ever", () => {
    expect(reviewStage(green, [], at(REVIEW_LAPSE_MS))).toBe("lapsed");
  });
});

describe("how a review run ends", () => {
  const verdict = (
    authorId: string,
    createdAt: string,
    commitOid = "old",
  ): Review =>
    ({ authorId, state: "changes_requested", createdAt, commitOid }) as Review;
  const since = "2026-10-02T10:00:00.000Z";

  test("a verdict posted during the run is ok, though nothing was pushed", () => {
    expect(
      settleReview(
        [verdict("j", "2026-10-02T10:05:00.000Z")],
        "j",
        since,
        "head",
      ),
    ).toEqual({ state: "ok", summary: "reviewed: changes requested" });
  });

  test("standing by its verdict on the head it was given is ok too", () => {
    expect(
      settleReview(
        [verdict("j", "2026-10-02T09:00:00.000Z", "head")],
        "j",
        since,
        "head",
      ).state,
    ).toBe("ok");
  });

  test("no verdict, an earlier one on another head, or someone else's is a failed run", () => {
    for (const reviews of [
      [],
      [verdict("j", "2026-10-02T09:00:00.000Z")],
      [verdict("x", "2026-10-02T10:05:00.000Z")],
    ])
      expect(settleReview(reviews, "j", since, "head").state).toBe("failed");
  });
});

describe("every green pull an agent wrote is sent to review", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-review-route-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, {
      name: "engine",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    for (const [name, brief] of [
      ["scout", "I am Scout. I ship small things."],
      ["juniper", juniper.brief],
      ["sentinel", sentinel.brief],
    ] as const) {
      const made = await createAgent(app, alice, { username: name, brief });
      if (!made.ok) throw new Error(String(made.error));
      expect(addToCrew(app, alice, repo, name).ok).toBe(true);
    }
    for (const name of ["juniper", "sentinel"])
      seatAs(app.db, repo.id, getUserByName(app.db, name)!.id, "reviewer");
    // Not autonomous: review is not the shipping loop's alone.
    expect(repo.autonomy).not.toBe("autonomous");
  });

  afterAll(async () => {
    await app.close?.();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function pullBy(author: User, name: string, path: string) {
    await commitToBranch(app, alice, repo, {
      branch: `feature/${name}`,
      base: "main",
      message: name,
      files: [{ path, content: `${name}\n` }],
    });
    const opened = await openPull(app, alice, repo, {
      title: name,
      baseBranch: "main",
      headBranch: `feature/${name}`,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    app.db
      .query("UPDATE issue SET author_id = ?2 WHERE id = ?1")
      .run(opened.value.id, author.id);
    return opened.value;
  }

  function pass(pull: Pull): void {
    const check = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, check.id);
    finishRun(app.db, check.id, { state: "ok", summary: "check passed" });
  }

  const reviewer = (pull: Pull) =>
    listRuns(app.db, repo.id, { issueId: pull.id })
      .filter((r) => r.reason === "review")
      .map((r) => getUserByName(app.db, "juniper")!.id === r.actorId ? "juniper" : "sentinel");

  test("green pulls go to the right reviewer, once; red and people's pulls wait", async () => {
    const scout = getUserByName(app.db, "scout")!;
    const page = await pullBy(scout, "page", "src/web/page.ts");
    const auth = await pullBy(scout, "auth", "src/http/auth.ts");
    const red = await pullBy(scout, "red", "src/web/red.ts");
    const person = await pullBy(alice, "mine", "src/web/mine.ts");
    pass(page);
    pass(auth);
    pass(person);

    expect(await sweepReviews(app)).toBe(2);
    expect(reviewer(page)).toEqual(["juniper"]);
    expect(reviewer(auth)).toEqual(["sentinel"]);
    expect(reviewer(red)).toEqual([]);
    expect(reviewer(person)).toEqual([]);

    // The next tick sends nothing twice.
    expect(await sweepReviews(app)).toBe(0);
  });

  test("the reviewer's slots bound the reviews in flight: at the cap a green pull waits, and none sends nothing", async () => {
    const scout = getUserByName(app.db, "scout")!;
    const late = await pullBy(scout, "capped", "src/web/capped.ts");
    pass(late);
    const fresh = () => getRepoById(app.db, repo.id)!;
    const inFlight = reviewsInFlight(app.db, repo.id);
    expect(inFlight).toBeGreaterThan(0);
    // The cap is what is already out: nothing more goes.
    await updateRepoSettings(app, alice, repo, { reviewerSlots: inFlight });
    expect(await sendToReview(app, fresh(), late)).toBe("wait");
    expect(reviewer(late)).toEqual([]);
    // Paused: no review at all, as with no reviewer.
    await updateRepoSettings(app, alice, repo, { reviewerSlots: 0 });
    expect(await sendToReview(app, fresh(), late)).toBe("none");
    // One more slot than are out: it is sent.
    await updateRepoSettings(app, alice, repo, { reviewerSlots: inFlight + 1 });
    expect(await sendToReview(app, fresh(), late)).toBe("sent");
    expect(reviewer(late)).toHaveLength(1);
    await updateRepoSettings(app, alice, repo, { reviewerSlots: 8 });
    // Closed, so the sweep below counts what it did before.
    app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(late.id);
  });

  test("60 open green agent pulls: the oldest is sent on the first pass, and a pass sends a bounded few", async () => {
    const scout = getUserByName(app.db, "scout")!;
    const pulls: Pull[] = [];
    for (let i = 0; i < 60; i++) {
      const p = await pullBy(scout, `bulk-${i}`, `docs/bulk-${i}.md`);
      pass(p);
      pulls.push(p);
    }
    const sent = await sweepReviews(app);
    expect(sent).toBe(SWEEP_SENDS);
    expect(reviewer(pulls[0]!)).toHaveLength(1);
    expect(reviewer(pulls[SWEEP_SENDS - 1]!)).toHaveLength(1);
    expect(reviewer(pulls[SWEEP_SENDS]!)).toEqual([]);
    expect(reviewer(pulls[59]!)).toEqual([]);
  }, 120_000);
});

describe("the design team reviews a change to a page", () => {
  const designer = {
    user: { id: "d1", username: "designer" },
    brief: `I am Designer. I review the look.\n\n${SHARED}`,
  } as unknown as Agent;
  const team = ["d1"];

  test("src/web/ is design's; src/core/ is not", () => {
    expect(touchesDesign(["src/web/pages/x.ts"])).toBe(true);
    expect(touchesDesign(["src/web/ui/button.ts"])).toBe(true);
    expect(touchesDesign(["src/core/x.ts", "docs/DESIGN.md"])).toBe(false);
  });

  test("a pull changing src/web/pages/x.ts goes to a design-team member; src/core/ only does not", () => {
    const crew = [{ user: { id: "j1" }, brief: juniper.brief } as unknown as Agent, designer];
    expect(pickReviewer(crew, ["src/web/pages/x.ts"], team)).toBe(designer);
    expect(pickReviewer(crew, ["src/core/x.ts"], team)).toBe(crew[0]);
  });

  test("security still outranks design, and a crew with no designer keeps its reviewer", () => {
    const crew = [sentinel, designer];
    expect(pickReviewer(crew, ["src/web/auth.ts"], team)).toBe(sentinel);
    expect(pickReviewer([juniper], ["src/web/pages/x.ts"], team)).toBe(juniper);
  });
});

describe("the least-busy reviewer", () => {
  const exp = { user: { id: "e1" }, brief: `I am Exp. I read for the experience.\n\n${SHARED}` } as unknown as Agent;
  const exp2 = { user: { id: "e2" }, brief: `I am Exp2. I read for the experience.\n\n${SHARED}` } as unknown as Agent;
  const sec = { user: { id: "s1" }, brief: `I am Sec. I read for security.\n\n${SHARED}` } as unknown as Agent;
  const des = { user: { id: "d1" }, brief: `I am Des. I review the look.\n\n${SHARED}` } as unknown as Agent;
  const load = (o: Record<string, number>) => new Map(Object.entries(o));

  test("the least busy wins, and a tie goes to the experience reviewer", () => {
    expect(pickReviewer([exp, exp2], ["README.md"], [], load({ e1: 3, e2: 1 }))).toBe(exp2);
    expect(pickReviewer([sec, exp], ["README.md"], [], load({ s1: 1, e1: 1 }))).toBe(exp);
    expect(pickReviewer([sec, exp], ["README.md"], [], load({ s1: 0, e1: 2 }))).toBe(sec);
  });

  test("a security pull stays with security, least busy among them", () => {
    const sec2 = { ...sec, user: { id: "s2" } } as Agent;
    expect(pickReviewer([exp, sec], ["src/core/tokens.ts"], [], load({ s1: 9 }))).toBe(sec);
    expect(pickReviewer([sec, sec2, exp], ["src/core/tokens.ts"], [], load({ s1: 4, s2: 1 }))).toBe(sec2);
  });

  test("design takes src/web/ until 2 are in flight, then it spills", () => {
    const crew = [exp, des];
    const p = ["src/web/pages/x.ts"];
    expect(pickReviewer(crew, p, ["d1"], load({ d1: 1 }))).toBe(des);
    expect(pickReviewer(crew, p, ["d1"], load({ d1: 2 }))).toBe(exp);
    expect(pickReviewer(crew, p, ["d1"], load({ d1: 2, e1: 5 }))).toBe(des);
  });

  test("reviewLoad counts only review runs still in flight, per reviewer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-load-"));
    const app = createApp({ dataDir: dir, port: 0 });
    try {
      expect(reviewLoad(app.db).size).toBe(0);
      app.db.run("PRAGMA foreign_keys = OFF");
      const ins = app.db.prepare(
        "INSERT INTO run (id, repo_id, kind, state, reason, actor_id) VALUES (?, 'r', 'agent', ?, ?, ?)",
      );
      ins.run("a", "queued", "review", "e1");
      ins.run("b", "running", "review", "e1");
      ins.run("c", "ok", "review", "e1");
      ins.run("d", "running", "feedback", "e1");
      ins.run("e", "queued", "review", "s1");
      expect(Object.fromEntries(reviewLoad(app.db))).toEqual({ e1: 2, s1: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
