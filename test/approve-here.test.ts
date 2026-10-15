/**
 * A pull whose head lives in a fork on the origin (a mirror's pull) is
 * someone else's code: it runs nothing until a person who can write here
 * approves that exact head, through the page or the API. Reviews imported
 * from the origin never count.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approveHere, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { pullMayRun } from "../src/core/pull_trust.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { submitReview as record } from "../src/core/reviews.ts";
import { listRuns } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { forgeHttp, type ForgeHttp } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("a local writer approval lets an origin fork's pull run", () => {
  let dataDir: string;
  let app: App;
  let http: ForgeHttp | undefined;
  let checks: ChecksHandle;
  let alice: User;
  let carol: User;
  let lib: Repo;
  let carolFork: Repo | undefined; // one fork of a parent per owner
  let n = 0;

  const settle = () => Bun.sleep(400);
  const checksOf = (pull: Pull, commit: string) =>
    listRuns(app.db, lib.id, { kind: "check", limit: 100 }).filter(
      (r) => r.env === `pull-${pull.number}` && r.commitOid === commit,
    );

  /** Carol's fork pull, then marked as the origin's: its head is elsewhere. */
  async function originPull() {
    const branch = `b${++n}`;
    if (!carolFork) {
      const forked = await forkRepo(app, carol, lib, "fork");
      if (!forked.ok) throw new Error(String(forked.error));
      carolFork = forked.value;
    }
    const fork = { value: carolFork };
    const committed = await commitToBranch(app, carol, fork.value, {
      branch,
      message: "From the origin's fork",
      files: [{ path: `${branch}.md`, content: "hi\n" }],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const opened = await openPull(app, carol, lib, {
      title: "Theirs",
      baseBranch: "main",
      headBranch: branch,
      headRepo: fork.value,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    app.db.run("UPDATE pull SET origin_head_repo = ?1 WHERE issue_id = ?2", [
      "octo/lib",
      opened.value.id,
    ]);
    const pull = getPull(app.db, lib.id, opened.value.number)!;
    return { pull, fork: fork.value, head: committed.value.commitOid };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-approve-here-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    checks = startChecks(app, { forgeUrl: "http://127.0.0.1:9", concurrency: 1 });
    const people: User[] = [];
    for (const [username, first] of [
      ["alice", true],
      ["carol", false],
    ] as const) {
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
    const made = await createRepo(app, alice, {
      name: "lib",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    lib = made.value;
    const declared = await commitToBranch(app, alice, lib, {
      message: "Declare a check",
      files: [
        {
          path: "forge.json",
          content: `{"check": {"run": "true", "install": ""}}\n`,
        },
      ],
    });
    if (!declared.ok) throw new Error(JSON.stringify(declared.error));
  }, 120_000);

  afterAll(async () => {
    await checks.stop();
    http?.close();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("it runs nothing, an imported review does not change that, a local approval does, a new head waits again", async () => {
    const { pull, fork, head } = await originPull();
    await settle();
    expect(checksOf(pull, head)).toHaveLength(0);
    expect(pullMayRun(app.db, lib, pull, head)).toBe(false);

    // The origin's approval, as imported: it names the connecting account.
    record(app.db, {
      issueId: pull.id,
      authorId: alice.id,
      state: "approved",
      commitOid: head,
      originRemoteId: "r1",
      originAuthor: "octocat",
    });
    expect(pullMayRun(app.db, lib, pull, head)).toBe(false);

    const refused = await approveHere(app, carol, lib, pull);
    expect(refused.ok).toBe(false);
    expect(pullMayRun(app.db, lib, pull, head)).toBe(false);

    const done = await approveHere(app, alice, lib, pull);
    if (!done.ok) throw new Error(done.error);
    expect(done.value.commitOid).toBe(head);
    expect(done.value.authorId).toBe(alice.id);
    expect(done.value.originAuthor).toBeNull();
    expect(pullMayRun(app.db, lib, pull, head)).toBe(true);
    await settle();
    expect(checksOf(pull, head).length).toBeGreaterThan(0);

    const again = await commitToBranch(app, carol, fork, {
      branch: pull.headBranch,
      message: "Again",
      files: [{ path: "again.md", content: "again\n" }],
    });
    if (!again.ok) throw new Error(JSON.stringify(again.error));
    expect(pullMayRun(app.db, lib, pull, again.value.commitOid)).toBe(false);
    await settle();
    expect(checksOf(pull, again.value.commitOid)).toHaveLength(0);
  }, 60_000);

  test("the pull page offers the control to a writer, and the API approves", async () => {
    http = forgeHttp(app);
    const url = "http://forge.test";
    const cookie = `forge_session=${createSession(app.db, alice.id).token}`;
    const { pull, head } = await originPull();
    const page = () =>
      http!
        .handle(
          new Request(`${url}/alice/lib/pulls/${pull.number}`, {
            headers: { cookie },
          }),
        )
        .then((r) => r.text());
    expect(await page()).toContain("approve-here");
    const token = createToken(app.db, alice.id, "t", "rw").token;
    const res = await http.handle(
      new Request(
        `${url}/api/v1/repos/alice/lib/pulls/${pull.number}/approve-here`,
        { method: "POST", headers: { authorization: `Bearer ${token}` } },
      ),
    );
    expect(res.status).toBe(201);
    expect(pullMayRun(app.db, lib, pull, head)).toBe(true);
    expect(await page()).not.toContain("approve-here");
  }, 60_000);
});
