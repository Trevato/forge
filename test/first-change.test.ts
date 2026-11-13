/**
 * An app's first change lands on green (#12010), through the crew's own gate
 * (`landIfGreen`, `moveRequested`, `sweepGreen`), and a pause is not a failed
 * follow-up and says why.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { listComments, listIssues } from "../src/core/issues.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { claimRun, createRun, finishRun, cancelRun } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { landIfGreen } from "../src/crew/autonomy.ts";
import { firstLandedWords, titleOf } from "../src/crew/first_change.ts";
import { pauseSentence, pausedNote } from "../src/crew/pacing.ts";
import { pausedSentence } from "../src/crew/paused_now.ts";
import { moveRequested } from "../src/crew/requested.ts";
import { releaseHold, setHold } from "../src/core/holds.ts";
import { seatAs } from "./helpers/seat.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let app: App;
let alice: User;
let mason: User;
let quill: User;
let repo: Repo;
const fresh = () => getRepoById(app.db, repo.id)!;
const REVIEW = "The terminal view in src/tty.ts must show the greeting too. Also tidy the date format.";

async function greenPull(name: string): Promise<Pull> {
  const branch = await commitToBranch(app, alice, repo, {
    branch: `feature/${name}`,
    base: "main",
    message: name,
    files: [{ path: `${name}.ts`, content: `export const n = "${name}";\n` }],
  });
  if (!branch.ok) throw new Error(JSON.stringify(branch.error));
  const opened = await openPull(app, alice, repo, { title: name, baseBranch: "main", headBranch: `feature/${name}` });
  if (!opened.ok) throw new Error(String(opened.error));
  app.db.query("UPDATE issue SET author_id = ?2 WHERE id = ?1").run(opened.value.id, mason.id);
  const pull = getPull(app.db, repo.id, opened.value.number)!;
  const check = createRun(app.db, { repoId: repo.id, kind: "check", issueId: pull.id, env: `pull-${pull.number}`, commitOid: pull.headOid, reason: "pull" });
  claimRun(app.db, check.id);
  finishRun(app.db, check.id, { state: "ok", summary: "check passed" });
  return pull;
}

const ask = (pull: Pull, state: "changes_requested" | "approved" = "changes_requested", body = REVIEW) =>
  submitReview(app.db, { issueId: pull.id, authorId: quill.id, state, commitOid: pull.headOid, body });
const merged = (pull: Pull) => getPull(app.db, repo.id, pull.number)?.mergedAt !== null;
const autonomy = (on: boolean) =>
  app.db.query("UPDATE repo SET autonomy = ?2, autonomy_by = ?3 WHERE id = ?1").run(repo.id, on ? "autonomous" : "off", on ? alice.id : null);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-first-change-"));
  app = createApp({ dataDir: dir, port: 0 });
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
  for (const name of ["mason", "quill"]) {
    const agent = await createAgent(app, alice, { username: name });
    if (!agent.ok) throw new Error(String(agent.error));
  }
  mason = getUserByName(app.db, "mason")!;
  quill = getUserByName(app.db, "quill")!;
  const created = await newApp(app, alice, { name: "hello", description: "A page that says hello and shows today's date", visibility: "private" });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  repo = created.value.repo;
  expect(addToCrew(app, alice, repo, "mason").ok).toBe(true);
  expect(addToCrew(app, alice, repo, "quill").ok).toBe(true);
  seatAs(app.db, repo.id, mason.id, "builder");
  seatAs(app.db, repo.id, quill.id, "reviewer");
  autonomy(true);
});

afterAll(async () => {
  await app?.close?.();
  await rm(dir, { recursive: true, force: true });
});

describe("the first change", () => {
  test("autonomy off, a red check and a hold still block it", async () => {
    const pull = await greenPull("blocked");
    ask(pull);
    autonomy(false);
    expect(await landIfGreen(app, fresh(), pull)).toBe(false);
    autonomy(true);
    setHold(app.db, pull.id, alice.id, "wait");
    expect(await landIfGreen(app, fresh(), pull)).toBe(false);
    releaseHold(app.db, pull.id, alice.id);
    const red = createRun(app.db, { repoId: repo.id, kind: "check", issueId: pull.id, env: `pull-${pull.number}`, commitOid: pull.headOid, reason: "pull" });
    claimRun(app.db, red.id);
    finishRun(app.db, red.id, { state: "failed", summary: "red" });
    expect(await landIfGreen(app, fresh(), pull)).toBe(false);
    expect(merged(pull)).toBe(false);
    app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(pull.id);
  });

  test("a review still on its way is read first, and a require-review app never takes the rule", async () => {
    const pull = await greenPull("waits");
    createRun(app.db, { repoId: repo.id, kind: "agent", issueId: pull.id, actorId: quill.id, reason: "review" });
    expect(await landIfGreen(app, fresh(), pull)).toBe(false);
    app.db.query("UPDATE repo SET require_review = 1 WHERE id = ?1").run(repo.id);
    ask(pull);
    expect(await landIfGreen(app, fresh(), pull)).toBe(false);
    app.db.query("UPDATE repo SET require_review = 0 WHERE id = ?1").run(repo.id);
    app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(pull.id);
    app.db.query("UPDATE run SET state = 'cancelled' WHERE issue_id = ?1 AND kind = 'agent'").run(pull.id);
  });

  test("a first pull with changes requested lands, files one follow-up with the review text, and says so; the second needs approval", async () => {
    const first = await greenPull("first");
    ask(first);
    // The follow-up pass leaves it to the queue.
    const moves = await moveRequested(app, fresh(), 1);
    expect(moves.find((m) => m.pull === first.number)).toMatchObject({ did: "not moved", why: expect.stringContaining("first change") });
    expect(await landIfGreen(app, fresh(), first)).toBe(true);
    expect(merged(first)).toBe(true);

    const issues = listIssues(app.db, repo.id, { state: "all" }).filter((i) => i.kind === "issue" && i.body.includes(REVIEW));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.title).toBe("The terminal view in src/tty.ts must show the greeting too.");
    expect(issues[0]!.body).toContain(`#${first.number}`);
    expect(issues[0]!.assigneeId).toBe(mason.id);
    const said = listComments(app.db, first.id).map((c) => c.body);
    expect(said).toContain(firstLandedWords(issues[0]!.number));
    expect(firstLandedWords(3)).toBe("Landed on green as this app's first change; the reviewer's requests are issue #3.");

    // The second change follows the normal rule.
    const second = await greenPull("second");
    ask(second);
    expect(await landIfGreen(app, fresh(), second)).toBe(false);
    const third = await greenPull("third");
    expect(await landIfGreen(app, fresh(), third)).toBe(false);
    ask(third, "approved", "Looks right.");
    expect(await landIfGreen(app, fresh(), third)).toBe(true);
    // Nothing more was filed by a later change.
    expect(listIssues(app.db, repo.id, { state: "all" }).filter((i) => i.body.includes(REVIEW))).toHaveLength(1);
  });

  test("the title is the review's first sentence", () => {
    expect(titleOf("Add the date. Then more.")).toBe("Add the date.");
    expect(titleOf("")).toBe("Changes the reviewer asked for");
  });
});

describe("a pause is not a failed follow-up", () => {
  const endedRun = (pull: Pull, state: "ok" | "failed" | "cancelled", summary: string) => {
    const run = createRun(app.db, { repoId: repo.id, kind: "agent", issueId: pull.id, actorId: mason.id, reason: "feedback", attempt: 1 });
    claimRun(app.db, run.id);
    if (state === "cancelled") cancelRun(app.db, run.id, summary);
    else finishRun(app.db, run.id, { state, summary });
  };

  test("paused and restart-cancelled follow-ups do not count; two that ran and pushed nothing do", async () => {
    // A later change: the first has landed, so the normal rule applies.
    // Nothing else of the builder's is queued or open.
    app.db.query("UPDATE run SET state = 'cancelled' WHERE kind = 'agent' AND state = 'queued'").run();
    app.db.query("UPDATE issue SET state = 'closed' WHERE repo_id = ?1 AND kind = 'pull' AND state = 'open'").run(repo.id);
    const pull = await greenPull("later");
    ask(pull);
    // The verdict is a minute old, so every run below began after it, whatever the clock's grain.
    app.db.query("UPDATE review SET created_at = ?2 WHERE issue_id = ?1").run(pull.id, new Date(Date.now() - 60_000).toISOString());
    app.db.query("UPDATE issue SET assignee_id = ?2 WHERE id = ?1").run(pull.id, mason.id);
    autonomy(false); // a ceiling on an autonomous repo with no budget set would queue nothing
    const why = async () => (await moveRequested(app, fresh(), 10)).find((m) => m.pull === pull.number);
    endedRun(pull, "cancelled", "paused: the provider's rate limit; resumes 11:12 UTC");
    endedRun(pull, "cancelled", "cancelled");
    endedRun(pull, "ok", "no changes pushed");
    expect(await why()).toMatchObject({ did: "queued feedback" });
    for (const r of app.db.query<{ id: string }, [string]>("SELECT id FROM run WHERE issue_id = ?1 AND state IN ('queued','running')").all(pull.id))
      cancelRun(app.db, r.id, "cancelled");
    endedRun(pull, "ok", "no changes pushed");
    expect(await why()).toMatchObject({ did: "not moved", why: expect.stringContaining("two follow-ups") });
  });
});

describe("a pause says why", () => {
  const at = new Date("2026-11-13T11:12:30Z");
  const now = new Date("2026-11-13T10:57:30Z");

  test("the rate limit, the credit, the provider and the unknown", () => {
    expect(pauseSentence("paused: the 5-hour window is full until 11:12 UTC; resumes 11:12 UTC", at, now)).toBe("Paused until 11:12 UTC: the model account is at its limit");
    expect(pauseSentence("paused: credit balance is too low; resumes 11:12 UTC", at, now)).toBe("Paused until 11:12 UTC: the forge's included credit is spent");
    expect(pauseSentence("paused: API Error: 500 Internal server error; resumes 11:12 UTC", at, now)).toBe("Paused until 11:12 UTC: the model provider returned an error");
    expect(pauseSentence("paused: something odd; resumes 11:12 UTC", at, now)).toBe("the model did not answer; trying again at 11:12 UTC");
    expect(pausedNote(at.toISOString(), now, "paused: Overloaded; resumes 11:12 UTC")).toBe("Paused until 11:12 UTC: the model account is at its limit");
    expect(pausedNote(at.toISOString(), now)).toBe("paused, resumes 11:12 UTC");
  });

  test("a queued paused run's sentence reaches the pull's and the app's reads", () => {
    const pull = getPull(app.db, repo.id, 1) ?? undefined;
    const issueId = pull?.id ?? (app.db.query<{ id: string }, [string]>("SELECT id FROM issue WHERE repo_id = ?1 LIMIT 1").get(repo.id)!.id);
    const when = new Date(Date.now() + 15 * 60_000).toISOString();
    createRun(app.db, { repoId: repo.id, kind: "agent", issueId, actorId: mason.id, reason: "feedback", notBefore: when, summary: "paused: usage limit reached; resumes soon" });
    expect(pausedSentence(app.db, { issueId })).toContain("the model account is at its limit");
    expect(pausedSentence(app.db, { repoId: repo.id })).toContain("Paused until");
  });
});
