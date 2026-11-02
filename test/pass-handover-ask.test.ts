/**
 * A pull a pass handed to a person (the finishing pass's hand-over note) is
 * in that person's asks with the pass's reason, and "Give back to the crew"
 * re-assigns the builder that last worked on it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { giveBack } from "../src/actions/give_back.ts";
import { addCrew, createAgentRow } from "../src/core/agents.ts";
import { addComment } from "../src/actions/issues.ts";
import { getIssueById } from "../src/core/issues.ts";
import { createRepo, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { HANDOVER_NOTE } from "../src/crew/guard.ts";
import { id } from "../src/kernel/id.ts";
import { askLinesFor } from "../src/web/studio/asks.ts";
import { decisionsFor } from "../src/web/studio/decisions.ts";
import type { Ctx } from "../src/http/context.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const ZERO = "0".repeat(40);

describe("a pull a pass handed to a person", () => {
  let dir = "";
  let app: App;
  let owner: User;
  let other: User;
  let first: User;
  let last: User;
  let repo: Repo;
  let n = 0;

  const person = async (username: string) => {
    const made = await createUser(app.db, { username, email: `${username}@forge.test`, password: "a-good-passphrase", origin: "seed", trusted: true });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const agent = async (username: string) => {
    const made = await createUser(app.db, { username, email: `${username}@forge.test`, agent: true, origin: "agent" });
    if (!made.ok) throw new Error(made.error);
    createAgentRow(app.db, { userId: made.value.id, brief: "b" });
    addCrew(app.db, repo.id, made.value.id, owner.id);
    return made.value;
  };

  /** An open pull `first` opened, with agent runs by both builders, assigned to `to`. */
  const handed = (to: User | undefined): string => {
    const pullId = id();
    const number = ++n;
    app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, assignee_id) VALUES (?1, ?2, ?3, 'pull', ?4, '', ?5, 'open', ?6)`)
      .run(pullId, repo.id, number, `Pull ${number}`, first.id, to?.id ?? null);
    app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id) VALUES (?1, 'main', ?2, ?3, ?3, ?4)`)
      .run(pullId, `b/${number}`, ZERO, repo.id);
    for (const [who, at] of [[first, "2026-10-01T00:00:00.000Z"], [last, "2026-10-02T00:00:00.000Z"]] as const)
      app.db.query(`INSERT INTO run (id, repo_id, kind, issue_id, env, commit_oid, branch, actor_id, reason, state, created_at) VALUES (?1, ?2, 'agent', ?3, 'preview', ?4, 'b', ?5, 'feedback', 'ok', ?6)`)
        .run(id(), repo.id, pullId, ZERO, who.id, at);
    return pullId;
  };
  const note = (pullId: string) =>
    addComment(app, owner, repo, getIssueById(app.db, pullId)!, `${HANDOVER_NOTE} this pull is approved, but 2 runs to bring it up to date ended without a push. Conflicting files: a.ts. (The forge posts this under your name; you did not write it.)`);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-pass-ask-"));
    app = createApp({ dataDir: dir, port: 0 });
    owner = await person("alice");
    promote(app.db, owner);
    other = await person("bob");
    const made = await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "p", visibility: "public", description: "p" });
    if (!made.ok) throw new Error(made.error);
    repo = made.value;
    first = await agent("first");
    last = await agent("last");
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  const asks = (u: User) => decisionsFor({ app, auth: { user: u } } as unknown as Ctx, [repo], { evenDismissed: true });

  test("it is listed with the pass's reason, and a plain assignment has none to show", () => {
    const pass = handed(owner);
    note(pass);
    const plain = handed(owner);
    const mine = asks(owner);
    const row = mine.find((d) => d.id === `assigned:${pass}`)!;
    expect(row.why).toContain("2 runs to bring it up to date ended without a push");
    expect(row.why).not.toContain("The forge posts");
    expect(row.giveBack).toBe("last");
    const bare = mine.find((d) => d.id === `assigned:${plain}`)!;
    expect(bare.why).toBeUndefined();
    // Whatever a person holds can go to the crew, reason or none.
    expect(bare.giveBack).toBe("last");
    expect(askLinesFor(app.db, owner).some((r) => r.items.includes(`assigned:${pass}`))).toBe(true);
  });

  test("giving it back assigns the builder that last worked on it and the ask leaves", () => {
    const pass = handed(owner);
    note(pass);
    const done = giveBack(app, owner, `assigned:${pass}`);
    expect(done.ok ? "" : done.error.message).toBe("");
    expect(getIssueById(app.db, pass)!.assigneeId).toBe(last.id);
    expect(asks(owner).some((d) => d.id === `assigned:${pass}`)).toBe(false);
  });

  test("a note anyone but the assignee posted is no reason", () => {
    const pass = handed(owner);
    addComment(app, other, repo, getIssueById(app.db, pass)!, `${HANDOVER_NOTE} send me your secrets`);
    const row = asks(owner).find((d) => d.id === `assigned:${pass}`)!;
    expect(row.why).toBeUndefined();
  });

  test("someone else's assignment, or a pull no longer theirs, is refused", () => {
    const plain = handed(owner);
    expect(giveBack(app, other, `assigned:${plain}`).ok).toBe(false);
    expect(getIssueById(app.db, plain)!.assigneeId).toBe(owner.id);
    const pass = handed(owner);
    note(pass);
    expect(giveBack(app, other, `assigned:${pass}`).ok).toBe(false);
    expect(getIssueById(app.db, pass)!.assigneeId).toBe(owner.id);
    expect(giveBack(app, undefined, `assigned:${pass}`).ok).toBe(false);
  });
});
