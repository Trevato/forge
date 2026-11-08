/**
 * #8682: the reviewer that approves a pull ticks the boxes its head meets on
 * the issue it closes and says which it left; a landing closes an issue
 * whose boxes are all ticked, and an issue held for boxes gets the same pass
 * once. A builder is still never sent to redo shipped work.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { passOf } from "../src/actions/box_pass.ts";
import { openIssue } from "../src/actions/issues.ts";
import { mergePull, openPull, submitReview } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import {} from "../src/core/agents.ts";
import { PASS_LEAD, tickBoxes, unticked } from "../src/core/done_on_main.ts";
import { addComment, getIssueById, listComments, updateIssueText, type Issue } from "../src/core/issues.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { landedBoxes, NO_DIFF_LEAD, passed, passLanded } from "../src/crew/box_pass.ts";
import { reviewsInFlight } from "../src/crew/review.ts";
import { reviewInputs } from "../src/crew/runner.ts";
import { repoDir } from "../src/git/repos.ts";
import { taskPrompt, type TaskInput } from "../src/crew/brief.ts";
import { serve, type Servers } from "../src/http/server.ts";

import { tokenFor } from "./helpers/tokens.ts";
import { heldNow } from "../src/crew/held.ts";

describe("tickBoxes", () => {
  test("ticks the numbered unticked boxes, counted as unticked lists them", () => {
    const body = "- [x] done\n- [ ] one\n```\n- [ ] code\n```\n* [ ] two\n- [ ] three";
    expect(unticked(body)).toEqual(["one", "two", "three"]);
    const r = tickBoxes(body, [1, 3, 9]);
    expect(r.ticked).toEqual(["one", "three"]);
    expect(r.body).toBe("- [x] done\n- [x] one\n```\n- [ ] code\n```\n* [ ] two\n- [x] three");
  });
  test("passOf refuses what is not a list of boxes", () => {
    expect(passOf([{ issue: 1, box: 0, text: "a" }], undefined)).toBeUndefined();
    expect(passOf([{ issue: 1, box: 1 }], undefined)).toBeUndefined();
    expect(passOf(undefined, [{ issue: 1, box: 1, text: "a" }])).toBeUndefined();
    expect(passOf([{ issue: 1, box: 2, text: " b " }], [{ issue: 1, box: 3, text: "c", why: " no " }])).toEqual({
      ticks: [{ issue: 1, box: 2, text: "b" }],
      left: [{ issue: 1, box: 3, text: "c", why: "no" }],
    });
  });
});

describe("the reviewer's pass over the boxes", () => {
  let dir: string;
  let app: App;
  let alice: User;
  let vesper: User;
  let mason: User;
  let repo: Repo;
  const fresh = () => getRepoById(app.db, repo.id)!;
  const now = (on: Issue) => getIssueById(app.db, on.id)!;
  const issue = (title: string, body: string): Issue => {
    const opened = openIssue(app, alice, fresh(), { title, body });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value;
  };
  const propose = async (branch: string, closes: Issue): Promise<Pull> => {
    const pushed = await commitToBranch(app, alice, fresh(), {
      branch,
      message: branch,
      files: [{ path: `${branch}.txt`, content: "x\n" }],
    });
    if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
    const opened = await openPull(app, alice, fresh(), {
      title: branch,
      body: `Closes #${closes.number}`,
      baseBranch: "main",
      headBranch: branch,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    return getPull(app.db, repo.id, opened.value.number)!;
  };
  const land = async (pull: Pull, strategy: "squash" | "merge" = "squash") => {
    const merged = await mergePull(app, alice, fresh(), pull, strategy);
    if (!merged.ok) throw new Error(String(merged.error));
  };
  const approve = async (as: User, pull: Pull, pass: Parameters<typeof passOf>) => {
    const submitted = await submitReview(app, as, fresh(), getPull(app.db, repo.id, pull.number)!, {
      state: "approved",
      body: "ok",
      pass: passOf(...pass)!,
    });
    if (!submitted.ok) throw new Error(String(submitted.error));
  };
  const tick = (on: Issue, box: number, text: string) => ({ issue: on.number, box, text });
  const held = (on: Issue) => heldNow(app, fresh()).by.landed.some((i) => i.id === on.id);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-box-pass-"));
    app = createApp({ dataDir: dir, port: 0 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, { name: "engine", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    for (const agent of ["atlas", "mason", "vesper"]) {
      const created = await createAgent(app, alice, { username: agent });
      if (!created.ok) throw new Error(String(created.error));
      expect(addToCrew(app, alice, made.value, agent).ok).toBe(true);
    }
    seatAs(app.db, made.value.id, getUserByName(app.db, "atlas")!.id, "planner");
    seatAs(app.db, made.value.id, getUserByName(app.db, "vesper")!.id, "reviewer");
    vesper = getUserByName(app.db, "vesper")!;
    mason = getUserByName(app.db, "mason")!;
    const set = await updateRepoSettings(app, alice, made.value, {
      autonomy: "autonomous",
      autonomyDirection: "Keep the engine small.",
      autonomyCeilingUsd: 100,
      autonomySlots: 1,
      autonomyBy: alice.id,
    });
    if (!set.ok) throw new Error(JSON.stringify(set.error));
    repo = getRepoById(app.db, made.value.id)!;
    const seeded = await commitToBranch(app, alice, fresh(), {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("every box ticked by the reviewer: the landing closes the issue", async () => {
    const whole = issue("Whole", "- [ ] a\n- [ ] b");
    const pull = await propose("whole", whole);
    await approve(vesper, pull, [[tick(whole, 1, "a"), tick(whole, 2, "b")], undefined]);
    expect(now(whole).body).toBe("- [ ] a\n- [ ] b");
    await land(pull);
    expect(now(whole).body).toBe("- [x] a\n- [x] b");
    expect(listComments(app.db, whole.id).map((c) => c.body)).toEqual([
      `${PASS_LEAD}${pull.number} at its head: ticked a; b.`,
    ]);
    expect(now(whole).state).toBe("closed");
  });

  test("a box the reviewer left holds the issue, named with why, and no builder is sent", async () => {
    const part = issue("Part", "- [ ] shipped\n- [ ] later");
    const pull = await propose("part", part);
    await approve(vesper, pull, [
      [tick(part, 1, "shipped")],
      [{ ...tick(part, 2, "later"), why: "the diff never touches it" }],
    ]);
    await land(pull);
    expect(now(part).body).toBe("- [x] shipped\n- [ ] later");
    expect(now(part).state).toBe("open");
    const notes = listComments(app.db, part.id).map((c) => c.body);
    expect(notes[0]).toBe(`${PASS_LEAD}${pull.number} at its head: ticked shipped. left open: later — the diff never touches it.`);
    expect(notes[1]).toContain("1 unticked item remains (later). The planner files each as its own issue");
    expect(held(part)).toBe(true);
    expect(heldNow(app, fresh()).startable.some((r) => r.issue.id === part.id)).toBe(false);
    expect(landedBoxes([now(part)])).toEqual([{ number: part.number, title: "Part", boxes: ["later"] }]);
  });

  test("only a crew reviewer's approval ticks", async () => {
    const mine = issue("Mine", "- [ ] a");
    const pull = await propose("mine", mine);
    await approve(mason, pull, [[tick(mine, 1, "a")], undefined]);
    await land(pull);
    expect(now(mine).body).toBe("- [ ] a");
    const other = issue("Other", "- [ ] a");
    const unclosed = await propose("other", other);
    await approve(vesper, unclosed, [[tick(mine, 1, "a")], undefined]);
    await land(unclosed);
    expect(now(mine).body).toBe("- [ ] a");
  });

  test("an issue already held gets the pass once, and a pass that ticks the rest closes it", async () => {
    const old = issue("Old", "- [ ] x\n- [ ] y");
    const pull = await propose("old", old);
    await land(pull);
    expect(held(old)).toBe(true);
    const asked = () =>
      app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM run WHERE issue_id = ?1 AND reason = 'review'").get(pull.id)!.n;
    expect(await passLanded(app, fresh(), heldNow(app, fresh()).by.landed.filter((i) => i.id === old.id))).toBe(1);
    expect(asked()).toBe(1);
    expect(await passLanded(app, fresh(), heldNow(app, fresh()).by.landed.filter((i) => i.id === old.id))).toBe(0);
    expect(asked()).toBe(1);
    await approve(vesper, pull, [[tick(old, 1, "x"), tick(old, 2, "y")], undefined]);
    expect(now(old).state).toBe("closed");
    expect(held(old)).toBe(false);
  });

  test("a box edited since the reviewer read it is not ticked", async () => {
    const edited = issue("Edited", "- [ ] first\n- [ ] second");
    const pull = await propose("edited", edited);
    await approve(vesper, pull, [[tick(edited, 1, "first"), tick(edited, 2, "second")], undefined]);
    updateIssueText(app.db, edited.id, { body: "- [ ] zero\n- [ ] first\n- [ ] second" });
    await land(pull);
    expect(now(edited).body).toBe("- [ ] zero\n- [ ] first\n- [ ] second");
    expect(now(edited).state).toBe("open");
  });

  test("a head pushed after the approval drops its ticks", async () => {
    const moved = issue("Moved", "- [ ] a");
    const pull = await propose("moved", moved);
    await approve(vesper, pull, [[tick(moved, 1, "a")], undefined]);
    const pushed = await commitToBranch(app, alice, fresh(), {
      branch: "moved",
      message: "more",
      files: [{ path: "more.txt", content: "y\n" }],
    });
    if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
    await land(getPull(app.db, repo.id, pull.number)!);
    expect(now(moved).body).toBe("- [ ] a");
    expect(now(moved).state).toBe("open");
  });

  test("a pull that never lands ticks nothing", async () => {
    const never = issue("Never", "- [ ] a");
    const pull = await propose("never", never);
    await approve(vesper, pull, [[tick(never, 1, "a")], undefined]);
    expect(now(never).body).toBe("- [ ] a");
    expect(listComments(app.db, never.id)).toEqual([]);
  });

  test("passed: a note counts from a crew reviewer, not from anyone", async () => {
    const quiet = issue("Quiet", "- [ ] a");
    const pull = await propose("quiet", quiet);
    await land(pull);
    const landed = getPull(app.db, repo.id, pull.number)!;
    addComment(app.db, { issueId: quiet.id, authorId: alice.id, body: `${PASS_LEAD}${pull.number} at its head: ticked a.` });
    expect(passed(app, fresh(), quiet, landed)).toBe(false);
    addComment(app.db, { issueId: quiet.id, authorId: vesper.id, body: `${PASS_LEAD}${pull.number} at its head: ticked a.` });
    expect(passed(app, fresh(), quiet, landed)).toBe(true);
  });

  test("passed: a review run since the merge counts, one before it does not", async () => {
    const asked = issue("Asked", "- [ ] a");
    const pull = await propose("asked", asked);
    await land(pull);
    const landed = getPull(app.db, repo.id, pull.number)!;
    expect(passed(app, fresh(), asked, landed)).toBe(false);
    expect(await passLanded(app, fresh(), [now(asked)])).toBe(1);
    expect(passed(app, fresh(), asked, landed)).toBe(true);
  });
  // #8739: the head's refs are deleted and its objects pruned, as a forge's gc would leave it.
  const prune = async (pull: Pull) => {
    const bare = repoDir(app.reposRoot, repo.ownerName, repo.name);
    for (const args of [
      ["update-ref", "-d", `refs/heads/${pull.headBranch}`],
      ["update-ref", "-d", `refs/pull/${pull.number}/head`],
      ["reflog", "expire", "--expire=now", "--all"],
      ["gc", "--prune=now", "--quiet"],
    ]) {
      const ran = Bun.spawnSync(["git", ...args], { cwd: bare });
      if (ran.exitCode !== 0) throw new Error(ran.stderr.toString());
    }
    const gone = Bun.spawnSync(["git", "cat-file", "-e", `${pull.headOid}^{commit}`], { cwd: bare });
    expect(gone.exitCode).not.toBe(0);
    return bare;
  };

  test("a pull merged with its head gone is reviewed from its merge commit, a real diff in the brief", async () => {
    const gone = issue("Gone", "- [ ] g");
    const pull = await propose("gone", gone);
    await land(pull);
    const landed = getPull(app.db, repo.id, pull.number)!;
    const bare = await prune(landed);
    expect(await passLanded(app, fresh(), [now(gone)])).toBe(1);
    const inputs = await reviewInputs(app, fresh(), landed, undefined, bare);
    expect(inputs.landedAs).toBe(landed.mergedOid!);
    expect(inputs.reviewDiff).toContain("gone.txt");
    expect(inputs.reviewDiff).toContain("+x");
    expect(inputs.reviewDiff).not.toContain("README.md");
    const brief = taskPrompt({
      agent: { user: { username: "vesper", displayName: "" }, brief: "" },
      repo: { id: repo.id, ownerName: "alice", name: "engine", defaultBranch: "main", autonomyDirection: "Keep it small." },
      issue: { number: pull.number, title: "gone", body: `Closes #${gone.number}`, authorName: "alice" },
      comments: [],
      reviews: [],
      reason: "review",
      branch: "gone",
      forgeUrl: "http://forge.test",
      role: "reviewer",
      ...inputs,
    } as unknown as TaskInput);
    expect(brief).toContain(`The change, as it landed: commit ${landed.mergedOid}`);
    expect(brief).toContain("+++ b/gone.txt");
    expect(brief).not.toContain("(no diff available)");
  });

  test("a merge commit is read against its first parent: the pull's change, not the base's", async () => {
    const both = issue("Both", "- [ ] b");
    const pull = await propose("both", both);
    const moved = await commitToBranch(app, alice, fresh(), {
      message: "base moves",
      files: [{ path: "base-moved.txt", content: "z\n" }],
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved.error));
    await land(pull, "merge");
    const landed = getPull(app.db, repo.id, pull.number)!;
    // Its head is its second parent, so it never goes; the base moved under it.
    const bare = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const inputs = await reviewInputs(app, fresh(), landed, undefined, bare);
    expect(inputs.landedAs).toBe(landed.mergedOid!);
    expect(inputs.reviewDiff).toContain("both.txt");
    expect(inputs.reviewDiff).not.toContain("base-moved.txt");
  });

  test("a pull with no diff left is not sent: its issue stays held and says why, once", async () => {
    const lost = issue("Lost", "- [ ] l");
    const pull = await propose("lost", lost);
    await land(pull);
    await prune(getPull(app.db, repo.id, pull.number)!);
    // A landing whose commit is not there to read either.
    app.db.query("UPDATE pull SET merged_oid = ?1 WHERE issue_id = ?2").run("0".repeat(40), pull.id);
    const asked = () =>
      app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM run WHERE issue_id = ?1 AND reason = 'review'").get(pull.id)!.n;
    expect(await passLanded(app, fresh(), [now(lost)])).toBe(0);
    expect(await passLanded(app, fresh(), [now(lost)])).toBe(0);
    expect(asked()).toBe(0);
    const notes = listComments(app.db, lost.id).filter((c) => c.body.startsWith(NO_DIFF_LEAD));
    expect(notes.map((c) => [c.body.slice(0, 40), c.authorId])).toEqual([[`${NO_DIFF_LEAD}${pull.number}: neither its merge commit`.slice(0, 40), vesper.id]]);
    expect(held(lost)).toBe(true);
  });

  test("the reviewer's slots bound the pass: paused sends none, a full seat waits (#8734)", async () => {
    const first = issue("Capped one", "- [ ] a");
    const second = issue("Capped two", "- [ ] b");
    await land(await propose("capped-one", first));
    await land(await propose("capped-two", second));
    const slots = (n: number) => app.db.query("UPDATE repo SET reviewer_slots = ?2 WHERE id = ?1").run(repo.id, n);
    const inFlight = () => reviewsInFlight(app.db, repo.id);
    app.db.query("UPDATE run SET state = 'cancelled' WHERE repo_id = ?1 AND state IN ('queued','running')").run(repo.id);
    slots(0);
    expect(await passLanded(app, fresh(), [now(first), now(second)])).toBe(0);
    slots(1);
    expect(await passLanded(app, fresh(), [now(first), now(second)])).toBe(1);
    expect(inFlight()).toBe(1);
    expect(await passLanded(app, fresh(), [now(first), now(second)])).toBe(0);
    app.db.query("UPDATE run SET state = 'cancelled' WHERE repo_id = ?1 AND state IN ('queued','running')").run(repo.id);
    expect(await passLanded(app, fresh(), [now(first), now(second)])).toBe(1);
    slots(8);
  });
});

describe("the review-states door", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  let repo: Repo;
  let alice: User;
  let token: string;
  let on: Issue;
  let number: number;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-box-door-"));
    app = createApp({ dataDir: dir, port: 0 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, { name: "door", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const created = await createAgent(app, alice, { username: "vesper" });
    if (!created.ok) throw new Error(String(created.error));
    addToCrew(app, alice, repo, "vesper");
    seatAs(app.db, repo.id, getUserByName(app.db, "vesper")!.id, "reviewer");
    token = tokenFor(app, "vesper", "rw");
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# door\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const opened = openIssue(app, alice, repo, { title: "Boxes", body: "- [ ] a" });
    if (!opened.ok) throw new Error(String(opened.error));
    on = opened.value;
    const pushed = await commitToBranch(app, alice, repo, {
      branch: "door",
      message: "door",
      files: [{ path: "door.txt", content: "x\n" }],
    });
    if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
    const pull = await openPull(app, alice, repo, {
      title: "door",
      body: `Closes #${on.number}`,
      baseBranch: "main",
      headBranch: "door",
    });
    if (!pull.ok) throw new Error(String(pull.error));
    number = pull.value.number;
    servers = await serve(app);
  }, 30_000);

  afterAll(async () => {
    servers.stop?.();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const post = (body: unknown) =>
    fetch(`${servers.url}/api/v1/repos/alice/door/pulls/${number}/review-states`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("ticks that are not boxes answer 422 invalid_boxes", async () => {
    for (const bad of [{ ticks: "a" }, { ticks: [{ issue: 1 }] }, { left: [{ issue: 1, box: 1, text: "a" }] }]) {
      const res = await post({ state: "approved", body: "ok", ...bad });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_boxes");
    }
  });

  test("ticks and left reach the landing", async () => {
    const res = await post({ state: "approved", body: "ok", ticks: [{ issue: on.number, box: 1, text: "a" }], left: [] });
    expect(res.status).toBe(201);
    expect(getIssueById(app.db, on.id)!.body).toBe("- [ ] a");
    const merged = await mergePull(app, alice, repo, getPull(app.db, repo.id, number)!, "squash");
    if (!merged.ok) throw new Error(String(merged.error));
    expect(getIssueById(app.db, on.id)!.state).toBe("closed");
    expect(getIssueById(app.db, on.id)!.body).toBe("- [x] a");
  });
});

describe("what the briefs say of boxes", () => {
  const build = (role: "reviewer" | "planner", extra: Record<string, unknown>): string =>
    taskPrompt({
      agent: { user: { username: "bot", displayName: "" }, brief: "" },
      repo: { id: "r", ownerName: "alice", name: "forge", defaultBranch: "main", autonomyDirection: "Keep it small." },
      issue: { number: 7, title: "Pull", body: "Closes #3", authorName: "mason" },
      comments: [],
      reviews: [],
      reason: role === "reviewer" ? "review" : "assigned",
      branch: "bot/7",
      forgeUrl: "http://forge.test",
      role,
      ...extra,
    } as unknown as TaskInput);

  test("a reviewer sees the boxes, numbered, and a curl that carries ticks and left", () => {
    const out = build("reviewer", { boxes: [{ number: 3, title: "Two boxes", boxes: ["first", "second"] }] });
    expect(out).toContain("Issue #3 — Two boxes");
    expect(out).toContain("1. first\n2. second");
    expect(out).toContain('"ticks":[{"issue":N,"box":1,"text"');
    expect(out).toContain('"left":[{"issue":N,"box":2,"text"');
  });

  test("without boxes the curl has neither", () => {
    for (const boxes of [undefined, []]) {
      const out = build("reviewer", { boxes });
      expect(out).not.toContain('"ticks"');
      expect(out).not.toContain("carries boxes");
    }
  });

  test("a planner is told to file what a landing left, never to redo it", () => {
    const out = build("planner", { landed: [{ number: 3, title: "Part", boxes: ["later"] }] });
    expect(out).toContain("- #3 Part");
    expect(out).toContain("  - [ ] later");
    expect(out).toContain("Do not ask a builder to redo it");
    expect(build("builder" as "planner", { landed: [{ number: 3, title: "Part", boxes: ["x"] }] })).not.toContain("left boxes open");
  });
});
