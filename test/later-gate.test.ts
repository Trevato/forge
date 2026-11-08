/**
 * The Later gate in plain sight (#8700): home says what it holds, who set it
 * and when; a held issue says so at its top with Lift; the `Later` label and
 * the gate are one thing; and one pass over the lot proposes what to close.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { linkIssue, unlinkIssue } from "../src/actions/dependencies.ts";
import { applyGateReview, reviewGate } from "../src/actions/gate_review.ts";
import { liftHold } from "../src/actions/gate.ts";
import { addComment, openIssue, setIssueLabels, setIssueState } from "../src/actions/issues.ts";
import { createLabel, createRepo } from "../src/actions/repos.ts";
import { closedByReview, gateHold, gateHolding, reviewedClosed } from "../src/core/gate_hold.ts";
import { heldRows } from "../src/tui/screens/held.ts";
import { startsTicked, tally, triage } from "../src/core/gate_triage.ts";
import { pillarsOf } from "../src/core/pillars.ts";
import { createToken } from "../src/core/tokens.ts";
import { getIssueById, labelsFor, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("the Later gate in plain sight", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let cookie = "";
  let gate: Issue;

  const fresh = () => getRepoById(app.db, repo.id)!;
  const current = (i: Issue) => getIssueById(app.db, i.id)!;
  const open = (title: string): Issue => {
    const made = openIssue(app, alice, fresh(), { title });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };
  const names = (i: Issue) => labelsFor(app.db, i.id).map((l) => l.name);
  const holds = (i: Issue) => gateHolding(app.db, fresh(), current(i)) !== undefined;
  const labels = (i: Issue, to: string[]) => {
    const set = setIssueLabels(app, alice, fresh(), current(i), to);
    if (!set.ok) throw new Error(String(set.error));
  };
  const get = async (path: string) =>
    (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();
  const post = (path: string, body: Record<string, string> = {}) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      headers: { cookie, origin: servers.url },
      body: new URLSearchParams(body),
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-later-gate-"));
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
    alice = getUserByName(app.db, "alice")!;
    const created = await createRepo(app, alice, { name: "engine", visibility: "public" });
    if (!created.ok) throw new Error(String(created.error));
    repo = created.value;
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
      redirect: "manual",
    });
    cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    open("P0 Trust: be trusted");
    gate = open("Later gate: nothing behind this starts until the owner opens it");
  });
  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a gate that holds nothing says nothing on home", async () => {
    expect(gateHold(app.db, fresh())).toBeUndefined();
    expect(await get("/")).not.toContain("held-line");
  });

  test("a new gate shows up on home: how many, who set it", async () => {
    const a = open("Later thing one");
    const b = open("Later thing two");
    expect(linkIssue(app, alice, fresh(), current(a), gate).ok).toBe(true);
    expect(linkIssue(app, alice, fresh(), current(b), gate).ok).toBe(true);
    const hold = gateHold(app.db, fresh())!;
    expect(hold.held).toBe(2);
    expect(hold.by).toBe("alice");
    const home = await get("/");
    expect(home).toContain('id="held-line"');
    expect(home).toContain("2 issues are held");
    expect(home).toContain("set by alice");
    expect(home).toContain("/alice/engine/held");
  });

  test("a held issue says so at its top with Lift, and Lift lifts it", async () => {
    const i = open("Held by the gate");
    linkIssue(app, alice, fresh(), current(i), gate);
    expect(names(i)).toContain("Later");
    const page = await get(`/alice/engine/issues/${i.number}`);
    expect(page).toContain('id="held"');
    expect(page).toContain(`/alice/engine/issues/${i.number}/lift`);
    const res = await post(`/alice/engine/issues/${i.number}/lift`);
    expect(res.status).toBe(303);
    expect(holds(i)).toBe(false);
    expect(names(i)).not.toContain("Later");
    expect(await get(`/alice/engine/issues/${i.number}`)).not.toContain('id="held"');
  });

  test("lifting what is not held is refused", () => {
    const i = open("Free");
    const lifted = liftHold(app, alice, fresh(), current(i));
    expect(lifted.ok).toBe(false);
  });

  test("removing the Later label lifts the hold, and adding it holds", () => {
    const i = open("Label and gate are one");
    linkIssue(app, alice, fresh(), current(i), gate);
    expect(holds(i)).toBe(true);
    labels(i, []);
    expect(holds(i)).toBe(false);
    expect(names(i)).not.toContain("Later");
    labels(i, ["Later"]);
    expect(holds(i)).toBe(true);
    expect(names(i)).toContain("Later");
  });

  test("an unrelated label change leaves the hold alone", () => {
    const i = open("Other labels");
    linkIssue(app, alice, fresh(), current(i), gate);
    const made = createLabel(app, alice, fresh(), "ui", "336699");
    if (!made.ok) throw new Error(String(made.error));
    labels(i, ["Later", "ui"]);
    expect(holds(i)).toBe(true);
  });

  test("triage makes every held issue a candidate; only one found done starts ticked", () => {
    const themes = triage(
      [
        { number: 1, title: "Search the archive", waiting: 0 },
        { number: 2, title: "Search archive export", waiting: 2 },
        { number: 3, title: "Search archive filters", waiting: 0 },
        { number: 4, title: "Paint the footer blue", waiting: 0 },
      ],
      new Set([4]),
    );
    const rows = themes.flatMap((t) => t.items);
    expect(rows.length).toBe(4);
    expect(rows.find((r) => r.number === 1)!.verdict).toMatchObject({ kind: "close", reason: "dropped" });
    expect(rows.find((r) => r.number === 4)!.verdict).toMatchObject({ kind: "close", reason: "done" });
    expect(rows.filter(startsTicked).map((r) => r.number)).toEqual([4]);
    expect(rows.find((r) => r.number === 2)!.waiting).toBe(2);
    expect(themes[0]!.items.length).toBe(3);
    expect(triage([]).length).toBe(0);
  });

  test("a pillar's issues group under it first, each group tallied by verdict", () => {
    const themes = triage(
      [
        { number: 1, title: "Search the archive", waiting: 0 },
        { number: 2, title: "Search archive export", waiting: 0 },
        { number: 3, title: "Search archive filters", waiting: 0 },
        { number: 4, title: "Search archive sorting", waiting: 0 },
      ],
      new Set(),
      [],
      new Map([[2, "P0 Trust"]]),
    );
    expect(themes[0]).toMatchObject({ name: "P0 Trust", pillar: true });
    expect(tally(themes[0]!.items)).toEqual({ close: 0, keep: 1, merge: 0 });
    expect(themes[1]!.name).toBe("search");
    expect(tally(themes[1]!.items)).toEqual({ close: 3, keep: 0, merge: 0 });
  });

  test("triage proposes merge for a duplicate pair and keep for what a bet names", () => {
    const themes = triage(
      [
        { number: 10, title: "Export the archive as CSV", body: "Let people download rows.", waiting: 0 },
        { number: 11, title: "Export archive as CSV file", body: "Download rows please.", waiting: 0 },
        { number: 12, title: "Dark mode toggle", body: "", waiting: 0 },
        { number: 13, title: "Paint the footer blue", body: "", waiting: 0 },
      ],
      new Set(),
      [{ number: 90, label: "Bet", title: "Bet: theming", body: "Ships #12 this cycle." }],
    );
    const v = new Map(themes.flatMap((t) => t.items).map((r) => [r.number, r.verdict]));
    expect(v.get(11)).toMatchObject({ kind: "merge", into: 10 });
    expect(v.get(10)).toMatchObject({ kind: "close", reason: "dropped" });
    expect(v.get(12)).toMatchObject({ kind: "keep", anchor: 90 });
    expect(v.get(12)!.why).toContain("Bet #90");
    expect(v.get(13)).toMatchObject({ kind: "close", reason: "dropped" });
  });

  test("a merge appends the duplicate's words, points at the survivor, and a changed gate refuses", () => {
    const a = openIssue(app, alice, fresh(), { title: "Frobnicate the widget pipeline", body: "Original words about frobnicating." });
    const b = openIssue(app, alice, fresh(), { title: "Frobnicate widget pipeline", body: "Extra words nobody may lose." });
    if (!a.ok || !b.ok) throw new Error("open");
    for (const i of [a.value, b.value]) expect(linkIssue(app, alice, fresh(), current(i), gate).ok).toBe(true);
    const read = reviewGate(app, fresh())!;
    expect(read.changes.find((c) => c.number === b.value.number)!.verdict).toMatchObject({ kind: "merge", into: a.value.number });
    expect(read.ticked).toContain(b.value.number);
    // The gate changes after reading: refused, nothing merged.
    const late = held("Arrived after the read");
    expect(applyGateReview(app, alice, fresh(), [b.value.number], read.digest)).toEqual({ ok: false, error: "stale" });
    expect(current(b.value).state).toBe("open");
    expect(current(late).state).toBe("open");
    const again = reviewGate(app, fresh())!;
    expect(applyGateReview(app, alice, fresh(), [b.value.number], again.digest)).toEqual({ ok: true, value: 1 });
    const survivor = current(a.value);
    expect(survivor.state).toBe("open");
    expect(survivor.body).toContain("Original words about frobnicating.");
    expect(survivor.body).toContain("Extra words nobody may lose.");
    expect(survivor.body).toContain(`Merged from #${b.value.number}`);
    expect(current(b.value).state).toBe("closed");
    expect(app.db.query("SELECT 1 FROM comment WHERE issue_id = ?1 AND body LIKE ?2").get(b.value.id, `Gate review: merged into #${a.value.number}%`)).not.toBeNull();
  });

  test("the held page reads each group as one tallied line, its issues inside the disclosure", async () => {
    const made = ["Zanzibar ledger reconcile", "Zanzibar harbour tolls", "Zanzibar customs sweep"].map(held);
    const page = await get("/alice/engine/held");
    const group = page.match(/<details[^>]*>\s*<summary[^>]*>\s*zanzibar[\s\S]*?<\/details>/)?.[0];
    expect(group).toBeDefined();
    const summary = group!.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)![1]!;
    expect(summary).toContain("3 close");
    expect(summary).not.toMatch(/keep|merge|\b0 /);
    const inside = group!.slice(group!.indexOf("</summary>"));
    for (const t of ["Zanzibar ledger reconcile", "Zanzibar harbour tolls", "Zanzibar customs sweep"])
      expect(inside).toContain(t);
    // The terminal reads the same tally.
    const lines = heldRows(
      (await import("../src/tui/screens/held.ts")).readHeld({ app, db: app.db } as never, fresh())!.lines,
      new Set(),
    );
    expect(lines.some((l) => JSON.stringify(l.meta).includes("zanzibar · 3 close"))).toBe(true);
    for (const i of made) setIssueState(app, alice, fresh(), current(i), "closed");
  });

  test("a merge is skipped when its survivor closes in the same apply", () => {
    const a = openIssue(app, alice, fresh(), { title: "Reticulate the spline index", body: "Survivor words." });
    const b = openIssue(app, alice, fresh(), { title: "Reticulate spline index", body: "Duplicate words." });
    if (!a.ok || !b.ok) throw new Error("open");
    for (const i of [a.value, b.value]) expect(linkIssue(app, alice, fresh(), current(i), gate).ok).toBe(true);
    const read = reviewGate(app, fresh())!;
    expect(applyGateReview(app, alice, fresh(), [a.value.number, b.value.number], read.digest)).toEqual({ ok: true, value: 1 });
    expect(current(a.value).state).toBe("closed");
    expect(current(a.value).body).not.toContain("Duplicate words.");
    expect(current(b.value).state).toBe("open");
  });

  test("the terminal draws a keep row with no tick", () => {
    const line = { number: 5, title: "Kept", theme: "t", why: "joins Bet #1", waiting: 0, closed: false, keep: true };
    const rows = heldRows([line, { ...line, number: 6, keep: false }], new Set([5, 6]));
    expect(rows[0]!.title).toStartWith("[-]");
    expect(rows[1]!.title).toStartWith("[x]");
  });

  test("the held page at rest is bounded: counts and Apply on one bar, collapsed groups, extra themes folded, help folded", async () => {
    const animals = ["Quokka", "Wombat", "Dingo", "Emu", "Galah", "Numbat", "Thylacine", "Bilby"];
    const tails = ["alpha", "bravo", "charlie"];
    for (const w of animals) for (const t of tails) held(`${w} ${t}${w.toLowerCase()}`);
    const page = await get("/alice/engine/held");
    expect(page.indexOf("to close")).toBeLessThan(page.indexOf("Apply the ticked"));
    expect(page.indexOf("Apply the ticked")).toBeLessThan(page.indexOf("Quokka alpha"));
    expect(page).toMatch(/<summary[^>]*>\s*How to read this[\s\S]*?Nothing changes until you approve/);
    expect(page).toMatch(/<summary[^>]*>\s*\d+ more themes/);
    const details = page.match(/<details[^>]*>/g)!;
    expect(details.length).toBeGreaterThan(6);
    for (const d of details) expect(d).not.toMatch(/\bopen\b/);
  });

  test("one approval closes what is ticked, it stays findable, and one tap revives it", async () => {
    const a = open("Idea nobody chose");
    const b = open("Idea to keep behind the gate");
    for (const i of [a, b]) linkIssue(app, alice, fresh(), current(i), gate);
    const review = reviewGate(app, fresh())!;
    expect(review.changes.map((c) => c.number)).toContain(a.number);
    expect(await get("/alice/engine/held")).toContain("Apply the ticked");
    // A proposal that is not the one shown is refused whole.
    expect(applyGateReview(app, alice, fresh(), [999999], review.digest)).toEqual({ ok: false, error: "stale" });
    expect(current(a).state).toBe("open");
    const res = await post("/alice/engine/held/apply", { n: String(a.number), digest: review.digest });
    expect(res.status).toBe(303);
    expect(current(a).state).toBe("closed");
    expect(current(b).state).toBe("open");
    expect(holds(b)).toBe(true);
    // Findable: on the held page and with a Revive at the issue's top.
    expect(await get("/alice/engine/held")).toContain(`/alice/engine/issues/${a.number}/lift`);
    const closedPage = await get(`/alice/engine/issues/${a.number}`);
    expect(closedPage).toContain("Revive");
    const back = await post(`/alice/engine/issues/${a.number}/lift`);
    expect(back.status).toBe(303);
    expect(current(a).state).toBe("open");
    expect(holds(a)).toBe(false);
    expect(names(a)).not.toContain("Later");
  });

  test("an agent reads the proposal and never applies it", async () => {
    const bot = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "botty",
      email: "botty@forge.local",
      password: "a-good-passphrase",
    });
    expect(bot.ok).toBe(true);
    const agent = { ...getUserByName(app.db, "botty")!, kind: "agent" as const };
    expect(applyGateReview(app, agent, fresh(), [], reviewGate(app, fresh())!.digest)).toEqual({ ok: false, error: "forbidden" });
  });

  // ---- the review's safety, its marker, and who may do what ----

  const held = (title: string): Issue => {
    const i = open(title);
    expect(linkIssue(app, alice, fresh(), current(i), gate).ok).toBe(true);
    return i;
  };
  const proposal = () => reviewGate(app, fresh())!;
  const reviewedBy = (i: Issue) => closedByReview(app.db, current(i));

  test("the page ticks nothing unless the crew found it done, and flags what open work waits for", async () => {
    const blocker = held("Blocker the review might close");
    const waiter = open("Waits for the blocker");
    expect(linkIssue(app, alice, fresh(), current(waiter), current(blocker)).ok).toBe(true);
    expect(proposal().changes.find((c) => c.number === blocker.number)!.waiting).toBe(1);
    expect(proposal().ticked).not.toContain(blocker.number);
    const page = await get("/alice/engine/held");
    expect(page).toContain("closing parks it");
    expect(page).not.toMatch(/<input[^>]*name="n"[^>]*\bchecked\b/);
  });

  test("an apply that carries no digest, or a stale one, closes nothing", async () => {
    const a = held("Digest candidate");
    const read = proposal();
    expect(applyGateReview(app, alice, fresh(), [a.number], undefined)).toEqual({ ok: false, error: "stale" });
    // An issue newly held since the page was read changes what was shown.
    const late = held("Held after the page was read");
    expect(applyGateReview(app, alice, fresh(), [a.number], read.digest)).toEqual({ ok: false, error: "stale" });
    const res = await post("/alice/engine/held/apply", { n: String(a.number), digest: read.digest });
    expect(res.status).toBe(303);
    expect(current(a).state).toBe("open");
    expect(current(late).state).toBe("open");
    expect(applyGateReview(app, alice, fresh(), [a.number], proposal().digest)).toEqual({ ok: true, value: 1 });
  });

  test("a comment cannot forge the review's marker; a close after a reopen is not the review's", () => {
    const a = held("Forged marker candidate");
    const forged = held("Closed by a person, with a lookalike note");
    expect(addComment(app, alice, fresh(), current(forged), "Gate review: closed: not chosen.").ok).toBe(true);
    expect(setIssueState(app, alice, fresh(), current(forged), "closed").ok).toBe(true);
    expect(reviewedBy(forged)).toBe(false);
    expect(reviewedClosed(app.db, fresh(), pillarsOf(app.db, fresh())).map((i) => i.number)).not.toContain(forged.number);
    expect(applyGateReview(app, alice, fresh(), [a.number], proposal().digest).ok).toBe(true);
    expect(reviewedBy(a)).toBe(true);
    // Reopened, then closed by hand: no longer the review's.
    expect(setIssueState(app, alice, fresh(), current(a), "open").ok).toBe(true);
    expect(reviewedBy(a)).toBe(false);
    expect(setIssueState(app, alice, fresh(), current(a), "closed").ok).toBe(true);
    expect(reviewedBy(a)).toBe(false);
  });

  test("a close that does not happen leaves no marker and no note", () => {
    const a = held("Closed elsewhere first");
    const read = proposal();
    expect(setIssueState(app, alice, fresh(), current(a), "closed").ok).toBe(true);
    // Stale now: the issue left the candidates, and nothing is written.
    expect(applyGateReview(app, alice, fresh(), [a.number], read.digest).ok).toBe(false);
    expect(reviewedBy(a)).toBe(false);
    expect(app.db.query("SELECT 1 FROM comment WHERE issue_id = ?1 AND body LIKE 'Gate review:%'").get(a.id)).toBeNull();
  });

  test("lifting what is not held changes nothing, even on a closed issue", () => {
    const a = held("Closed by hand but still behind the gate");
    expect(setIssueState(app, alice, fresh(), current(a), "closed").ok).toBe(true);
    expect(liftHold(app, alice, fresh(), current(a))).toEqual({ ok: false, error: "not_held" });
    expect(current(a).state).toBe("closed");
    expect(holds(a)).toBe(false);
    // Reviewed-closed, then let out of the gate by another road: nothing to lift, and it stays closed.
    const b = held("Reviewed then unlinked");
    expect(applyGateReview(app, alice, fresh(), [b.number], proposal().digest).ok).toBe(true);
    expect(unlinkIssue(app, alice, fresh(), current(b), gate).ok).toBe(true);
    expect(liftHold(app, alice, fresh(), current(b))).toEqual({ ok: false, error: "not_held" });
    expect(current(b).state).toBe("closed");
  });

  describe("who may lift, revive and apply", () => {
    let bobCookie = "";
    let bobToken = "";
    let aliceToken = "";
    const as = (c: string, path: string, body: Record<string, string> = {}) =>
      fetch(`${servers.url}${path}`, {
        method: "POST",
        headers: { ...(c === "" ? {} : { cookie: c }), origin: servers.url },
        body: new URLSearchParams(body),
        redirect: "manual",
      });
    const mcp = async (token: string, name: string, args: unknown) => {
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      const body = (await res.json()) as any;
      const text: string = body.result.content[0].text;
      return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
    };

    beforeAll(async () => {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: "bob",
        email: "bob@forge.local",
        password: "a-good-passphrase",
      });
      if (!made.ok) throw new Error(made.error);
      const bob = getUserByName(app.db, "bob")!;
      const signin = await fetch(`${servers.url}/signin`, {
        method: "POST",
        headers: { origin: servers.url },
        body: new URLSearchParams({ username: "bob", password: "a-good-passphrase" }),
        redirect: "manual",
      });
      bobCookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
      bobToken = createToken(app.db, bob.id, "rw", "rw").token;
      aliceToken = createToken(app.db, alice.id, "rw", "rw").token;
    });

    test("a guest and a reader cannot lift or apply on the page; the work stays held", async () => {
      const a = held("Reader cannot lift this");
      const read = proposal();
      for (const c of ["", bobCookie]) {
        await as(c, `/alice/engine/issues/${a.number}/lift`);
        expect(holds(a)).toBe(true);
        await as(c, "/alice/engine/held/apply", { n: String(a.number), digest: read.digest });
        expect(current(a).state).toBe("open");
      }
      expect(applyGateReview(app, getUserByName(app.db, "bob")!, fresh(), [a.number], read.digest)).toEqual({
        ok: false,
        error: "forbidden",
      });
    });

    test("a reader cannot revive on the page, and sees no Revive form", async () => {
      const a = held("Reader cannot revive this");
      expect(applyGateReview(app, alice, fresh(), [a.number], proposal().digest).ok).toBe(true);
      await as("", `/alice/engine/issues/${a.number}/lift`);
      await as(bobCookie, `/alice/engine/issues/${a.number}/lift`);
      expect(current(a).state).toBe("closed");
      const page = await (await fetch(`${servers.url}/alice/engine/issues/${a.number}`, { headers: { cookie: bobCookie } })).text();
      expect(page).not.toContain(`/issues/${a.number}/lift`);
    });

    test("the MCP lift and held tools hold the same line", async () => {
      const a = held("Lifted over MCP");
      const read = await mcp(aliceToken, "held", { app: "alice/engine" });
      expect(read.value.digest).toBe(proposal().digest);
      expect(read.value.themes.length).toBeGreaterThan(0);
      expect((await mcp(bobToken, "lift", { app: "alice/engine", issue: a.number })).error).toBeDefined();
      expect(holds(a)).toBe(true);
      expect((await mcp(bobToken, "held", { app: "alice/engine", apply: [a.number], digest: read.value.digest })).error).toContain("forbidden");
      expect(current(a).state).toBe("open");
      // A writer's apply needs the digest it read.
      expect((await mcp(aliceToken, "held", { app: "alice/engine", apply: [a.number] })).error).toBeDefined();
      expect(current(a).state).toBe("open");
      const lifted = await mcp(aliceToken, "lift", { app: "alice/engine", issue: a.number });
      expect(lifted.value.says).toContain("lifted");
      expect(holds(a)).toBe(false);
      expect((await mcp(aliceToken, "lift", { app: "alice/engine", issue: a.number })).error).toContain("not_held");
    });

    test("a private repository's held page is not found by a guest or a stranger", async () => {
      const made = await createRepo(app, alice, { name: "vault", visibility: "private" });
      if (!made.ok) throw new Error(String(made.error));
      const priv = made.value;
      const mk = (title: string) => {
        const o = openIssue(app, alice, priv, { title });
        if (!o.ok) throw new Error(String(o.error));
        return o.value;
      };
      mk("P0 Trust: be trusted");
      const g = mk("Later gate: nothing behind this starts until the owner opens it");
      const h = mk("Secret held idea");
      expect(linkIssue(app, alice, priv, h, g).ok).toBe(true);
      expect((await fetch(`${servers.url}/alice/vault/held`)).status).toBe(404);
      const stranger = await fetch(`${servers.url}/alice/vault/held`, { headers: { cookie: bobCookie } });
      expect(stranger.status).toBe(404);
      expect(await stranger.text()).not.toContain("Secret held idea");
      expect(await get("/alice/vault/held")).toContain("Secret held idea");
    });
  });
});
