/**
 * The new-app status line (#10295): a fresh app walked through each state,
 * and the one notification it earns.
 */
import { describe, expect, test } from "bun:test";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";
import { claimRun, createRun, finishRun, markServing, type Run } from "../src/core/runs.ts";
import { createApp } from "../src/core/apps.ts";
import { getRepoById } from "../src/core/repos.ts";
import { getUserById } from "../src/core/users.ts";
import {
  forgetOnboarding,
  onboardedLines,
  onboardingCandidates,
  onboardingFacts,
  onboardingLine,
  ONBOARDING_WINDOW_MS,
} from "../src/apps/onboarding.ts";

const OID = (c: string) => c.repeat(40);

function fixture() {
  const db = openDb(":memory:", migrations);
  db.run("INSERT INTO user (id, username, email, password_hash) VALUES ('u1', 'owner', 'o@x', '')");
  db.run("INSERT INTO user (id, username, email, password_hash, is_agent) VALUES ('a1', 'mason', 'm@x', '', 1)");
  db.run("INSERT INTO repo (id, owner_id, name) VALUES ('r1', 'u1', 'exact')");
  const repo = getRepoById(db, "r1")!;
  const created = createApp(db, { repoId: "r1", slug: "exact", access: "private" });
  if (!created.ok) throw new Error("app");
  const record = created.value;
  const user = getUserById(db, "u1")!;
  return { db, repo, record, user };
}

const line = (f: ReturnType<typeof fixture>, logs = true) =>
  onboardingLine(onboardingFacts(f.db, f.repo, f.record, "/owner/exact", f.user, logs));

function openPull(f: ReturnType<typeof fixture>) {
  f.db.run(
    "INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES ('i1', 'r1', 1, 'pull', 'Make it run', 'a1')",
  );
  f.db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES ('i1', 'main', 'mason/run', ?1, ?2)", [OID("a"), OID("b")]);
}
const check = (f: ReturnType<typeof fixture>, kind: "check" | "deploy" = "check"): Run =>
  createRun(f.db, { repoId: "r1", kind, env: kind === "deploy" ? "pull-1" : "pull-1", issueId: "i1", commitOid: OID("b"), reason: "push" });
const fail = (f: ReturnType<typeof fixture>, run: Run, name: string) => {
  claimRun(f.db, run.id);
  finishRun(f.db, run.id, { state: "failed", summary: "check failed: 1 test failed", checkDetail: { passed: 3, failed: 1, names: [name] } });
};

describe("a fresh app walked through its states", () => {
  test("imported, then making, failed, retrying, preview, live", () => {
    const f = fixture();
    expect(line(f)).toMatchObject({ state: "imported" });

    openPull(f);
    const making = line(f)!;
    expect(making.state).toBe("making");
    expect(making.text).toBe("The crew is making it run (pull #1 by mason).");

    const first = check(f);
    fail(f, first, "bun test: boots fails");
    const failed = line(f)!;
    expect(failed.state).toBe("failed");
    expect(failed.text).toBe("Check failed: bun test: boots fails");
    expect(failed.href).toBe(`/owner/exact/runs/${first.id}`);
    expect(failed.linkLabel).toBe("Failing run log");

    const next = check(f);
    const retrying = line(f)!;
    expect(retrying.state).toBe("retrying");
    expect(retrying.text).toContain("bun test: boots fails");
    expect(retrying.href).toBe(`/owner/exact/runs/${first.id}`);

    const deploy = check(f, "deploy");
    claimRun(f.db, deploy.id);
    markServing(f.db, deploy.id);
    claimRun(f.db, next.id);
    finishRun(f.db, next.id, { state: "ok", summary: "check passed" });
    expect(line(f)!.state).toBe("preview");

    const prod = createRun(f.db, { repoId: "r1", kind: "deploy", env: "production", commitOid: OID("c"), reason: "push" });
    claimRun(f.db, prod.id);
    markServing(f.db, prod.id);
    const live = line(f)!;
    expect(live.state).toBe("live");
    expect(live.href).toBe("/owner/exact/app");
  });

  test("a closed pull with nothing landed says it needs the owner", () => {
    const f = fixture();
    openPull(f);
    f.db.run("UPDATE issue SET state = 'closed' WHERE id = 'i1'");
    expect(line(f)).toMatchObject({ state: "stopped" });
  });

  test("the line is gone a day after it went live", () => {
    const f = fixture();
    const prod = createRun(f.db, { repoId: "r1", kind: "deploy", env: "production", commitOid: OID("c"), reason: "push" });
    claimRun(f.db, prod.id);
    markServing(f.db, prod.id);
    const facts = onboardingFacts(f.db, f.repo, f.record, "/owner/exact", f.user, true, Date.now() + 25 * 3_600_000);
    expect(onboardingLine(facts)).toBeUndefined();
    expect(facts.pulls).toEqual([]);
  });
});

describe("a viewer who may not read run logs", () => {
  test("reads that a check failed, never its failing line or a link to its log", () => {
    const f = fixture();
    openPull(f);
    fail(f, check(f), "bun test: secret path /srv/x");
    expect(line(f, false)).toEqual({ state: "failed", text: "A check failed." });

    check(f);
    expect(line(f, false)).toEqual({ state: "retrying", text: "Retrying after a failed check." });
    expect(line(f, true)!.text).toContain("secret path");
  });

  test("a failed check while the crew works again is retrying, with the line for one who may read logs", () => {
    const f = fixture();
    openPull(f);
    const failed = check(f);
    fail(f, failed, "boots");
    createRun(f.db, { repoId: "r1", kind: "agent", issueId: "i1", reason: "fix" });
    expect(line(f, true)).toMatchObject({ state: "retrying", text: "Retrying after a failed check: boots", href: `/owner/exact/runs/${failed.id}` });
    expect(line(f, false)).toEqual({ state: "retrying", text: "Retrying after a failed check." });
  });
});

describe("only a new app", () => {
  test("an app created before this shipped has no line and is never looked at", () => {
    const f = fixture();
    openPull(f);
    f.db.run("UPDATE app SET created_at = '2026-01-02T00:00:00.000Z' WHERE repo_id = 'r1'");
    const old = { ...f, record: { ...f.record, createdAt: "2026-01-02T00:00:00.000Z" } };
    const facts = onboardingFacts(old.db, old.repo, old.record, "/owner/exact", old.user, true);
    expect(onboardingLine(facts)).toBeUndefined();
    expect(facts.pulls).toEqual([]);
    expect(onboardingCandidates(f.db, f.user)).toEqual([]);
    f.db.run("UPDATE issue SET state = 'closed' WHERE id = 'i1'");
    expect(onboardedLines(f.db, f.user)).toEqual([]);
  });

  test("a new app that never ran goes quiet once its window passes", () => {
    const f = fixture();
    openPull(f);
    f.db.run("UPDATE issue SET state = 'closed' WHERE id = 'i1'");
    expect(onboardingCandidates(f.db, f.user)).toEqual(["r1"]);
    const later = Date.now() + ONBOARDING_WINDOW_MS + 60_000;
    expect(onboardingCandidates(f.db, f.user, later)).toEqual([]);
    expect(onboardedLines(f.db, f.user, later)).toEqual([]);
    expect(onboardingLine(onboardingFacts(f.db, f.repo, f.record, "/owner/exact", f.user, true, later))).toBeUndefined();
  });

  test("an app live for more than a day is not a candidate", () => {
    const f = fixture();
    const prod = createRun(f.db, { repoId: "r1", kind: "deploy", env: "production", commitOid: OID("c"), reason: "push" });
    claimRun(f.db, prod.id);
    markServing(f.db, prod.id);
    expect(onboardingCandidates(f.db, f.user)).toEqual(["r1"]);
    expect(onboardingCandidates(f.db, f.user, Date.now() + 25 * 3_600_000)).toEqual([]);
    expect(onboardedLines(f.db, f.user, Date.now() + 25 * 3_600_000)).toEqual([]);
  });
});

describe("one notification", () => {
  test("retries say nothing; going live says it once, under one id", () => {
    const f = fixture();
    openPull(f);
    fail(f, check(f), "boots");
    expect(onboardedLines(f.db, f.user)).toEqual([]);
    forgetOnboarding(f.db, "r1");
    fail(f, check(f), "boots again");
    expect(onboardedLines(f.db, f.user)).toEqual([]);

    const prod = createRun(f.db, { repoId: "r1", kind: "deploy", env: "production", commitOid: OID("c"), reason: "push" });
    claimRun(f.db, prod.id);
    markServing(f.db, prod.id);
    forgetOnboarding(f.db, "r1");
    const told = onboardedLines(f.db, f.user);
    expect(told).toEqual([{ line: "exact is live.", items: ["onboarded:r1:live"], link: "/owner/exact/app" }]);
    expect(onboardedLines(f.db, f.user)).toEqual(told);
  });

  test("the judgment is kept until a run or pull event on the app forgets it", () => {
    const f = fixture();
    openPull(f);
    expect(onboardedLines(f.db, f.user)).toEqual([]);
    f.db.run("UPDATE issue SET state = 'closed' WHERE id = 'i1'");
    // A clock tick with no event reads nothing new.
    expect(onboardedLines(f.db, f.user)).toEqual([]);
    forgetOnboarding(f.db, "r1");
    expect(onboardedLines(f.db, f.user).map((l) => l.items)).toEqual([["onboarded:r1:stopped"]]);
  });

  test("a pull closed without landing needs the owner", () => {
    const f = fixture();
    openPull(f);
    f.db.run("UPDATE issue SET state = 'closed' WHERE id = 'i1'");
    const told = onboardedLines(f.db, f.user);
    expect(told.length).toBe(1);
    expect(told[0]!.line).toContain("needs you");
  });
});
