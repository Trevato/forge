/**
 * The run cap's edges: when an issue has used its runs (`capReached`), when
 * its park was already written (`capNoted`), and how a park quotes a review
 * (`quoteCut`). The wider flow through `queueAgentRun` is in
 * crew-guard.test.ts; here the clock is passed in.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { addComment, openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { getAgent, type Agent } from "../src/core/agents.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import {
  CAP_NOTE,
  CAP_WINDOW_MS,
  capNoted,
  capReached,
  quoteCut,
} from "../src/crew/guard.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const T0 = Date.parse("2030-01-10T00:00:00.000Z");
const at = (ms: number) => new Date(T0 + ms);
const HOUR = 3_600_000;
const CAP = 3;

let dataDir: string;
let app: App;
let alice: User;
let mallory: User;
let bot: Agent;
let repo: Repo;
let made = 0;

const ok = <T>(
  r: { ok: true; value: T } | { ok: false; error: unknown },
): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

function issueOf(): Issue {
  const issue = ok(
    openIssue(app, alice, getRepoById(app.db, repo.id)!, {
      title: `Cap ${++made}`,
    }),
  );
  return getIssueById(app.db, issue.id)!;
}

/** A run on `issue` started `ms` after T0. */
function run(issue: Issue, ms: number, reason = "assigned", summary = "done") {
  const r = createRun(app.db, {
    repoId: repo.id,
    kind: "agent",
    issueId: issue.id,
    actorId: bot.user.id,
    reason,
  });
  claimRun(app.db, r.id);
  finishRun(app.db, r.id, { state: "ok", summary, costUsd: 0 });
  app.db
    .query("UPDATE run SET created_at = ?1 WHERE id = ?2")
    .run(at(ms).toISOString(), r.id);
}

/** A comment by `user` on `issue`, written `ms` after T0. */
function say(issue: Issue, user: User, body: string, ms: number) {
  const c = ok(addComment(app, user, repo, issue, body));
  app.db
    .query("UPDATE comment SET created_at = ?1 WHERE id = ?2")
    .run(at(ms).toISOString(), c.id);
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-guard-cap-"));
  app = createApp({ dataDir, port: 0 });
  alice = ok(
    await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    }),
  );
  mallory = ok(
    await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "mallory",
      email: "mallory@forge.local",
      password: "a-good-passphrase",
    }),
  );
  ok(await createAgent(app, alice, { username: "bot" }));
  repo = ok(
    await createRepo(app, alice, { name: "square", visibility: "public" }),
  );
  expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
  bot = getAgent(app.db, getUserByName(app.db, "bot")!.id)!;
}, 30_000);

afterAll(async () => {
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

const reached = (issue: Issue, now = at(HOUR)) =>
  capReached(app.db, repo, issue, CAP, now);
const noted = (issue: Issue, now = at(10 * HOUR)) =>
  capNoted(app.db, repo, issue, now);

describe("capReached", () => {
  test("under the cap is not capped, at the cap is", () => {
    const issue = issueOf();
    run(issue, 0);
    run(issue, 1);
    expect(reached(issue)).toBe(false);
    run(issue, 2);
    expect(reached(issue)).toBe(true);
  });

  test("runs older than the window no longer count", () => {
    const issue = issueOf();
    for (let n = 0; n < CAP; n++) run(issue, n);
    expect(reached(issue, at(CAP_WINDOW_MS - HOUR))).toBe(true);
    expect(reached(issue, at(CAP_WINDOW_MS + HOUR))).toBe(false);
  });

  test("a check-failure run, a conflict, a review, a retry, an interrupted and a skipped run are not starts", () => {
    const issue = issueOf();
    run(issue, 0);
    run(issue, 1, "check_failed");
    run(issue, 2, "conflict");
    run(issue, 3, "review");
    run(issue, 4, "assigned", "interrupted: restart");
    run(issue, 5, "assigned", "skipped: nothing new");
    createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.id,
      actorId: bot.user.id,
      reason: "assigned",
      attempt: 1,
    });
    expect(reached(issue)).toBe(false);
    run(issue, 6);
    run(issue, 7);
    expect(reached(issue)).toBe(true);
  });

  test("a director's word restarts the count; a reader's does not", () => {
    const issue = issueOf();
    for (let n = 0; n < CAP; n++) run(issue, n);
    say(issue, mallory, "Try again!", HOUR / 2);
    expect(reached(issue)).toBe(true);
    say(issue, alice, "Smaller radius.", HOUR);
    expect(reached(issue, at(2 * HOUR))).toBe(false);
    for (let n = 0; n < CAP; n++) run(issue, 2 * HOUR + n);
    expect(reached(issue, at(3 * HOUR))).toBe(true);
  });
});

describe("capNoted", () => {
  test("an issue without the note is not noted", () => {
    expect(noted(issueOf())).toBe(false);
  });

  test("after the note, a review or a reader's comment starts no second note", () => {
    const issue = issueOf();
    for (let n = 0; n < CAP; n++) run(issue, n);
    say(issue, bot.user, CAP_NOTE, 2 * HOUR);
    expect(noted(issue)).toBe(true);
    say(issue, mallory, "Try again!", 3 * HOUR);
    say(issue, bot.user, "A review of the push.", 4 * HOUR);
    expect(noted(issue)).toBe(true);
  });

  test("a director's word starts a new window in which the note is not yet written", () => {
    const issue = issueOf();
    say(issue, bot.user, CAP_NOTE, 2 * HOUR);
    expect(noted(issue)).toBe(true);
    say(issue, alice, "Smaller radius.", 3 * HOUR);
    expect(noted(issue)).toBe(false);
    say(issue, bot.user, CAP_NOTE, 5 * HOUR);
    expect(noted(issue)).toBe(true);
  });

  test("a note older than the window is not noted", () => {
    const issue = issueOf();
    say(issue, bot.user, CAP_NOTE, 0);
    expect(noted(issue, at(CAP_WINDOW_MS - HOUR))).toBe(true);
    expect(noted(issue, at(CAP_WINDOW_MS + HOUR))).toBe(false);
  });
});

describe("quoteCut", () => {
  test("short text is returned unchanged, trimmed", () => {
    expect(quoteCut("Looks fine. Ship it.")).toBe("Looks fine. Ship it.");
    expect(quoteCut("  padded \n")).toBe("padded");
    expect(quoteCut("a".repeat(600))).toBe("a".repeat(600));
  });

  test("long text is cut at the last sentence end inside the window", () => {
    const text = `${"a".repeat(520)}. ${"b".repeat(30)}! ${"c".repeat(300)}`;
    expect(quoteCut(text)).toBe(`${"a".repeat(520)}. ${"b".repeat(30)}!`);
  });

  test("a sentence end before the window is not used; the cut is marked", () => {
    const text = `${"a".repeat(100)}. ${"b".repeat(700)}`;
    const cut = quoteCut(text);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(600);
  });

  test("it never exceeds its max, whatever the text", () => {
    for (const text of [
      "x".repeat(5000),
      "Yes. ".repeat(500),
      "line\n".repeat(400),
      `${"a".repeat(599)}.${"b".repeat(50)}`,
    ])
      expect(quoteCut(text).length).toBeLessThanOrEqual(600);
  });

  test("it never splits a surrogate pair", () => {
    for (const pad of [597, 598, 599, 600]) {
      const cut = quoteCut(`${"a".repeat(pad)}${"😀".repeat(40)}`);
      expect(cut.length).toBeLessThanOrEqual(600);
      expect(cut.isWellFormed()).toBe(true);
    }
  });
});
