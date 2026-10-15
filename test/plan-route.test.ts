/**
 * Invariant: `POST …/plan` (the MCP `plan` tool's action, #1063) refuses an
 * issue with no pillar and opens nothing, and opens the issues under the
 * umbrella once the pillar is named. No crew run: the route is the unit.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { listIssues } from "../src/core/issues.ts";
import { pillarsOf } from "../src/core/pillars.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("POST …/plan", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let rw = "";

  const titles = () => listIssues(app.db, repo.id, {}).map((i) => i.title);
  const post = (token: string, issues: unknown) =>
    fetch(`${servers.url}/api/v1/repos/alice/garden/plan`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ issues }),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-planroute-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    rw = createToken(app.db, alice.id, "rw", "rw").token;
    const created = await createRepo(app, alice, { name: "garden", visibility: "private" });
    if (!created.ok) throw new Error(String(created.error));
    repo = created.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const umbrella = openIssue(app, alice, repo, { title: "P0 Trust: be trusted", body: "" });
    if (!umbrella.ok) throw new Error(String(umbrella.error));
    expect(pillarsOf(app.db, repo).pillars.length).toBe(1);
    const gate = openIssue(app, alice, repo, { title: "Later gate: not yet", body: "" });
    if (!gate.ok) throw new Error(String(gate.error));
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a plan with a pillarless issue is refused with no_pillar and opens nothing; with the pillar named it opens the issues under the umbrella", async () => {
    const before = titles().length;
    const first = await post(rw, [{ key: "a", title: "Water the beds" }]);
    expect(((await first.json()) as { error: string }).error).toBe("no_pillar");
    expect(titles().length).toBe(before);
    const res = await post(rw, [
      { key: "a", title: "Water the beds", pillar: "P0" },
      { key: "b", title: "Buy a hose", later: true, why: "Nothing needs it yet." },
    ]);
    const second = (await res.json()) as { opened: { key: string; number: number }[]; later: unknown[] };
    expect(second.opened.map((o) => o.key)).toEqual(["a", "b"]);
    expect(titles().filter((t) => t === "Water the beds").length).toBe(1);
    expect(second.later.length).toBe(1);
    const trust = pillarsOf(app.db, repo).pillars[0]!;
    expect(
      app.db
        .query("SELECT 1 FROM issue_dependency WHERE issue_id = ?1 AND blocked_by_id = (SELECT id FROM issue WHERE repo_id = ?2 AND number = ?3)")
        .get(trust.umbrella.id, repo.id, second.opened[0]!.number),
    ).not.toBeNull();
  });

  test("a person's token plans the same way, all or nothing, and a read token is refused", async () => {
    const before = titles().length;
    const refused = await post(rw, [
      { key: "x", title: "Fine", pillar: "P0" },
      { key: "y", title: "No pillar" },
    ]);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: string }).error).toBe("no_pillar");
    expect(titles().length).toBe(before);
    const ro = createToken(app.db, alice.id, "ro", "ro").token;
    expect((await post(ro, [{ key: "x", title: "Fine", pillar: "P0" }])).status).toBe(403);
    expect((await post(rw, "nope")).status).toBe(422);
  });
});
