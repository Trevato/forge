/**
 * `POST /api/v1/asks/give-back` over HTTP: a writer with an `rw` token gives
 * a hand-over back and it leaves their inbox; a read-only token is refused
 * by scope, signed out is unauthorized; a non-hand-over is `bad_action`; a
 * reader, or someone who cannot see the repository, gets `not_found`.
 */

import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addCrew, createAgentRow } from "../src/core/agents.ts";
import { getIssueById, listComments } from "../src/core/issues.ts";
import { createRepo, type Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { id } from "../src/kernel/id.ts";
import { askLinesFor } from "../src/web/studio/asks.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

const ZERO = "0".repeat(40);

describe("POST /api/v1/asks/give-back", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let owner: User;
  let builder: User;
  let reviewer: User;
  let repo: Repo;
  let privateRepo: Repo;
  let rw = "";
  let ro = "";
  let readerTok = "";
  let outsiderTok = "";
  let seq = 0;

  const user = async (username: string, agent = false): Promise<User> => {
    const made = await createUser(app.db, {
      username,
      email: `${username}@forge.test`,
      ...(agent
        ? { agent: true, origin: "agent" as const }
        : { password: "a-good-passphrase", origin: "seed" as const, trusted: true }),
    });
    if (!made.ok) throw new Error(`seed ${username}: ${made.error}`);
    if (agent) createAgentRow(app.db, { userId: made.value.id, brief: `${username}.` });
    return made.value;
  };

  const pull = (target: Repo, author: User, reviews = 3): string => {
    const issueId = id();
    const number = ++seq;
    app.db
      .query(
        `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state)
         VALUES (?1, ?2, ?3, 'pull', 'Pull', '', ?4, 'open')`,
      )
      .run(issueId, target.id, number, author.id);
    app.db
      .query(
        `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id)
         VALUES (?1, 'main', ?2, ?3, ?3, ?4)`,
      )
      .run(issueId, `b/${number}`, ZERO, target.id);
    for (let r = 0; r < reviews; r++)
      submitReview(app.db, {
        issueId,
        authorId: reviewer.id,
        state: "changes_requested",
        body: `Round ${r}.`,
        commitOid: ZERO,
      });
    return issueId;
  };

  const give = (item: unknown, token?: string) =>
    fetch(`${servers.url}/api/v1/asks/give-back`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: servers.url,
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ item }),
    });

  const asking = (pullId: string): boolean =>
    askLinesFor(app.db, owner).some((r) => r.items.includes(`handover:${pullId}`));

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-api-give-back-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    owner = await user("alice");
    const reader = await user("reader");
    const outsider = await user("outsider");
    builder = await user("builder", true);
    reviewer = await user("reviewer", true);
    promote(app.db, owner);
    const open = await createRepo(app.db, app.reposRoot, {
      ownerId: owner.id,
      name: "back",
      visibility: "public",
      description: "back",
    });
    const closed = await createRepo(app.db, app.reposRoot, {
      ownerId: owner.id,
      name: "hidden",
      visibility: "private",
      description: "hidden",
    });
    if (!open.ok || !closed.ok) throw new Error("seed repo");
    repo = open.value;
    privateRepo = closed.value;
    for (const target of [repo, privateRepo]) {
      for (const agent of [builder, reviewer]) addCrew(app.db, target.id, agent.id, owner.id);
      seatAs(app.db, target.id, reviewer.id, "reviewer");
    }
    rw = createToken(app.db, owner.id, "rw", "rw").token;
    ro = createToken(app.db, owner.id, "ro", "ro").token;
    readerTok = createToken(app.db, reader.id, "rw", "rw").token;
    outsiderTok = createToken(app.db, outsider.id, "rw", "rw").token;
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  test("a writer with an rw token gives a hand-over back and it leaves their inbox", async () => {
    const item = pull(repo, builder);
    expect(asking(item)).toBe(true);
    const res = await give(`handover:${item}`, rw);
    expect(res.status).toBe(201);
    const got = (await res.json()) as { pull: number; builder: string };
    expect(got).toEqual({ pull: getIssueById(app.db, item)!.number, builder: "builder" });
    expect(getIssueById(app.db, item)!.assigneeId).toBe(builder.id);
    expect(listComments(app.db, item).map((c) => c.body)).toContain("Given back to the crew by @alice");
    expect(asking(item)).toBe(false);
  });

  test("a read-only token is refused by scope and signed out is unauthorized", async () => {
    const item = pull(repo, builder);
    const scoped = await give(`handover:${item}`, ro);
    expect(scoped.status).toBe(403);
    expect(getIssueById(app.db, item)!.assigneeId).toBeNull();
    const anon = await give(`handover:${item}`);
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as { error: string }).error).toBe("unauthorized");
    expect(asking(item)).toBe(true);
  });

  test("an item that is not a hand-over is bad_action", async () => {
    const item = pull(repo, builder);
    for (const bad of [`decide:${item}`, "nonsense", 7, null]) {
      const res = await give(bad, rw);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { error: string }).error).toBe("bad_action");
    }
    // A hand-over whose pull no crew member opened has no one to go back to.
    const mine = pull(repo, owner);
    const res = await give(`handover:${mine}`, rw);
    expect(((await res.json()) as { error: string }).error).toBe("bad_action");
  });

  test("a reader, or someone who cannot see the repository, gets not_found", async () => {
    const open = pull(repo, builder);
    const hidden = pull(privateRepo, builder);
    const missing = await give(`handover:${id()}`, rw);
    const bodies: string[] = [];
    for (const [item, token] of [
      [open, readerTok],
      [hidden, outsiderTok],
      [hidden, readerTok],
    ] as const) {
      const res = await give(`handover:${item}`, token);
      expect(res.status).toBe(404);
      const text = await res.text();
      expect((JSON.parse(text) as { error: string }).error).toBe("not_found");
      bodies.push(text);
    }
    // The same answer as for a pull that does not exist.
    expect(missing.status).toBe(404);
    expect(bodies.every((b) => b === bodies[0])).toBe(true);
    expect(await missing.text()).toBe(bodies[0]!);
    expect(getIssueById(app.db, open)!.assigneeId).toBeNull();
    expect(getIssueById(app.db, hidden)!.assigneeId).toBeNull();
  });
});
