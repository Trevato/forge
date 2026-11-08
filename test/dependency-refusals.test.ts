/**
 * What a plan refuses: a pull neither waits nor is waited on, and an issue
 * of another repository is no part of this one's plan. After each refusal
 * the map has no new edge.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { createIssue, type Issue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("dependency refusals", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let token: string;
  let repo: Repo;
  let issue: Issue;
  let pull: Issue;
  let foreign: Issue;
  let foreignRepo: Repo;

  const headers = () => ({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  });
  const link = (n: number, blockedBy: number) =>
    fetch(`${servers.url}/api/v1/repos/alice/engine/issues/${n}/dependencies`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ blockedBy }),
    });
  const edges = async () =>
    (
      (await (
        await fetch(`${servers.url}/api/v1/repos/alice/engine/map`, {
          headers: headers(),
        })
      ).json()) as { edges: unknown[] }
    ).edges;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-deprefuse-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    const alice = made.value;
    token = createToken(app.db, alice.id, "test", "rw").token;
    const r = await createRepo(app, alice, { name: "engine", visibility: "private" });
    const o = await createRepo(app, alice, { name: "other", visibility: "private" });
    if (!r.ok || !o.ok) throw new Error("repo");
    repo = r.value;
    foreignRepo = o.value;
    const i = openIssue(app, alice, repo, { title: "An issue" });
    if (!i.ok) throw new Error(String(i.error));
    issue = i.value;
    const p = createIssue(app.db, {
      repoId: repo.id,
      authorId: alice.id,
      title: "A pull",
      kind: "pull",
    });
    if (!p.ok) throw new Error(p.error);
    pull = p.value;
    // Several issues in the other repository, so its numbers outrun this one's.
    let last: Issue | undefined;
    for (const title of ["a", "b", "c"]) {
      const f = openIssue(app, alice, foreignRepo, { title });
      if (!f.ok) throw new Error(String(f.error));
      last = f.value;
    }
    foreign = last!;
  });

  afterAll(async () => {
    await app.close?.();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an issue waiting on a pull is not_an_issue", async () => {
    const res = await link(issue.number, pull.number);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("not_an_issue");
    expect(await edges()).toEqual([]);
  });

  test("a pull waiting on an issue is not_an_issue", async () => {
    // The issues route does not serve a pull as the one that waits: 404.
    const res = await link(pull.number, issue.number);
    expect(res.status).toBe(404);
    // The core names the refusal.
    const core = addDependency(app.db, pull, issue, undefined);
    expect(core.ok).toBe(false);
    if (!core.ok) expect(core.error).toBe("not_an_issue");
    expect(await edges()).toEqual([]);
  });

  test("another repository's issue is refused, in the core as cross_repo", async () => {
    const core = addDependency(app.db, issue, foreign, undefined);
    expect(core.ok).toBe(false);
    if (!core.ok) expect(core.error).toBe("cross_repo");
    // The API resolves the blocker inside the repository, so its number is
    // unknown here and the answer is 422 either way.
    const res = await link(issue.number, foreign.number);
    expect(res.status).toBe(422);
    expect(await edges()).toEqual([]);
  });
});
