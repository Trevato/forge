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
import { assignIssue, openIssue, setIssueState } from "../src/actions/issues.ts";
import { NEXT_ALREADY_AWAY, NEXT_FULL, placeOf, rankIssue } from "../src/actions/next.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addDependency, readyNow, repoGraph } from "../src/core/dependencies.ts";
import { getIssue, getIssueById } from "../src/core/issues.ts";
import { MAX_RANKED, writeOrder } from "../src/core/rank.ts";
import { nextUp } from "../src/core/next_up.ts";
import type { Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
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
    // Every open issue is listed (#11618): the one that waits sits last, after what can start.
    expect(next.rows.map((r) => r.issue.number)).toEqual([...picked(), n.wait!]);
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

  test("beyond ten rows the rest folds under After with its count, in the API's order", async () => {
    for (let i = 0; i < 12; i++) open(`Extra ${i}`);
    const page = await (await fetch(`${base}/alice/plan/next`, { headers: { cookie } })).text();
    const rows = [...page.slice(0, page.indexOf("<h2>Later")).matchAll(/data-number="(\d+)"/g)].map((m) => Number(m[1]));
    const queue = (await (await fetch(`${base}/api/v1/repos/alice/plan/queue`, { headers: { cookie } })).json()) as { queue: { number: number }[] };
    expect(rows.length).toBeGreaterThan(10);
    expect(rows).toEqual(queue.queue.map((q) => q.number).slice(0, rows.length));
    // Positions run 1.. down the page, across the folds.
    const leads = [...page.slice(0, page.indexOf("<h2>Later")).matchAll(/<span class="row-lead">(\d+)<\/span>/g)].map((m) => Number(m[1]));
    expect(leads).toEqual(rows.map((_, i) => i + 1));
    const folds = page.replace(/\s+/g, " ");
    expect(folds).toMatch(/<details class="mt" open><summary><h2>Up next · 10<\/h2>/);
    expect(folds).toContain(`<h2>After · ${rows.length - 10}</h2>`);
    expect(folds).toContain("<h2>Later · ");
    expect(page).not.toContain("all=1");
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
        const next = inSlotOrder(app, repo, ready)[0]!;
        started.push(next.issue.number);
      }
      expect(started).toEqual(page);
    } finally {
      app.db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Next up page shape (#9764)", () => {
  test("renders rows straight under headings: one-sentence head, no card, no badge, plain-text role, forms still POST", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-next-shape-"));
    const app = createApp({ dataDir: dir, port: 0 });
    const servers = await serve(app);
    try {
      const mk = async (username: string, first: boolean) => {
        const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
        if (!made.ok) throw new Error(made.error);
        return made.value;
      };
      const alice = await mk("alice", true);
      const bob = await mk("bob", false);
      const made = await createRepo(app, alice, { name: "shape", visibility: "public" });
      if (!made.ok) throw new Error(String(made.error));
      const repo = made.value;
      const open = (title: string) => {
        const o = openIssue(app, alice, repo, { title });
        if (!o.ok) throw new Error(String(o.error));
        return o.value;
      };
      const first = open("First job");
      const second = open("Second job");
      const waits = open("Waits on first");
      addDependency(app.db, waits, first, alice.id);
      expect(rankIssue(app, alice, repo, waits.number, placeOf("top")!).ok).toBe(true);
      const given = assignIssue(app, alice, repo, second, bob);
      if (!given.ok) throw new Error(String(given.error));
      const cookie = `forge_session=${createSession(app.db, alice.id).token}`;
      const res = await fetch(`${servers.url}/alice/shape/next`, { headers: { cookie } });
      expect(res.status).toBe(200);
      const body = (await res.text()).replace(/\s+/g, " ");

      expect(body).toContain("<h2>Up next · 3</h2>");
      // The list is rows straight under its heading: no card, bare or boxed.
      expect(body).toMatch(/<h2>Up next · 3<\/h2><\/summary> ?<ul class="list setting-list" id="next-list"/);
      const main = body.slice(body.indexOf("<div data-next>"));
      expect(main).not.toMatch(/class="card\b/);
      // One sentence in the head, from pageHead; the key hint sits after the list, not in the lead.
      expect(main).toMatch(/<div class="page-head"> ?<h1>Next up<\/h1> ?<span class="page-head-sub muted small">The crew builds strictly from the top\.<\/span>/);
      expect(main.indexOf("j and k move between rows")).toBeGreaterThan(main.indexOf("</ul>"));
      expect(body).not.toMatch(/class="[^"]*\bbadge\b/);
      expect(body).not.toMatch(/<(?:span|em|strong)[^>]*badge/);

      const rows = body.match(/<li[^>]*data-number="\d+"[\s\S]*?<\/li>/g) ?? [];
      expect(rows.length).toBe(3);
      const rowOf = (n: number) => rows.find((r) => r.includes(`data-number="${n}"`))!;
      for (const [issue, role] of [[first, "Blocker"], [second, "Enabler"]] as const) {
        const meta = /<span class="row-meta">([\s\S]*?)<\/span>/.exec(rowOf(issue.number))![1]!;
        expect(meta).toContain(`${role} · #${issue.number} · `);
        expect(meta.split("<span")[0]).not.toContain("<");
      }
      expect(rowOf(second.number)).toContain("held · bob");
      expect(rowOf(waits.number)).toContain(`waiting on #${first.number} · next`);

      // Every action is still a form that posts.
      for (const label of ["Top", "Up", "Down", "Not now"]) {
        expect(body).toMatch(new RegExp(`<form method="post" action="[^"]*/next"[^>]*>(?:(?!</form>).)*${label} <kbd>`));
      }
      expect(body).not.toMatch(/<form(?![^>]*method="(?:post|get)")[^>]*action="[^"]*\/next"/); // the filter is the one GET form

      // Not now (?all=1) is rows under its own heading too, and Top is the one move it offers.
      const gate = open("Later gate: not now");
      const far = open("Far off");
      addDependency(app.db, far, gate, alice.id);
      const all = (await (await fetch(`${servers.url}/alice/shape/next`, { headers: { cookie } })).text()).replace(/\s+/g, " ");
      const notNow = all.slice(all.indexOf("<h2>Later · "));
      expect(notNow).toMatch(/^<h2>Later · 1<\/h2><\/summary> ?<ul class="list setting-list">/);
      expect(notNow).not.toMatch(/class="card\b/);
      expect(notNow).not.toContain("Behind the Later gate. Top lifts");
      const farRow = /<li[^>]*data-number="(\d+)"[\s\S]*?<\/li>/.exec(notNow)!;
      expect(farRow[1]).toBe(String(far.number));
      expect(farRow[0]).toContain("behind the Later gate");
      expect(farRow[0]).toMatch(/<form method="post" action="[^"]*\/next"[^>]*>(?:(?!<\/form>).)*value="top"/);
      expect(farRow[0]).not.toMatch(/\bUp <kbd>/);
      expect(farRow[0]).not.toMatch(/\bDown <kbd>/);
    } finally {
      await servers.stop();
      app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
