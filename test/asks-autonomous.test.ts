/**
 * Autonomous mode keeps the crew's own stalls off the owner's asks (#1655):
 * a parked issue is the planner's, an assisted repository's still asks.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addComment, openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { getRepoById, updateRepoSettings, type Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { BREAKER_NOTE } from "../src/crew/breaker.ts";
import { askLinesFor } from "../src/web/studio/asks.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("autonomous repositories ask no one about the crew's own stalls", () => {
  let dataDir = "";
  let app: App;
  let alice: User;
  let repo: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-asks-auto-"));
    app = createApp({ dataDir, port: 0 });
    const made = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-standing-passphrase",
    });
    if (!made.ok) throw new Error("no alice");
    alice = getUserByName(app.db, "alice")!;
    const r = await createRepo(app, alice, { name: "shelf", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a parked issue asks on an assisted repository and on no autonomous one", () => {
    const made = openIssue(app, alice, repo, { title: "Shelve it" });
    if (!made.ok) throw new Error(String(made.error));
    expect(addComment(app, alice, repo, made.value, BREAKER_NOTE).ok).toBe(true);
    const asking = () =>
      askLinesFor(app.db, alice).some((r) => r.items.includes(`parked:${made.value.id}`));
    repo = updateRepoSettings(app.db, repo, { autonomy: "assisted" });
    expect(asking()).toBe(true);
    repo = updateRepoSettings(app.db, repo, {
      autonomy: "autonomous",
      autonomyBy: alice.id,
      autonomyCeilingUsd: 10,
    });
    expect(getRepoById(app.db, repo.id)!.autonomy).toBe("autonomous");
    expect(asking()).toBe(false);
  });
});
