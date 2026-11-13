/** Estimates against an issue (#11955): ask, record, resolve, void, score. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { askEstimate, recordEstimate } from "../src/actions/estimates.ts";
import { openIssue, setIssueStateThrough } from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { currentByNumber, currentOf, estimatesOf, estimatesVisibleTo } from "../src/core/estimates.ts";
import { createIssue, getIssue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { baseRate, quantile, type HistorySample } from "../src/flow/estimate_base.ts";
import { biasWords, lastLine, median, scoreboard } from "../src/flow/estimate_score.ts";
import { durationWords, estimateLine, ratioOf } from "../src/flow/estimate_words.ts";
import { markLive, recordCut } from "../src/keeper/record.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { estimatesScreen, parseEstimate } from "../src/tui/screens/estimates.ts";
import type { Ctx as TuiCtx } from "../src/tui/app/app.ts";
import { keyFor } from "../src/tui/app/keys.ts";
import type { Session } from "../src/tui/session.ts";

const H = 3_600_000;
const NOW = new Date("2026-11-13T12:00:00.000Z");
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

const sample = (n: number, mergedH: number, extra: Partial<HistorySample> = {}): HistorySample => ({
  number: n,
  size: "small",
  kind: "bug",
  builder: null,
  pull: mergedH * H * 0.5,
  merged: mergedH * H,
  live: mergedH * H + 25 * 60_000,
  mergedAtMs: NOW.getTime() - 86_400_000,
  ...extra,
});

describe("the base rate", () => {
  test("six samples: nearest-rank p50 and p90 from now, with the stage after the merge", () => {
    const samples = [1, 2, 3, 4, 5, 6].map((h, i) => sample(i + 1, h));
    const r = baseRate(samples, { size: "small", kind: "bug", builder: null, elapsedMs: 0 }, "trevato/forge", NOW.getTime());
    expect(r.thin).toBe(false);
    expect(r.n).toBe(6);
    // sorted[round(5 * .5)] = sorted[3] = 4 h; sorted[round(5 * .9)] = sorted[5] = 6 h
    expect(r.events.merged!.p50Ms).toBe(4 * H);
    expect(r.events.merged!.p90Ms).toBe(6 * H);
    expect(r.events.merged!.p50At).toBe(at(4 * H));
    expect(r.basis).toContain("6 small bug issues, last 30 days in trevato/forge");
    expect(r.basis).toContain("work start→merged p50 4 h, p90 6 h");
    expect(r.basis).toContain("merged→live p50 25 m, p90 25 m");
  });

  test("fewer than five: it says so and widens, dropping the builder, then the kind", () => {
    const samples = [
      sample(1, 1, { builder: "torque" }),
      sample(2, 2, { builder: "torque" }),
      sample(3, 3, { kind: "" }),
      sample(4, 4, { kind: "" }),
      sample(5, 5, { kind: "" }),
      sample(6, 6, { kind: "" }),
    ];
    const r = baseRate(samples, { size: "small", kind: "bug", builder: "torque", elapsedMs: 0 }, "x/y", NOW.getTime());
    expect(r.widened).toEqual(["dropped the builder", "dropped the kind"]);
    expect(r.n).toBe(6);
    expect(r.thin).toBe(false);
    const few = baseRate(samples.slice(0, 2), { size: "small", kind: "bug", builder: null, elapsedMs: 0 }, "x/y", NOW.getTime());
    expect(few.thin).toBe(true);
    expect(few.basis).toContain("fewer than 5");
  });

  test("work already under way counts only what is left of the slower ones", () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8].map((h, i) => sample(i + 1, h));
    const r = baseRate(samples, { size: "small", kind: "bug", builder: null, elapsedMs: 2 * H }, "x/y", NOW.getTime());
    // 3..8 h remain 1..6 h: the same nearest ranks as above
    expect(r.events.merged!.p50Ms).toBe(4 * H);
  });

  test("durations read in words", () => {
    expect([durationWords(25 * 60_000), durationWords(190 * 60_000), durationWords(9 * H), durationWords(52 * H)]).toEqual(["25 m", "3 h 10 m", "9 h", "2 d 4 h"]);
    expect(quantile([1, 2, 3], 0.5)).toBe(2);
  });
});

describe("the scorecard maths", () => {
  const row = (id: number, who: string, p50H: number, actualH: number | null, p90H = p50H * 2, extra: object = {}) => ({
    id, repoId: "r", issueId: `i${id}`, issueNumber: id, event: "merged" as const,
    p50At: at(p50H * H), p90At: at(p90H * H), madeAt: at(0), byId: who, byName: who, byKind: "agent" as const,
    basis: "", baseJson: "null", size: "small", kind: "bug",
    actualAt: actualH === null ? null : at(actualH * H), voidedAt: null,
    state: actualH === null ? ("open" as const) : ("resolved" as const), ...extra,
  });

  test("ratio is actual over p50 from the moment it was made; the median is the bias", () => {
    expect(ratioOf(row(1, "a", 2, 5))).toBe(2.5);
    expect(median([1, 3, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    const rows = [row(1, "steward", 2, 5), row(2, "steward", 2, 4.8), row(3, "steward", 1, 2.4, 3), row(4, "steward", 2, null)];
    const all = scoreboard(rows).find((s) => s.who === "steward" && s.group === "")!;
    // ratios 2.5, 2.4, 2.4: median 2.4; p90 at 4, 4, 3: the first two missed, the third held
    expect(all.medianRatio).toBeCloseTo(2.4, 10);
    expect(all.p90Hit).toBeCloseTo(1 / 3, 10);
    expect([all.resolved, all.open, all.void]).toEqual([3, 1, 0]);
    expect(biasWords(all)).toBe("median 2.4× late, p90 held 33%");
    expect(lastLine(rows, "steward", true)).toBe("your last 3: median 2.4× late, p90 held 33%");
    expect(scoreboard(rows).some((s) => s.group === "small bug")).toBe(true);
  });

  test("void is counted, never scored; a revision after the fact does not improve the score", () => {
    const rows = [
      row(1, "steward", 2, 6),
      row(2, "steward", 2, 6, 4),
      { ...row(2, "steward", 5, 6, 8), id: 3, issueId: "i2" }, // revised later: kept, not scored
      row(4, "steward", 2, null, 4, { voidedAt: at(H), state: "void" }),
    ];
    const all = scoreboard(rows).find((s) => s.who === "steward" && s.group === "")!;
    expect(all.resolved).toBe(2);
    expect(all.void).toBe(1);
    expect(all.medianRatio).toBe(3);
  });

  test("the base rate shown at the time is scored as `history`", () => {
    const baseJson = JSON.stringify({ events: { merged: { p50At: at(3 * H), p90At: at(9 * H) } } });
    const rows = [row(1, "steward", 2, 3, 4, { baseJson })];
    const history = scoreboard(rows).find((s) => s.who === "history" && s.group === "")!;
    expect(history.medianRatio).toBe(1);
    expect(history.p90Hit).toBe(1);
  });

  test("the line: open, then resolved with its ratio", () => {
    const open = row(1, "steward", 2, null, 6, { baseJson: JSON.stringify({ events: { merged: { p50At: at(3 * H) } } }) });
    expect(estimateLine([open], NOW.getTime())).toBe("merged by Fri 14:00 (90%: Fri 18:00) · steward · history says Fri 15:00");
    expect(estimateLine([row(1, "steward", 2, 3)], NOW.getTime())).toBe("merged Fri 15:00, 1.5× the estimate");
  });
});

describe("recording and resolving on the forge", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let stranger: User;
  let repo: Repo;
  let rw = "";

  const issue = (title: string, body = "") => {
    const o = openIssue(app, alice, repo, { title, body });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
  };
  const getI = (n: number) => getIssue(app.db, repo.id, n)!;
  const say = (n: number, event: unknown, p50: string, p90: string, now = NOW, who = alice) =>
    recordEstimate(app, who, repo, getI(n), { event, p50, p90, basis: "by hand" }, now);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-estimates-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const other = await createUser(app.db, { origin: "seed", trusted: true, username: "mallory", email: "m@forge.local", password: "a-good-passphrase" });
    if (!other.ok) throw new Error(other.error);
    stranger = other.value;
    const r = await createRepo(app, alice, { name: "forge", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    await commitToBranch(app, alice, repo, { branch: "main", message: "base", files: [{ path: "a.txt", content: "a\n" }] });
    rw = createToken(app.db, alice.id, "rw", "rw").token;
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  test("ask: the base rate comes from seeded history", () => {
    for (let i = 0; i < 6; i++) {
      const done = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title: `done ${i}`, body: "" });
      if (!done.ok) throw new Error("issue");
      const pr = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title: `pr ${i}`, body: `Closes #${done.value.number}`, kind: "pull" });
      if (!pr.ok) throw new Error("pull");
      const created = new Date(NOW.getTime() - (i + 2) * 86_400_000).toISOString();
      const merged = new Date(NOW.getTime() - (i + 2) * 86_400_000 + (i + 1) * H).toISOString();
      app.db.query(`UPDATE issue SET state='closed', close_reason='done', created_at=?2 WHERE id=?1`).run(done.value.id, created);
      app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1,'main','b','a','b',?2)`).run(pr.value.id, merged);
    }
    const target = issue("a small thing");
    const asked = askEstimate(app, alice, repo, target, NOW);
    expect(asked.base.n).toBe(6);
    expect(asked.base.thin).toBe(false);
    expect(asked.base.events.merged!.p50Ms).toBe(4 * H);
    expect(asked.base.events.merged!.p90Ms).toBe(6 * H);
    expect(asked.facts.queuePosition).not.toBeNull();
    expect(asked.facts.budgetLeftUsd.day).toBeGreaterThanOrEqual(0);
    expect(asked.scorecard).toBe("you have no resolved estimates yet");
  });

  test("record: validated, stamped, and a new one supersedes while the old stays", () => {
    const n = issue("record me").number;
    expect(say(n, "nonsense", at(H), at(2 * H)).ok).toBe(false);
    expect(say(n, "merged", at(-H), at(2 * H)).ok).toBe(false);
    expect(say(n, "merged", at(3 * H), at(2 * H)).ok).toBe(false);
    expect(say(n, "merged", "tomorrow", at(2 * H)).ok).toBe(false);
    const nobody = say(n, "merged", at(H), at(2 * H), NOW, stranger);
    expect(nobody.ok).toBe(false);
    if (!nobody.ok) expect(nobody.error.kind).toBe("forbidden");
    expect(estimatesOf(app.db, getI(n).id)).toHaveLength(0);

    const first = say(n, "merged", at(H), at(2 * H));
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.estimate).toMatchObject({ byName: "alice", byKind: "person", madeAt: NOW.toISOString(), event: "merged", state: "open" });
    expect(JSON.parse(first.value.estimate.baseJson).events).toBeDefined();
    const second = say(n, "merged", at(4 * H), at(5 * H));
    expect(second.ok).toBe(true);
    const rows = estimatesOf(app.db, getI(n).id);
    expect(rows).toHaveLength(2);
    expect(currentOf(rows)[0]!.p50At).toBe(at(4 * H));
    expect(rows[0]!.p50At).toBe(at(H));
  });

  test("resolved by the forge: pull opened, merged, and live; never by hand", async () => {
    const t = issue("ship me");
    const real = new Date();
    const soon = (h: number) => new Date(real.getTime() + h * H).toISOString();
    for (const ev of ["pull_opened", "merged", "live"] as const) {
      const made = recordEstimate(app, alice, repo, t, { event: ev, p50: soon(1), p90: soon(2) }, real);
      expect(made.ok).toBe(true);
    }
    await commitToBranch(app, alice, repo, { branch: "ship", base: "main", message: "ship", files: [{ path: "s.txt", content: "s\n" }] });
    const opened = await openPull(app, alice, repo, { title: "Ship it", body: `Closes #${t.number}`, baseBranch: "main", headBranch: "ship" });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const state = () => Object.fromEntries(estimatesOf(app.db, t.id).map((e) => [e.event, e.state]));
    expect(state()).toEqual({ pull_opened: "resolved", merged: "open", live: "open" });
    // Asking for an event that already happened is refused.
    expect(recordEstimate(app, alice, repo, t, { event: "pull_opened", p50: soon(1), p90: soon(2) }, real).ok).toBe(false);
    const merged = await mergePull(app, alice, repo, opened.value, "squash");
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    expect(state()).toEqual({ pull_opened: "resolved", merged: "resolved", live: "open" });
    // A release cut before the merge does not carry it; one cut after does, and its going live
    // resolves.
    const before = recordCut(app.db, { version: "v-old", sha: "a", knownGood: { version: "k", image: "i" }, at: real.getTime() - 3_600_000 });
    markLive(app.db, before.id, real.getTime() + 1000);
    app.bus.append({ kind: "release.verified_live", repoId: repo.id, payload: { version: "v-old" } });
    expect(state().live).toBe("open");
    const cut = recordCut(app.db, { version: "v-new", sha: "b", knownGood: { version: "k", image: "i" }, at: real.getTime() + 2000 });
    expect(markLive(app.db, cut.id, real.getTime() + 60_000)).toBe(true);
    // Settled when the release is verified, not when it merely answers.
    expect(state().live).toBe("open");
    app.bus.append({ kind: "release.verified_live", repoId: repo.id, payload: { version: "v-new" } });
    expect(state()).toEqual({ pull_opened: "resolved", merged: "resolved", live: "resolved" });
    const live = estimatesOf(app.db, t.id).find((e) => e.event === "live")!;
    expect(live.actualAt).toBe(new Date(real.getTime() + 60_000).toISOString());
    expect(estimateLine([live], real.getTime())).toContain("went live");
  }, 30_000);

  test("an issue closed as split or dropped voids what it left open; done does not", async () => {
    const split = issue("too big");
    const dropped = issue("not wanted");
    for (const t of [split, dropped]) expect(say(t.number, "merged", at(H), at(2 * H)).ok).toBe(true);
    const a = await setIssueStateThrough(app, alice, repo, split, "closed", { reason: "split", into: [issue("half").number] });
    expect(a.ok).toBe(true);
    const b = await setIssueStateThrough(app, alice, repo, dropped, "closed", { reason: "dropped" });
    expect(b.ok).toBe(true);
    expect(estimatesOf(app.db, split.id)[0]).toMatchObject({ state: "void" });
    expect(estimatesOf(app.db, dropped.id)[0]!.voidedAt).not.toBeNull();
    // Closed as done, the promise is kept to be resolved by the merge; nothing voids it.
    const finished = issue("finished by hand");
    expect(say(finished.number, "merged", at(H), at(2 * H)).ok).toBe(true);
    const c = await setIssueStateThrough(app, alice, repo, finished, "closed", { reason: "done" });
    expect(c.ok).toBe(true);
    expect(estimatesOf(app.db, finished.id)[0]).toMatchObject({ state: "open", voidedAt: null });
    const voidRow = scoreboard(estimatesVisibleTo(app.db, alice)).find((s) => s.who === "alice" && s.group === "")!;
    expect(voidRow.void).toBeGreaterThanOrEqual(2);
  });

  test("the API asks and records, and the issue page and /next carry the line", async () => {
    const t = issue("api and page");
    const url = `${servers.url}/api/v1/repos/alice/forge/issues/${t.number}/estimates`;
    const asked = await fetch(url, { headers: { authorization: `Bearer ${rw}` } });
    expect(asked.status).toBe(200);
    expect(((await asked.json()) as any).base.basis).toBeString();
    const soon = (h: number) => new Date(Date.now() + h * H).toISOString();
    const bad = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${rw}`, "content-type": "application/json" }, body: JSON.stringify({ event: "live", p50: soon(3), p90: soon(1) }) });
    expect(bad.status).toBe(422);
    const ok = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${rw}`, "content-type": "application/json" }, body: JSON.stringify({ event: "live", p50: soon(3), p90: soon(5), basis: "api" }) });
    expect(ok.status).toBe(201);
    const page = await (await fetch(`${servers.url}/alice/forge/issues/${t.number}`)).text();
    expect(page).toContain("live by");
    expect(page).toContain("· alice");
    const next = await (await fetch(`${servers.url}/alice/forge/next`)).text();
    expect(next).toContain("live by");
  });

  test("the MCP tool asks with no times and records with them", async () => {
    const t = issue("mcp");
    const call = async (args: unknown) => {
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${rw}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "estimate", arguments: args } }),
      });
      const body = (await res.json()) as any;
      return { error: body.result.isError === true, value: body.result.isError === true ? body.result.content[0].text : JSON.parse(body.result.content[0].text) };
    };
    const asked = await call({ repo: "alice/forge", issue: t.number });
    expect(asked.error).toBe(false);
    expect(asked.value.base).toBeDefined();
    const soon = (h: number) => new Date(Date.now() + h * H).toISOString();
    const made = await call({ repo: "alice/forge", issue: t.number, event: "merged", p50: soon(1), p90: soon(2), basis: "mcp" });
    expect(made.error).toBe(false);
    const refused = await call({ repo: "alice/forge", issue: t.number, event: "merged", p50: soon(2), p90: soon(1) });
    expect(refused.error).toBe(true);
  });
});

describe("who sees what, and how much is read", () => {
  let dir: string;
  let a: App;
  let owner: User;
  let outsider: User;
  let hidden: Repo;
  let shown: Repo;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-estimates-scope-"));
    a = createApp({ dataDir: dir, port: 0 });
    const o = await createUser(a.db, { origin: "seed", trusted: true, username: "olive", email: "o@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    const x = await createUser(a.db, { origin: "seed", trusted: true, username: "xavier", email: "x@forge.local", password: "a-good-passphrase" });
    if (!o.ok || !x.ok) throw new Error("users");
    owner = o.value;
    outsider = x.value;
    const priv = await createRepo(a, owner, { name: "vault", visibility: "private" });
    const pub = await createRepo(a, owner, { name: "open", visibility: "public" });
    if (!priv.ok || !pub.ok) throw new Error("repos");
    hidden = priv.value;
    shown = pub.value;
  }, 30_000);
  afterAll(async () => {
    a.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  const promise = (repo: Repo, title: string) => {
    const made = createIssue(a.db, { repoId: repo.id, authorId: owner.id, title, body: "" });
    if (!made.ok) throw new Error("issue");
    const soon = (h: number) => new Date(Date.now() + h * H).toISOString();
    const r = recordEstimate(a, owner, repo, made.value, { event: "merged", p50: soon(1), p90: soon(2) });
    if (!r.ok) throw new Error(r.error.message);
    return made.value;
  };

  test("the scorecards leave out repositories the viewer cannot read", () => {
    promise(hidden, "secret plan");
    promise(shown, "public plan");
    const sees = (u: User | undefined) => estimatesVisibleTo(a.db, u).map((e) => e.repoId);
    expect(sees(undefined)).toEqual([shown.id]);
    expect(sees(outsider)).toEqual([shown.id]);
    expect(new Set(sees(owner))).toEqual(new Set([hidden.id, shown.id]));
    // The asker's own card reads the same scope: no private estimate of
    // someone else's is in it.
    expect(estimatesVisibleTo(a.db, outsider, owner.id).map((e) => e.repoId)).toEqual([shown.id]);
  });

  test("a list names its issues and reads only theirs", () => {
    const one = promise(shown, "listed");
    promise(shown, "not listed");
    const got = currentByNumber(a.db, shown.id, [one.number]);
    expect([...got.keys()]).toEqual([one.number]);
    expect(currentByNumber(a.db, shown.id, [])).toEqual(new Map());
  });

  test("moving an issue to Not now voids its open estimates; a duplicate is a drop", async () => {
    const gate = openIssue(a, owner, shown, { title: "Later gate: not now" });
    expect(gate.ok).toBe(true);
    const t = promise(shown, "to defer");
    const { rankIssue } = await import("../src/actions/next.ts");
    const moved = rankIssue(a, owner, shown, t.number, { to: "not_now" });
    expect(moved.ok).toBe(true);
    expect(estimatesOf(a.db, t.id)[0]).toMatchObject({ state: "void" });
    const dup = promise(shown, "a duplicate");
    const closed = await setIssueStateThrough(a, owner, shown, dup, "closed", { reason: "dropped", note: "duplicate of another" });
    expect(closed.ok).toBe(true);
    expect(estimatesOf(a.db, dup.id)[0]).toMatchObject({ state: "void" });
  });

  test("the terminal door: a reader asks, only a writer records, a private repository shows nothing", async () => {
    const t = promise(shown, "on the screen");
    const session = (user: User | undefined) => ({ user, db: a.db, app: a }) as unknown as Session;
    const run = async (user: User | undefined, repo: Repo, key: string) => {
      const pushed: unknown[] = [];
      let drawn = 0;
      const ctx = { toast() {}, invalidate: () => drawn++, push: (x: unknown) => pushed.push(x), theme: {} } as unknown as TuiCtx;
      const screen = estimatesScreen(session(user), ctx, repo);
      await screen.load?.(new AbortController().signal);
      const before = drawn;
      screen.key?.(keyFor(key)!);
      return { pushed: pushed.length, drew: drawn - before };
    };
    expect(t.number).toBeGreaterThan(0);
    // Asking redraws with the answer for anyone who can read; recording
    // opens the prompt for a writer only.
    expect((await run(outsider, shown, "a")).drew).toBe(1);
    expect((await run(outsider, shown, "r")).pushed).toBe(0);
    expect((await run(owner, shown, "r")).pushed).toBe(1);
    // The private repository lists nothing to an outsider: no ask, no record.
    expect(await run(outsider, hidden, "a")).toEqual({ pushed: 0, drew: 0 });
    expect(await run(outsider, hidden, "r")).toEqual({ pushed: 0, drew: 0 });
    expect(parseEstimate("merged 2026-11-14T07:15:00Z 2026-11-14T11:00:00Z a small change")).toEqual({ event: "merged", p50: "2026-11-14T07:15:00Z", p90: "2026-11-14T11:00:00Z", basis: "a small change" });
    expect(parseEstimate("merged only")).toBeUndefined();
  });
});
