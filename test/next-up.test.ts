/**
 * Next up (#8694): the owner's one ranked list. Top, Up/Down and Not now save
 * at once; a gated issue lifts past the Later gate in the one action; the
 * picker takes the highest ranked startable issue, the same pick every time;
 * a row says in a line why it cannot start.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { NEXT_ALREADY_AWAY, NEXT_FULL, placeOf, rankIssue } from "../src/actions/next.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addDependency, readyNow, repoGraph } from "../src/core/dependencies.ts";
import { getIssue, getIssueById } from "../src/core/issues.ts";
import { MAX_RANKED, writeOrder } from "../src/core/rank.ts";
import { nextUp } from "../src/core/next_up.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("Next up", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let repo: Repo;
  let cookie: string;
  const n: Record<string, number> = {};

  const user = async (username: string, first: boolean): Promise<User> => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const signIn = async (username: string): Promise<string> => {
    const res = await fetch(`${base}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  const open = (title: string): number => {
    const o = openIssue(app, alice, repo, { title });
    if (!o.ok) throw new Error(String(o.error));
    return o.value.number;
  };
  const issue = (number: number) => getIssue(app.db, repo.id, number)!;
  const move = (number: number, to: string) => {
    const place = placeOf(to)!;
    return rankIssue(app, alice, repo, number, place);
  };
  const order = () => nextUp(app.db, repo).rows.map((r) => r.issue.number);
  const picked = () => readyNow(repoGraph(app.db, repo.id, { sealed: true })).map((r) => r.issue.number);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-next-up-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = `http://127.0.0.1:${servers.port}`;
    alice = await user("alice", true);
    await user("bob", false);
    const made = await createRepo(app, alice, { name: "plan", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    n.gate = open("Later gate: not now");
    for (const name of ["a", "b", "c", "d", "e"]) n[name] = open(`Work ${name}`);
    n.wait = open("Waits for a");
    n.far = open("Far off");
    addDependency(app.db, issue(n.wait!), issue(n.a!), alice.id);
    addDependency(app.db, issue(n.far!), issue(n.gate!), alice.id);
    cookie = await signIn("alice");
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("with nothing ranked, the list is the ready order, and the gated issue is not now", () => {
    const next = nextUp(app.db, repo);
    expect(next.rows.map((r) => r.issue.number)).toEqual(picked());
    expect(next.rows.map((r) => r.issue.number)).not.toContain(n.far!);
    expect(next.notNow.map((r) => r.issue.number)).toEqual([n.far!]);
    expect(next.notNow[0]!.why).toContain("behind the Later gate");
  });

  test("Top puts an issue first, and the picker takes it", () => {
    expect(move(n.c!, "top").ok).toBe(true);
    expect(order()[0]).toBe(n.c!);
    expect(picked()[0]).toBe(n.c!);
  });

  test("a place under another row ranks down to it; Not now drops it behind the gate", () => {
    expect(move(n.e!, `after:${n.c}`).ok).toBe(true);
    expect(order().slice(0, 2)).toEqual([n.c!, n.e!]);
    expect(move(n.e!, "not-now").ok).toBe(true);
    expect(order()).not.toContain(n.e!);
    expect(nextUp(app.db, repo).notNow.map((r) => r.issue.number)).toContain(n.e!);
    expect(picked()).not.toContain(n.e!);
  });

  test("Top on a gated issue lifts it past the Later gate in that one action", () => {
    expect(move(n.far!, "top").ok).toBe(true);
    expect(order()[0]).toBe(n.far!);
    expect(picked()[0]).toBe(n.far!);
    const waits = app.db
      .query("SELECT 1 FROM issue_dependency WHERE issue_id = ?1 AND blocked_by_id = ?2")
      .all(issue(n.far!).id, issue(n.gate!).id);
    expect(waits).toHaveLength(0);
  });

  test("a ranked issue that is not startable says why in one line, and the picker skips it", () => {
    expect(move(n.wait!, "top").ok).toBe(true);
    const row = nextUp(app.db, repo).rows.find((r) => r.issue.number === n.wait!)!;
    expect(row.why).toBe(`waits for #${n.a}`);
    expect(picked()).not.toContain(n.wait!);
    expect(picked()[0]).toBe(n.far!);
  });

  test("the same state gives the same pick, every time", () => {
    const first = picked();
    for (let i = 0; i < 5; i++) expect(picked()).toEqual(first);
    // A copy of the state in a second graph read agrees: no clock, no randomness.
    expect(readyNow(repoGraph(app.db, repo.id, { sealed: true })).map((r) => r.issue.number)).toEqual(first);
  });

  test("a place that is not in the list changes nothing", () => {
    const before = order();
    const refused = move(n.b!, "after:99999");
    expect(refused.ok).toBe(false);
    expect(order()).toEqual(before);
  });

  test("closing an issue takes it off the ranking", () => {
    const far = issue(n.far!);
    const rank = () => app.db.query("SELECT 1 FROM issue_rank WHERE issue_id = ?1").all(far.id);
    expect(rank()).toHaveLength(1);
    expect(setIssueState(app, alice, repo, far, "closed").ok).toBe(true);
    // The row itself is gone, not only hidden by the open filter.
    expect(rank()).toHaveLength(0);
    expect(order()).not.toContain(n.far!);
  });

  test("each row is a blocker or an enabler, in one line; the tag never orders the picker", () => {
    const rows = nextUp(app.db, repo).rows;
    const wait = rows.find((r) => r.issue.number === n.wait!)!;
    expect(wait.role).toBe("enabler");
    expect(wait.roleWhy).toBe("the owner ranked it");
    // Work a holds up "Waits for a": a blocker.
    const a = rows.find((r) => r.issue.number === n.a!)!;
    expect(a.role).toBe("blocker");
    expect(a.roleWhy).toBe("finishing it frees 1");
    // The unranked rows keep the ready order, blocker or not.
    const unranked = rows.filter((r) => r.place === null).map((r) => r.issue.number);
    expect(unranked).toEqual(picked().filter((x) => unranked.includes(x)));
  });

  test("Not now on an issue already behind the gate says so", () => {
    const refused = move(n.e!, "not-now");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toBe(NEXT_ALREADY_AWAY);
  });

  test("the page lists the top ten with a Top button for a writer, and none for a reader", async () => {
    const writer = await (await fetch(`${base}/alice/plan/next`, { headers: { cookie } })).text();
    expect(writer).toContain("Next up");
    expect(writer).toContain(`value="${n.b}"`);
    expect(writer).toContain("Not now");
    // The key is shown beside each action, and the rows take j/k.
    for (const key of ["t", "u", "d", "n"]) expect(writer).toContain(`data-key="${key}"`);
    expect(writer).toContain("<kbd>t</kbd>");
    expect(writer).toContain("data-nav");
    expect(writer).toContain("Blocker");
    expect(writer).toContain("Enabler");
    const reader = await (await fetch(`${base}/alice/plan/next`, { headers: { cookie: await signIn("bob") } })).text();
    expect(reader).toContain(`Work b`);
    expect(reader).not.toContain('name="to"');
  });

  test("posting the form moves the issue and answers with the flash; another origin is refused", async () => {
    const post = (headers: Record<string, string>, to: string) =>
      fetch(`${base}/alice/plan/next`, {
        method: "POST",
        headers: { cookie, origin: base, ...headers },
        body: new URLSearchParams({ number: String(n.d), to }),
        redirect: "manual",
      });
    expect((await post({ origin: "https://evil.example" }, "top")).status).toBe(403);
    expect(order()[0]).not.toBe(n.d!);
    expect((await post({}, "top")).status).toBe(303);
    expect(order()[0]).toBe(n.d!);
    const bad = await post({ accept: "application/json" }, "sideways");
    expect(bad.status).toBe(422);
  });

  test("a reader's post is refused and changes nothing", async () => {
    const bob = await signIn("bob");
    const before = order();
    const res = await fetch(`${base}/alice/plan/next`, {
      method: "POST",
      headers: { cookie: bob, origin: base, accept: "application/json" },
      body: new URLSearchParams({ number: String(n.b), to: "top" }),
    });
    expect(res.status).toBe(422);
    expect(order()).toEqual(before);
  });

  test("beyond ten rows the rest is one line that opens it", async () => {
    for (let i = 0; i < 12; i++) open(`Extra ${i}`);
    const page = await (await fetch(`${base}/alice/plan/next`, { headers: { cookie } })).text();
    expect(page).toContain("next?all=1");
    expect(page).toContain("open the rest");
    const rows = (html: string) => (html.match(/data-number="/g) ?? []).length;
    expect(rows(page)).toBe(10);
    const full = await (await fetch(`${base}/alice/plan/next?all=1`, { headers: { cookie } })).text();
    expect(rows(full)).toBeGreaterThan(10);
    expect(full).toContain("Not now");
  });
});

describe("the ranked list is bounded", () => {
  test("a move that would rank more than the cap is refused and changes nothing", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-next-cap-"));
    const app = createApp({ dataDir, port: 0 });
    try {
      const made = await createUser(app.db, {
        origin: "seed", trusted: true, username: "carol", email: "carol@forge.local",
        password: "a-good-passphrase", adminIfFirst: true,
      });
      if (!made.ok) throw new Error(made.error);
      const repo = await createRepo(app, made.value, { name: "big", visibility: "public" });
      if (!repo.ok) throw new Error(String(repo.error));
      const ids: string[] = [];
      for (let i = 0; i < MAX_RANKED + 1; i++) {
        const o = openIssue(app, made.value, repo.value, { title: `Item ${i}` });
        if (!o.ok) throw new Error(String(o.error));
        ids.push(o.value.id);
      }
      writeOrder(app.db, repo.value, ids.slice(0, MAX_RANKED), made.value.id);
      const last = getIssueById(app.db, ids[MAX_RANKED]!)!;
      const refused = rankIssue(app, made.value, repo.value, last.number, { to: "top" });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.message).toBe(NEXT_FULL);
      expect(app.db.query("SELECT COUNT(*) AS n FROM issue_rank").get()).toEqual({ n: MAX_RANKED });
    } finally {
      app.db.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("the picker's order", () => {
  test("at the small cap a ranked small issue survives and keeps its place; an unranked one is left out", async () => {
    const { slotOrder } = await import("../src/crew/small_share.ts");
    const items = [
      { id: "a", small: false },
      { id: "ranked-small", ranked: true, small: true },
      { id: "b", small: true },
    ];
    const picks = slotOrder(items, (t) => t, 1, 1).map((t) => t.id);
    expect(picks).toEqual(["a", "ranked-small"]);
  });
});

describe("the picker follows the page (#8826)", () => {
  test("with two ranked and three unranked issues, five ticks start the page's rows top to bottom", async () => {
    const { inSlotOrder } = await import("../src/crew/autonomy.ts");
    const dir = await mkdtemp(join(tmpdir(), "forge-next-order-"));
    const app = createApp({ dataDir: dir, port: 0 });
    try {
      const made = await createUser(app.db, {
        origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
        password: "a-good-passphrase", adminIfFirst: true,
      });
      if (!made.ok) throw new Error(made.error);
      const alice = made.value;
      const r = await createRepo(app, alice, { name: "plan", visibility: "public" });
      if (!r.ok) throw new Error(String(r.error));
      const repo = r.value;
      const num: number[] = [];
      for (const t of ["one", "two", "three", "four", "five"]) {
        const o = openIssue(app, alice, repo, { title: `Work ${t}` });
        if (!o.ok) throw new Error(String(o.error));
        num.push(o.value.number);
      }
      // Rank the fifth, then the third above it; the rest stay unranked.
      expect(rankIssue(app, alice, repo, num[4]!, placeOf("top")!).ok).toBe(true);
      expect(rankIssue(app, alice, repo, num[2]!, placeOf("top")!).ok).toBe(true);
      const page = nextUp(app.db, repo).rows.map((x) => x.issue.number);
      expect(page.slice(0, 2)).toEqual([num[2]!, num[4]!]);
      const started: number[] = [];
      for (let tick = 0; tick < 5; tick++) {
        const ready = readyNow(repoGraph(app.db, repo.id, { sealed: true })).filter(
          (x) => !started.includes(x.issue.number),
        );
        const next = inSlotOrder(app, repo, ready, [], 5)[0]!;
        started.push(next.issue.number);
      }
      expect(started).toEqual(page);
    } finally {
      app.db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
