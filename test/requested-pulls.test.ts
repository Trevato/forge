/**
 * Which pulls wait on "changes requested" (#6714): the newest verdict a
 * reviewer on the crew passed, on any head; an origin's imported review is
 * never the crew's word. `requestedPulls` is the one read the tick and /flow
 * share, so these pin it.
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
import { getPull } from "../src/core/pulls.ts";
import { requestedPulls, verdictIsStale } from "../src/core/requested.ts";
import type { Repo } from "../src/core/repos.ts";
import { submitReview, type ReviewState } from "../src/core/reviews.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("requestedPulls", () => {
  let dataDir = "";
  let app: App;
  let alice: User;
  let builder: User;
  let reviewer: User;
  let garden: Repo;
  let orchard: Repo;
  let n = 0;

  const push = async (repo: Repo, branch: string, base?: string) => {
    const c = await commitToBranch(app, alice, repo, {
      branch,
      ...(base === undefined ? {} : { base }),
      message: `${branch} ${++n}`,
      files: [{ path: `${branch}.md`, content: `${n}\n` }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
  };
  const pullIn = async (repo: Repo): Promise<Pull> => {
    const branch = `b${++n}`;
    await push(repo, branch, "main");
    const o = await openPull(app, builder, repo, {
      title: branch,
      body: "",
      baseBranch: "main",
      headBranch: branch,
    });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
  };
  const say = (
    pull: Pull,
    state: ReviewState,
    at: string,
    opts: { imported?: boolean; oid?: string } = {},
  ) => {
    const r = submitReview(app.db, {
      issueId: pull.id,
      authorId: reviewer.id,
      state,
      body: "",
      commitOid: opts.oid ?? pull.headOid,
      createdAt: at,
      ...(opts.imported ? { originRemoteId: `r${++n}`, originAuthor: "octocat" } : {}),
    });
    if (!r.ok) throw new Error(r.error);
  };
  const numbers = (repoId?: string) => requestedPulls(app.db, repoId).map((p) => p.pullId);
  const day = (d: number) => `2026-01-0${d}T00:00:00.000Z`;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-requested-pulls-"));
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
    for (const name of ["mason", "quill"]) {
      const agent = await createAgent(app, alice, { username: name });
      if (!agent.ok) throw new Error(String(agent.error));
    }
    builder = getUserByName(app.db, "mason")!;
    reviewer = getUserByName(app.db, "quill")!;
    const repos: Repo[] = [];
    for (const name of ["garden", "orchard"]) {
      const r = await createRepo(app, alice, { name, visibility: "private" });
      if (!r.ok) throw new Error(String(r.error));
      await push(r.value, "main");
      for (const who of ["mason", "quill"]) expect(addToCrew(app, alice, r.value, who).ok).toBe(true);
      seatAs(app.db, r.value.id, reviewer.id, "reviewer");
      repos.push(r.value);
    }
    [garden, orchard] = repos as [Repo, Repo];
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the newest crew verdict decides: changes requested lists the pull, a later approval takes it off", async () => {
    const pull = await pullIn(garden);
    expect(numbers(garden.id)).not.toContain(pull.id);
    say(pull, "changes_requested", day(1));
    const [listed] = requestedPulls(app.db, garden.id).filter((p) => p.pullId === pull.id);
    expect(listed).toMatchObject({ number: pull.number, repo: "alice/garden", reviewerId: reviewer.id });
    expect(verdictIsStale(listed!)).toBe(false);
    say(pull, "approved", day(2));
    expect(numbers(garden.id)).not.toContain(pull.id);
  });

  test("a verdict on an older head, with a newer push, is listed and stale", async () => {
    const pull = await pullIn(garden);
    say(pull, "changes_requested", day(1));
    await push(garden, pull.headBranch);
    const pushed = getPull(app.db, garden.id, pull.number)!;
    expect(pushed.headOid).not.toBe(pull.headOid);
    const listed = requestedPulls(app.db, garden.id).find((p) => p.pullId === pull.id)!;
    expect(listed.reviewedOid).toBe(pull.headOid);
    expect(listed.headOid).toBe(pushed.headOid);
    expect(verdictIsStale(listed)).toBe(true);
  });

  test("a review imported from an origin never lists a pull", async () => {
    const only = await pullIn(garden);
    say(only, "changes_requested", day(1), { imported: true });
    expect(numbers(garden.id)).not.toContain(only.id);
    // Nor does it hide the crew's own word: the crew approved, the import is newer.
    const both = await pullIn(garden);
    say(both, "approved", day(1));
    say(both, "changes_requested", day(2), { imported: true });
    expect(numbers(garden.id)).not.toContain(both.id);
    // And an import after the crew's changes-requested leaves the pull listed.
    const kept = await pullIn(garden);
    say(kept, "changes_requested", day(1));
    say(kept, "approved", day(2), { imported: true });
    expect(numbers(garden.id)).toContain(kept.id);
  });

  test("closed and merged pulls are never listed", async () => {
    const closed = await pullIn(garden);
    const merged = await pullIn(garden);
    say(closed, "changes_requested", day(1));
    say(merged, "changes_requested", day(1));
    expect(numbers(garden.id)).toEqual(expect.arrayContaining([closed.id, merged.id]));
    app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(closed.id);
    app.db
      .query("UPDATE pull SET merged_at = ?2 WHERE issue_id = ?1")
      .run(merged.id, day(3));
    expect(numbers(garden.id)).not.toContain(closed.id);
    expect(numbers(garden.id)).not.toContain(merged.id);
  });

  test("oldest verdict first, and repoId narrows to one repository", async () => {
    app.db.query("UPDATE issue SET state = 'closed'").run();
    const newer = await pullIn(garden);
    const older = await pullIn(orchard);
    const oldest = await pullIn(garden);
    say(newer, "changes_requested", day(5));
    say(older, "changes_requested", day(4));
    say(oldest, "changes_requested", day(3));
    expect(numbers()).toEqual([oldest.id, older.id, newer.id]);
    expect(numbers(garden.id)).toEqual([oldest.id, newer.id]);
    expect(numbers(orchard.id)).toEqual([older.id]);
  });
});
