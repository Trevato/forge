/**
 * Closing takes a reason. Done frees what waited; dropped and split hold it,
 * parked with the reason, until a person confirms or relinks; split moves the
 * parent's own blockers to its children. The map says why.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { confirmIssue } from "../src/actions/dependencies.ts";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import {
  addDependency,
  dependenciesOf,
  readyNow,
  removeDependency,
  repoGraph,
} from "../src/core/dependencies.ts";
import { getIssue, type CloseReason, type Issue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { mapJson, marksFor, wordFor } from "../src/web/pages/map.ts";

describe("closing with a reason", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-closing-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, {
      name: "plan",
      visibility: "private",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const make = (title: string): Issue => {
    const opened = openIssue(app, alice, repo, { title });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value;
  };
  const fresh = (i: Issue): Issue => getIssue(app.db, repo.id, i.number)!;
  const close = (
    i: Issue,
    reason?: CloseReason,
    into?: number[],
  ): ReturnType<typeof setIssueState> =>
    setIssueState(app, alice, repo, fresh(i), "closed", {
      ...(reason ? { reason } : {}),
      ...(into ? { into } : {}),
    });
  const readyNumbers = (): number[] =>
    readyNow(repoGraph(app.db, repo.id)).map((r) => r.issue.number);
  const wordOf = (i: Issue): string => {
    const graph = repoGraph(app.db, repo.id);
    const ready = new Set(readyNow(graph).map((r) => r.issue.id));
    const marks = marksFor(app.db, repo.id, graph, []);
    return wordFor(fresh(i), ready, marks);
  };

  test("done, and a close with no reason, free what waited", () => {
    const blocker = make("Blocker");
    const waiter = make("Waiter");
    addDependency(app.db, waiter, blocker, alice.id);
    expect(readyNumbers()).not.toContain(waiter.number);
    expect(close(blocker).ok).toBe(true);
    expect(fresh(blocker).closeReason).toBe("done");
    expect(readyNumbers()).toContain(waiter.number);
    expect(wordOf(waiter)).toBe("ready");
  });

  test("dropped holds dependents parked, with the reason, until confirmed", () => {
    const blocker = make("Replaced plan");
    const waiter = make("Built on it");
    addDependency(app.db, waiter, blocker, alice.id);
    expect(close(blocker, "dropped").ok).toBe(true);
    expect(fresh(blocker).closeReason).toBe("dropped");
    expect(readyNumbers()).not.toContain(waiter.number);
    expect(wordOf(waiter)).toBe("parked");

    const graph = repoGraph(app.db, repo.id);
    const json = mapJson(repo, graph, marksFor(app.db, repo.id, graph, [])) as {
      issues: {
        number: number;
        word: string;
        parkedBecause?: string;
        closeReason?: string;
      }[];
    };
    const card = json.issues.find((i) => i.number === waiter.number)!;
    expect(card.parkedBecause).toBe(`#${blocker.number} was dropped`);
    expect(
      json.issues.find((i) => i.number === blocker.number)!.closeReason,
    ).toBe("dropped");

    const confirmed = confirmIssue(app, alice, repo, waiter, fresh(blocker));
    expect(confirmed.ok).toBe(true);
    expect(readyNumbers()).toContain(waiter.number);
    expect(wordOf(waiter)).toBe("ready");
  });

  test("relinking frees a dependent held by a dropped blocker", () => {
    const blocker = make("Dropped too");
    const waiter = make("Waits on dropped");
    addDependency(app.db, waiter, blocker, alice.id);
    close(blocker, "dropped");
    expect(wordOf(waiter)).toBe("parked");
    removeDependency(app.db, waiter.id, blocker.id);
    expect(readyNumbers()).toContain(waiter.number);
  });

  test("reopening clears the reason and the hold becomes a plain wait", () => {
    const blocker = make("Dropped then back");
    const waiter = make("Waits again");
    addDependency(app.db, waiter, blocker, alice.id);
    close(blocker, "dropped");
    setIssueState(app, alice, repo, fresh(blocker), "open");
    expect(fresh(blocker).closeReason).toBeNull();
    expect(wordOf(waiter)).toBe("blocked");
  });

  test("split moves the parent's blockers to its children and parks its dependents", () => {
    const root = make("Root");
    const parent = make("Too big");
    const dependent = make("After the big one");
    const a = make("Half A");
    const b = make("Half B");
    addDependency(app.db, parent, root, alice.id);
    addDependency(app.db, dependent, parent, alice.id);
    const split = close(parent, "split", [a.number, b.number]);
    expect(split.ok).toBe(true);
    expect(fresh(parent).closeReason).toBe("split");
    expect(dependenciesOf(app.db, parent.id).blockedBy).toHaveLength(0);
    for (const child of [a, b])
      expect(
        dependenciesOf(app.db, child.id).blockedBy.map((i) => i.number),
      ).toEqual([root.number]);
    expect(readyNumbers()).not.toContain(a.number);
    expect(wordOf(dependent)).toBe("parked");
    const graph = repoGraph(app.db, repo.id);
    const why = marksFor(app.db, repo.id, graph, []).why.get(dependent.id);
    expect(why).toBe(`#${parent.number} was split`);
    // Once the root is done the halves are ready; the dependent stays held.
    close(root);
    expect(readyNumbers()).toEqual(
      expect.arrayContaining([a.number, b.number]),
    );
    expect(readyNumbers()).not.toContain(dependent.number);
  });

  test("a reason is only for an issue closing, and a split names real children", () => {
    const one = make("One");
    const other = make("Other");
    const noKids = close(one, "split");
    expect(noKids.ok).toBe(false);
    if (!noKids.ok) expect(noKids.error).toBe("invalid_reason");
    expect(close(one, "split", [one.number]).ok).toBe(false);
    expect(close(one, "split", [9999]).ok).toBe(false);
    expect(close(one, "dropped", [other.number]).ok).toBe(false);
    expect(
      setIssueState(app, alice, repo, fresh(one), "open", { reason: "done" })
        .ok,
    ).toBe(false);
    expect(fresh(one).state).toBe("open");
  });

  test("the API takes a reason and refuses a bad one", async () => {
    const token = createToken(app.db, alice.id, "t", "rw").token;
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    };
    const url = (n: number) =>
      `${servers.url}/api/v1/repos/alice/plan/issues/${n}`;
    const target = make("Via API");
    const kid = make("Its child");
    const bad = await fetch(url(target.number), {
      method: "PATCH",
      headers,
      body: JSON.stringify({ state: "closed", reason: "bored" }),
    });
    expect(bad.status).toBe(422);
    const noKids = await fetch(url(target.number), {
      method: "PATCH",
      headers,
      body: JSON.stringify({ state: "closed", reason: "split", into: [] }),
    });
    expect(noKids.status).toBe(422);
    const ok = await fetch(url(target.number), {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        state: "closed",
        reason: "split",
        into: [kid.number],
      }),
    });
    expect(ok.status).toBe(200);
    expect(fresh(target).closeReason).toBe("split");

    const waiter = make("API waiter");
    addDependency(app.db, waiter, fresh(target), alice.id);
    const deps = await fetch(`${url(waiter.number)}/dependencies`, { headers });
    const body = (await deps.json()) as {
      blockedBy: { closeReason?: string }[];
    };
    expect(body.blockedBy[0]!.closeReason).toBe("split");
    const confirm = await fetch(
      `${url(waiter.number)}/dependencies/${target.number}/confirm`,
      { method: "POST", headers },
    );
    expect(confirm.status).toBe(204);
    expect(wordOf(waiter)).toBe("ready");
  });
});
