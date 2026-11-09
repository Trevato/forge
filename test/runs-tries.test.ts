import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import type { Issue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import {
  automaticRunsSince,
  automaticRunsSinceFor,
  claimRun,
  createRun,
  finishRun,
  getRun,
} from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";

describe("a run records what it held and whether it pushed", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let mason: User;
  let repo: Repo;
  let issue: Issue;
  const since = "2026-01-01T00:00:00.000Z";

  /** A finished check_failed run on the issue, pushed or not, or unrecorded. */
  const tried = (outcome: { pushed?: boolean; contextTokens?: number }) => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.id,
      actorId: mason.id,
      reason: "check_failed",
    });
    claimRun(app.db, run.id);
    return finishRun(app.db, run.id, {
      state: "ok",
      summary: "updated pull",
      turns: 3,
      ...outcome,
    })!;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tries-"));
    app = createApp({ dataDir, port: 0 });
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
    const made = await createRepo(app, alice, {
      name: "engine",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const agent = await createAgent(app, alice, { username: "mason" });
    if (!agent.ok) throw new Error(String(agent.error));
    mason = getUserByName(app.db, "mason")!;
    const opened = openIssue(app, alice, repo, { title: "A red pull" });
    if (!opened.ok) throw new Error(String(opened.error));
    issue = opened.value;
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the context a session held at its end is kept on the row; unreported reads as 0", () => {
    expect(tried({ contextTokens: 61_250, pushed: true }).contextTokens).toBe(
      61_250,
    );
    const bare = tried({ pushed: true });
    expect(bare.contextTokens).toBe(0);
    expect(getRun(app.db, bare.id)!.pushed).toBe(true);
  });

  test("a try is a pushed fix: a run that pushed nothing counts for nothing, one from before this was recorded counts as it did", () => {
    const before = automaticRunsSince(app.db, issue.id, since);
    tried({ pushed: false });
    expect(automaticRunsSince(app.db, issue.id, since)).toBe(before);
    const unrecorded = tried({});
    expect(unrecorded.pushed).toBeNull();
    expect(automaticRunsSince(app.db, issue.id, since)).toBe(before + 1);
    tried({ pushed: true });
    expect(automaticRunsSince(app.db, issue.id, since)).toBe(before + 2);
    expect(
      automaticRunsSinceFor(app.db, new Map([[issue.id, since]])).get(issue.id),
    ).toBe(before + 2);
  });
});
