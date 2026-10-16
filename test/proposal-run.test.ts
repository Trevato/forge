/**
 * A writer lets a proposed pull's exact head run — the minter included —
 * and that leave is never a review.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveToRun, mergePull, openPull, submitReview } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { recordPullProposal } from "../src/core/proposal_token.ts";
import { pullMayRun } from "../src/core/pull_trust.ts";
import { getPull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { submitReview as record } from "../src/core/reviews.ts";
import { listRuns } from "../src/core/runs.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { proposalOf } from "../src/crew/proposal.ts";
import { pullDir } from "../src/core/pulls.ts";
import { landIfGreen } from "../src/crew/autonomy.ts";
import { landsOnItsOwn } from "../src/crew/direct.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { createUser, type User } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("letting a proposed pull run", () => {
  let dataDir: string;
  let app: App;
  let checks: ChecksHandle;
  let alice: User;
  let carol: User;
  let lib: Repo;

  const push = async (branch: string, file: string) => {
    const done = await commitToBranch(app, alice, lib, {
      branch,
      message: file,
      files: [{ path: file, content: `${file}\n` }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
    return done.value.commitOid;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-proposal-run-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    checks = startChecks(app, { forgeUrl: "http://127.0.0.1:9", concurrency: 1 });
    const people: User[] = [];
    for (const [username, first] of [["alice", true], ["carol", false]] as const) {
      const made = await createUser(app.db, {
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!made.ok) throw new Error(made.error);
      people.push(made.value);
    }
    [alice, carol] = people as [User, User];
    const made = await createRepo(app, alice, { name: "lib", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    lib = made.value;
    const declared = await commitToBranch(app, alice, lib, {
      message: "Declare a check",
      files: [{ path: "forge.json", content: `{"check": {"run": "true", "install": ""}}\n` }],
    });
    if (!declared.ok) throw new Error(JSON.stringify(declared.error));
    app.db.query("UPDATE repo SET require_review = 1 WHERE id = ?1").run(lib.id);
    lib = { ...lib, requireReview: true };
  }, 120_000);

  afterAll(async () => {
    await checks.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the minter's grant runs the exact head, is no review, and a new head waits", async () => {
    const head = await push("child/kid/one", "one.md");
    const opened = await openPull(app, alice, lib, {
      title: "Proposed",
      baseBranch: "main",
      headBranch: "child/kid/one",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    recordPullProposal(app.db, opened.value.id, { child: "kid", origin: "https://kid.example.com/" });
    const pull = () => getPull(app.db, lib.id, opened.value.number)!;
    expect(pullMayRun(app.db, lib, pull(), head)).toBe(false);

    const granted = await approveToRun(app, alice, lib, pull());
    if (!granted.ok) throw new Error(granted.error);
    expect(granted.value.commitOid).toBe(head);
    expect(pullMayRun(app.db, lib, pull(), head)).toBe(true);

    await Bun.sleep(500);
    const ran = listRuns(app.db, lib.id, { kind: "check", limit: 100 }).filter(
      (r) => r.env === `pull-${pull().number}` && r.commitOid === head,
    );
    expect(ran.length).toBeGreaterThan(0);

    // Not a review: the gate still wants someone else's approval.
    const refused = await mergePull(app, alice, lib, pull(), "merge");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toBe("review_required");
    expect(
      app.db.query("SELECT COUNT(*) AS n FROM review WHERE issue_id = ?1").get(pull().id),
    ).toEqual({ n: 0 });

    // A new head is a new question.
    const next = await push("child/kid/one", "two.md");
    expect(pullMayRun(app.db, lib, pull(), next)).toBe(false);
    expect(pullMayRun(app.db, lib, pull(), head)).toBe(true);
    await approveToRun(app, alice, lib, pull());
    expect(pullMayRun(app.db, lib, pull(), next)).toBe(true);
  });

  test("a reader and a guest are refused", async () => {
    const head = await push("child/kid/two", "x.md");
    const opened = await openPull(app, alice, lib, {
      title: "Proposed again",
      baseBranch: "main",
      headBranch: "child/kid/two",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = getPull(app.db, lib.id, opened.value.number)!;
    const byReader = await approveToRun(app, carol, lib, pull);
    expect(byReader.ok).toBe(false);
    const byGuest = await approveToRun(app, undefined, lib, pull);
    expect(byGuest.ok).toBe(false);
    expect(pullMayRun(app.db, lib, pull, head)).toBe(false);
  });

  test("a review from another writer still lets a proposal run", async () => {
    const head = await push("child/kid/three", "y.md");
    const opened = await openPull(app, alice, lib, {
      title: "Third",
      baseBranch: "main",
      headBranch: "child/kid/three",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = getPull(app.db, lib.id, opened.value.number)!;
    app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(carol.id);
    record(app.db, { issueId: pull.id, authorId: carol.id, state: "approved", commitOid: head });
    expect(pullMayRun(app.db, lib, pull, head)).toBe(true);
  });

  test("on an autonomous repo with no required review, a grant and a green check do not land it", async () => {
    app.db
      .query("UPDATE repo SET require_review = 0, autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1")
      .run(lib.id, alice.id);
    const open = { ...lib, requireReview: false, autonomy: "autonomous" as const, autonomyBy: alice.id };
    // Control: an ordinary writer's branch pull would land on its own.
    await push("feature/plain", "plain.md");
    const plain = await openPull(app, alice, open, { title: "Plain", baseBranch: "main", headBranch: "feature/plain" });
    if (!plain.ok) throw new Error(String(plain.error));
    expect(landsOnItsOwn(app.db, open, getPull(app.db, lib.id, plain.value.number)!)).toBe(true);

    await push("child/kid/auto", "auto.md");
    const opened = await openPull(app, alice, open, { title: "Auto", baseBranch: "main", headBranch: "child/kid/auto" });
    if (!opened.ok) throw new Error(String(opened.error));
    recordPullProposal(app.db, opened.value.id, { child: "kid", origin: "https://kid.example.com/" });
    const granted = await approveToRun(app, alice, open, getPull(app.db, lib.id, opened.value.number)!);
    if (!granted.ok) throw new Error(granted.error);
    const pull = getPull(app.db, lib.id, opened.value.number)!;
    const check = createRun(app.db, {
      repoId: lib.id, kind: "check", issueId: pull.id, env: `pull-${pull.number}`,
      commitOid: pull.headOid, reason: "pull",
    });
    claimRun(app.db, check.id);
    finishRun(app.db, check.id, { state: "ok", summary: "check passed" });
    expect(landsOnItsOwn(app.db, open, pull)).toBe(false);
    expect(await landIfGreen(app, open, pull)).toBe(false);
    expect(getPull(app.db, lib.id, pull.number)!.mergedAt).toBeNull();
  });

  test("the terminal's A lets a proposed head run, and it is no review", async () => {
    const head = await push("child/kid/tty", "tty.md");
    const opened = await openPull(app, alice, lib, { title: "Tty", baseBranch: "main", headBranch: "child/kid/tty" });
    if (!opened.ok) throw new Error(String(opened.error));
    recordPullProposal(app.db, opened.value.id, { child: "kid", origin: "https://kid.example.com/" });
    const pull = getPull(app.db, lib.id, opened.value.number)!;
    const terminal = headlessTerminal(140, 44);
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:alice", user: alice },
      { terminal, exitHooks: false },
    );
    tui.start();
    try {
      tui.ctx.push(pullScreen(session, tui.ctx, local(session, lib), pull.number));
      const end = Date.now() + 20_000;
      while (!tui.screen.toText().includes("let it run here")) {
        if (Date.now() > end) throw new Error(tui.screen.toText());
        await settleApp(tui);
        await Bun.sleep(20);
      }
      expect(pullMayRun(app.db, lib, pull, head)).toBe(false);
      tui.dispatch({ type: "key", key: "A", ctrl: false, alt: false, shift: true });
      while (!pullMayRun(app.db, lib, pull, head) && Date.now() < end) await Bun.sleep(20);
      expect(pullMayRun(app.db, lib, pull, head)).toBe(true);
      expect(
        app.db.query("SELECT COUNT(*) AS n FROM review WHERE issue_id = ?1").get(pull.id),
      ).toEqual({ n: 0 });
    } finally {
      tui.stop();
    }
  }, 60_000);

  test("a writer's later request for changes on the head withdraws the grant", async () => {
    app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(carol.id);
    const head = await push("child/kid/stop", "stop.md");
    const opened = await openPull(app, alice, lib, { title: "Stop", baseBranch: "main", headBranch: "child/kid/stop" });
    if (!opened.ok) throw new Error(String(opened.error));
    recordPullProposal(app.db, opened.value.id, { child: "kid", origin: "https://kid.example.com/" });
    const pull = () => getPull(app.db, lib.id, opened.value.number)!;
    const granted = await approveToRun(app, alice, lib, pull());
    if (!granted.ok) throw new Error(granted.error);
    expect(pullMayRun(app.db, lib, pull(), head)).toBe(true);

    await Bun.sleep(10);
    const asked = await submitReview(app, { ...carol, isAdmin: true }, lib, pull(), { state: "changes_requested" });
    if (!asked.ok) throw new Error(String(asked.error));
    // What the preview's teardown asks (`mayRun`) is this same question.
    expect(pullMayRun(app.db, lib, pull(), head)).toBe(false);

    // A fresh grant, after the request, lets it run again.
    await Bun.sleep(10);
    await approveToRun(app, alice, lib, pull());
    expect(pullMayRun(app.db, lib, pull(), head)).toBe(true);
  });

  test("an ok resolve run with no commit on a conflicting pull reads failed; one that pushed reads landed", async () => {
    const theirs = await commitToBranch(app, alice, lib, {
      branch: "feature/clash",
      message: "clash",
      files: [{ path: "clash.md", content: "other\n" }],
    });
    if (!theirs.ok) throw new Error(JSON.stringify(theirs.error));
    await push("main", "clash.md");
    const opened = await openPull(app, alice, lib, {
      title: "Clash",
      baseBranch: "main",
      headBranch: "feature/clash",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = () => getPull(app.db, lib.id, opened.value.number)!;
    const dir = await pullDir(app.db, app.reposRoot, lib, pull());
    const ran = (commitOid?: string) => {
      const run = createRun(app.db, {
        repoId: lib.id, kind: "agent", issueId: pull().id, reason: "resolve",
      });
      claimRun(app.db, run.id);
      finishRun(app.db, run.id, { state: "ok", summary: "done", commitOid });
      return run;
    };
    ran();
    const seen = await proposalOf(app, lib, pull(), dir);
    expect(seen).toEqual({ kind: "failed", state: "ok", summary: "the crew did not push a resolution" });

    ran(pull().headOid);
    expect((await proposalOf(app, lib, pull(), dir)).kind).toBe("landed");
  });
});
