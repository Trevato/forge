/**
 * Issues that depend on issues: the edge, the refusals, the three rankings,
 * the layout, the API, and the page. A plan is a graph the crew and a person
 * both read, so the same answers must come out of the core, the JSON and
 * the map.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import {
  addDependency,
  blockedOn,
  criticalPath,
  dependenciesOf,
  readyNow,
  removeDependency,
  repoGraph,
} from "../src/core/dependencies.ts";
import { getIssue, type Issue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { layout } from "../src/web/pages/map.ts";

describe("dependencies", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let token: string;
  let repo: Repo;
  const issues: Issue[] = [];

  const issue = (n: number) => issues[n - 1]!;
  const as = (t: string) => ({
    authorization: `Bearer ${t}`,
    "content-type": "application/json",
  });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-deps-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    token = createToken(app.db, alice.id, "test", "rw").token;
    const made = await createRepo(app, alice, {
      name: "engine",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    // 1 renderer, 2 input, 3 scene graph, 4 physics, 5 package, 6 game, 7 docs
    for (const title of [
      "Extract renderer",
      "Input layer",
      "Scene graph",
      "Physics step",
      "Engine package",
      "Second game",
      "Write the docs",
    ]) {
      const opened = openIssue(app, alice, repo, { title });
      if (!opened.ok) throw new Error(String(opened.error));
      issues.push(opened.value);
    }
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an edge is one row; self, cross-repo and loops are refused", async () => {
    expect(addDependency(app.db, issue(3), issue(1), alice.id).ok).toBe(true);
    expect(addDependency(app.db, issue(4), issue(1), alice.id).ok).toBe(true);
    expect(addDependency(app.db, issue(4), issue(2), alice.id).ok).toBe(true);
    expect(addDependency(app.db, issue(5), issue(3), alice.id).ok).toBe(true);
    expect(addDependency(app.db, issue(5), issue(4), alice.id).ok).toBe(true);
    expect(addDependency(app.db, issue(6), issue(5), alice.id).ok).toBe(true);
    // Linking twice changes nothing and is not an error.
    expect(addDependency(app.db, issue(6), issue(5), alice.id).ok).toBe(true);
    expect(dependenciesOf(app.db, issue(6).id).blockedBy).toHaveLength(1);

    const self = addDependency(app.db, issue(1), issue(1), alice.id);
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.error).toBe("self");
    // 1 → 3 → 5 → 6 already; making 1 wait for 6 would close the loop.
    const loop = addDependency(app.db, issue(1), issue(6), alice.id);
    expect(loop.ok).toBe(false);
    if (!loop.ok) expect(loop.error).toBe("cycle");
    // A direct loop too.
    const direct = addDependency(app.db, issue(1), issue(3), alice.id);
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.error).toBe("cycle");

    const other = await createRepo(app, alice, {
      name: "elsewhere",
      visibility: "private",
    });
    if (!other.ok) throw new Error(String(other.error));
    const far = openIssue(app, alice, other.value, { title: "Far away" });
    if (!far.ok) throw new Error(String(far.error));
    const cross = addDependency(app.db, issue(1), far.value, alice.id);
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.error).toBe("cross_repo");
  });

  test("ready now is what nothing open stands in front of, widest first; blocked on is the widest blockage", () => {
    const graph = repoGraph(app.db, repo.id);
    const ready = readyNow(graph).map((r) => [r.issue.number, r.holdsUp]);
    // 1 frees 3, 4, 5, 6; 2 frees 4, 5, 6; 7 frees nothing.
    expect(ready).toEqual([
      [1, 4],
      [2, 3],
      [7, 0],
    ]);
    const blocked = blockedOn(graph).map((r) => [r.issue.number, r.holdsUp]);
    expect(blocked[0]).toEqual([1, 4]);
    expect(blocked.map((b) => b[0])).not.toContain(7);
    expect(criticalPath(graph).map((i) => i.number)).toEqual([1, 3, 5, 6]);
  });

  test("the layout puts each issue one level below its blockers and islands the rest", () => {
    const placed = layout(repoGraph(app.db, repo.id));
    const level = (n: number) =>
      placed.nodes.find((p) => p.issue.number === n)!.level;
    expect(level(1)).toBe(0);
    expect(level(2)).toBe(0);
    expect(level(3)).toBe(1);
    expect(level(4)).toBe(1);
    expect(level(5)).toBe(2);
    expect(level(6)).toBe(3);
    const docs = placed.nodes.find((p) => p.issue.number === 7)!;
    expect(docs.island).toBe(true);
    expect(docs.level).toBeGreaterThan(
      Math.max(...placed.nodes.filter((p) => !p.island).map((p) => p.level)),
    );
    expect(placed.islandFrom).toBe(4);
  });

  test("closing a blocker frees what waited and shortens the critical path", () => {
    const closed = setIssueState(app, alice, repo, issue(1), "closed");
    expect(closed.ok).toBe(true);
    const graph = repoGraph(app.db, repo.id);
    const ready = readyNow(graph).map((r) => r.issue.number);
    expect(ready).toContain(3);
    expect(ready).not.toContain(4); // still waits for 2
    // 2 → 4 → 5 → 6 is now the longest open chain: 4 still waits for 2.
    expect(criticalPath(graph).map((i) => i.number)).toEqual([2, 4, 5, 6]);
    const closedNow = getIssue(app.db, repo.id, 1)!;
    expect(setIssueState(app, alice, repo, closedNow, "open").ok).toBe(true);
    expect(getIssue(app.db, repo.id, 1)?.state).toBe("open");
  });

  test("a blocker closed as dropped holds its issue on ask and frees it on go", () => {
    app.db.run("UPDATE issue SET state = 'closed', close_reason = 'dropped' WHERE id = ?1", [issue(1).id]);
    try {
      app.db.run("UPDATE repo SET autonomy = 'autonomous', plans_need_nod = 1, decisions_by = 'me' WHERE id = ?1", [repo.id]);
      expect(repoGraph(app.db, repo.id).held.length).toBeGreaterThan(0);
      app.db.run("UPDATE repo SET plans_need_nod = 0, decisions_by = 'decider' WHERE id = ?1", [repo.id]);
      expect(repoGraph(app.db, repo.id).held).toEqual([]);
    } finally {
      app.db.run("UPDATE issue SET state = 'open', close_reason = NULL WHERE id = ?1", [issue(1).id]);
      app.db.run("UPDATE repo SET autonomy = 'off', plans_need_nod = 1, decisions_by = 'me' WHERE id = ?1", [repo.id]);
    }
  });

  test("the API links, lists, refuses a loop with the reason, and serves the map", async () => {
    const url = (n: number) =>
      `${base}/api/v1/repos/alice/engine/issues/${n}/dependencies`;
    const linked = await fetch(url(7), {
      method: "POST",
      headers: as(token),
      body: JSON.stringify({ blockedBy: 5 }),
    });
    expect(linked.status).toBe(201);
    const listed = (await (
      await fetch(url(7), { headers: as(token) })
    ).json()) as {
      blockedBy: { number: number }[];
      blocks: unknown[];
    };
    expect(listed.blockedBy.map((b) => b.number)).toEqual([5]);
    const loop = await fetch(url(1), {
      method: "POST",
      headers: as(token),
      body: JSON.stringify({ blockedBy: 6 }),
    });
    expect(loop.status).toBe(422);
    expect(((await loop.json()) as { error: string }).error).toBe("cycle");
    const missing = await fetch(url(1), {
      method: "POST",
      headers: as(token),
      body: JSON.stringify({ blockedBy: 99 }),
    });
    expect(missing.status).toBe(422);

    const map = (await (
      await fetch(`${base}/api/v1/repos/alice/engine/map`, {
        headers: as(token),
      })
    ).json()) as {
      ready: { number: number }[];
      critical: number[];
      edges: { issue: number; blockedBy: number }[];
    };
    expect(map.ready.map((r) => r.number)).toEqual([1, 2]);
    expect(map.critical).toEqual([1, 3, 5, 6]);
    expect(map.edges).toContainEqual({ issue: 7, blockedBy: 5 });

    const gone = await fetch(`${url(7)}/5`, {
      method: "DELETE",
      headers: as(token),
    });
    expect(gone.status).toBe(204);
    expect(removeDependency(app.db, issue(7).id, issue(5).id)).toBe(false);
  });

  test("a repository with no issues has one empty state on its map, not two", async () => {
    const cookie = (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "alice",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
    const bare = await createRepo(app, alice, {
      name: "bare",
      visibility: "private",
    });
    if (!bare.ok) throw new Error(String(bare.error));
    const map = await (
      await fetch(`${base}/alice/bare/map`, { headers: { cookie } })
    ).text();
    expect(map).toContain("No open issues to map");
    expect(map).not.toContain("Nothing is ready");
  });

  test("a stranger reads nothing and links nothing", async () => {
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    const bob = createToken(app.db, b.value.id, "test", "rw").token;
    const url = `${base}/api/v1/repos/alice/engine/issues/2/dependencies`;
    expect((await fetch(url, { headers: as(bob) })).status).toBe(404);
    expect(
      (
        await fetch(url, {
          method: "POST",
          headers: as(bob),
          body: JSON.stringify({ blockedBy: 1 }),
        })
      ).status,
    ).toBe(404);
  });

  test("the issue page says what it waits for, and the map page draws it", async () => {
    const cookie = (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "alice",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
    const page = await (
      await fetch(`${base}/alice/engine/issues/5`, { headers: { cookie } })
    ).text();
    expect(page).toContain("Waits for 2");
    expect(page).toContain("Holds up 1");
    expect(page).toContain('href="/alice/engine/map"');

    const map = await (
      await fetch(`${base}/alice/engine/map`, { headers: { cookie } })
    ).text();
    expect(map).toContain("Ready now");
    expect(map).not.toContain("Critical path");
    expect(map).toContain('data-state="ready"');
    expect(map).toContain("Extract renderer");
    expect(map).toContain("finishing it frees 4");

    // The form on the page links too, and says so.
    const linked = await fetch(`${base}/alice/engine/issues/7/dependencies`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams({ blockedBy: "#6" }),
      redirect: "manual",
    });
    expect(linked.status).toBe(303);
    expect(
      dependenciesOf(app.db, issue(7).id).blockedBy.map((i) => i.number),
    ).toEqual([6]);
  });
});
