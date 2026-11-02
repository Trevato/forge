import { seatAs } from "./seat.ts";
import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../src/app.ts";
import { addToCrew, createAgent } from "../../src/actions/crew.ts";
import { openIssue } from "../../src/actions/issues.ts";
import { createRepo, updateRepoSettings } from "../../src/actions/repos.ts";
import {} from "../../src/core/agents.ts";
import type { Issue } from "../../src/core/issues.ts";
import { getRepoById } from "../../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../../src/core/runs.ts";
import { createUser, getUserByName } from "../../src/core/users.ts";
import { serve } from "../../src/http/server.ts";
import { settleAgentRun } from "../../src/crew/autonomy.ts";
import { interruptedSummary } from "../../src/crew/interrupted.ts";

/**
 * One forge with alice's `engine` on its own: atlas plans, mason builds.
 * `ended` is a builder's run on an issue that ends without a pull, settled
 * as the crew would settle it. Shared by `test/crew-parks.test.ts`,
 * `test/crew-parks-done.test.ts` and `test/crew-parks-planner.test.ts`.
 */
export async function engine(
  prefix: string,
  visibility: "public" | "private" = "private",
) {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  const app = createApp({ dataDir, port: 0 });
  const servers = await serve(app);
  const a = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  const alice = a.value;
  const made = await createRepo(app, alice, { name: "engine", visibility });
  if (!made.ok) throw new Error(String(made.error));
  const repo = made.value;
  for (const name of ["atlas", "mason"]) {
    const agent = await createAgent(app, alice, { username: name });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(app, alice, repo, name).ok).toBe(true);
  }
  const atlas = getUserByName(app.db, "atlas")!;
  const mason = getUserByName(app.db, "mason")!;
  seatAs(app.db, repo.id, atlas.id, "planner");
  const set = await updateRepoSettings(app, alice, repo, {
    autonomy: "autonomous",
    autonomyDirection: "Keep the engine small.",
    autonomyCeilingUsd: 100,
    autonomyBy: alice.id,
  });
  if (!set.ok) throw new Error(JSON.stringify(set.error));
  const fresh = () => getRepoById(app.db, repo.id)!;
  return {
    dataDir,
    app,
    servers,
    alice,
    atlas,
    mason,
    repo,
    fresh,
    issue(title: string): Issue {
      const opened = openIssue(app, alice, fresh(), { title });
      if (!opened.ok) throw new Error(String(opened.error));
      return opened.value;
    },
    ended(on: Issue, summary: string): boolean {
      const run = createRun(app.db, {
        repoId: repo.id,
        kind: "agent",
        issueId: on.id,
        actorId: mason.id,
        reason: "assigned",
      });
      claimRun(app.db, run.id);
      const recorded = interruptedSummary(summary);
      finishRun(app.db, run.id, { state: "failed", summary: recorded });
      return settleAgentRun(app, fresh(), {
        issueId: on.id,
        state: "failed",
        summary: recorded,
        reason: "assigned",
        actorId: mason.id,
      });
    },
    async close(): Promise<void> {
      servers.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
export type Engine = Awaited<ReturnType<typeof engine>>;
export const tick = () => Bun.sleep(5);
