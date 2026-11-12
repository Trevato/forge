/**
 * Triage (#652): each kind of thought is placed on the map and answered in
 * a line, an unsure one gets a question, thoughts come in batches, and the
 * placement is readable (MCP `thought`, the feed). The decider is a stub.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { keepThought } from "../src/actions/thought.ts";
import { listComments, getIssue, getIssueById } from "../src/core/issues.ts";
import { readyNow, repoGraph } from "../src/core/dependencies.ts";
import { linksFrom } from "../src/core/thought_links.ts";
import { thoughtStream } from "../src/core/thought_stream.ts";
import { placementOf } from "../src/core/placements.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { BATCH_MS, placeThought, ruleKind, triageTick } from "../src/crew/triage.ts";
import type { Decider } from "../src/crew/decide.ts";
import { replyUnder } from "../src/web/studio/feed.ts";
import { thoughtRow } from "../src/web/studio/asked_page.ts";

/** Answers by the first word of the thought: `kind:p:#target:pillar`. */
const stub = (script: Record<string, [string, number, string?, string?]>): Decider => ({
  name: "stub",
  async decide(state, questions) {
    const text = (state as { thought: string }).thought;
    const [kind, p, target, pillar] = script[text.split(/\W/)[0]!] ?? ["work", 0.9];
    const pick = (key: string, choice: string, prob: number) => {
      const options = questions[key]!.options;
      return { choice, p: prob, probabilities: Object.fromEntries(options.map((o) => [o, o === choice ? prob : 0])) };
    };
    const out: Record<string, ReturnType<typeof pick>> = { kind: pick("kind", kind, p) };
    if (questions["target"]) out["target"] = pick("target", target ?? "none", 1);
    if (questions["pillar"]) out["pillar"] = pick("pillar", pillar ?? "P7", 1);
    return out as never;
  },
});

describe("triage", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  let n = 0;
  const fresh = () => getRepoById(app.db, repo.id)!;
  const think = (text: string) => {
    const kept = keepThought(app, alice, text, "api");
    if (!kept.ok) throw new Error(kept.error);
    return { id: kept.value.id, text };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-triage-"));
    app = createApp({ dataDir, port: 0 });
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!made.ok) throw new Error(String(made.error));
    alice = made.value;
    const r = await createRepo(app, alice, { name: "forge", visibility: "private" });
    if (!r.ok) throw new Error(String(r.error));
    await updateRepoSettings(app, alice, r.value, {
      autonomy: "autonomous",
      autonomyDirection: "Steer by thought.",
      autonomyCeilingUsd: 10,
      autonomySlots: 1,
      autonomyBy: alice.id,
    });
    repo = r.value;
    repo = fresh();
    for (const title of ["P0 Trust: safe", "P7 Steering: thoughts", "Later gate: wait here"]) {
      const o = openIssue(app, alice, repo, { title });
      if (!o.ok) throw new Error(String(o.error));
    }
    const o = openIssue(app, alice, repo, { title: "Planner answers thoughts in the feed" });
    if (!o.ok) throw new Error(String(o.error));
    n = o.value.number;
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("work opens an issue under its pillar, linked back to the thought, and the reply says so", async () => {
    app.config.decider = stub({ build: ["work", 0.9, "none", "P7"] });
    const t = think("build a dark mode toggle");
    const p = await placeThought(app, fresh(), alice, t);
    expect(p.kind).toBe("work");
    expect(p.placed[0]!.action).toBe("opened");
    expect(p.placed[0]!.pillar).toBe("P7");
    const issue = getIssue(app.db, repo.id, p.placed[0]!.number)!;
    expect(issue.body).toContain(t.id);
    expect(p.reply).toBe(`Opened #${issue.number} under P7 Steering.`);
    expect(p.asked).toBe(false);
    expect(placementOf(app.db, t.id)?.reply).toBe(p.reply);
  });

  test("work that names no pillar opens an issue on no edge: the old Later-gate rule is gone (#7801)", async () => {
    app.config.decider = stub({ somewhere: ["work", 0.9, "none"] });
    const p = await placeThought(app, fresh(), alice, think("somewhere to put a thing"));
    expect(p.placed[0]!.action).toBe("opened");
    const issue = getIssue(app.db, repo.id, p.placed[0]!.number)!;
    const edges = app.db.query<{ c: number }, [string]>("SELECT count(*) c FROM issue_dependency WHERE issue_id = ?1").get(issue.id)!.c;
    expect(edges).toBe(0);
  });

  test("a thought with nothing to act on opens nothing and is kept as a note", async () => {
    app.config.decider = { name: "boom", async decide() { throw new Error("asked"); } } as never;
    const count = () => app.db.query<{ c: number }, []>("SELECT count(*) c FROM issue").get()!.c;
    const before = count();
    const slug = await placeThought(app, fresh(), alice, think("trevato/forge"));
    expect(slug.placed).toEqual([]);
    expect(slug.reply).toBe("Kept as a note: what should change in alice/forge?");
    const blank = await placeThought(app, fresh(), alice, { id: "blank-1", text: "  " });
    expect(blank.placed).toEqual([]);
    const url = await placeThought(app, fresh(), alice, think("https://forge.open-platform.sh/trevato/forge"));
    expect(url.placed).toEqual([]);
    expect(count()).toBe(before);
  });

  test("a short ask reaches the decider, and #N and a plain sentence still place", async () => {
    app.config.decider = stub({ fix: ["amendment", 0.9, `#${n}`], the: ["work", 0.9, "none", "P7"] });
    const short = await placeThought(app, fresh(), alice, think("fix login"));
    expect(short.decidedBy).toBe("stub");
    expect(short.placed.length).toBe(1);
    const a = await placeThought(app, fresh(), alice, think("fix #" + n));
    expect(a.placed[0]!.number).toBe(n);
    const w = await placeThought(app, fresh(), alice, think("the home page is slow"));
    expect(w.placed[0]!.action).toBe("opened");
  });

  test("an amendment comments on the open issue it concerns", async () => {
    app.config.decider = stub({ also: ["amendment", 0.9, `#${n}`] });
    const t = think("also show it on the phone");
    const p = await placeThought(app, fresh(), alice, t);
    expect(p.kind).toBe("amendment");
    expect(p.reply).toBe(`Added to #${n}.`);
    const issue = getIssue(app.db, repo.id, n)!;
    expect(listComments(app.db, issue.id).some((c) => c.body.includes(t.id))).toBe(true);
  });

  test("vision and decision land on the direction issue", async () => {
    app.config.decider = stub({ vision: ["vision", 0.9], decided: ["decision", 0.9] });
    const v = await placeThought(app, fresh(), alice, think("vision: the forge steers itself"));
    const d = await placeThought(app, fresh(), alice, think("decided to keep one file of state"));
    expect(v.kind).toBe("vision");
    expect(d.kind).toBe("decision");
    const dir = fresh().directionIssueId!;
    const dirNumber = getIssueById(app.db, dir)!.number;
    expect(v.placed[0]!.number).toBe(dirNumber);
    expect(d.placed[0]!.number).toBe(dirNumber);
    const bodies = listComments(app.db, dir).map((c) => c.body);
    expect(bodies.some((b) => b.includes("The direction changes"))).toBe(true);
    expect(bodies.some((b) => b.includes("A decision"))).toBe(true);
  });

  test("a reversal marks the issue superseded and defers it behind the Later gate", async () => {
    app.config.decider = stub({ scrap: ["reversal", 0.9, `#${n}`] });
    const p = await placeThought(app, fresh(), alice, think(`scrap #${n}, no longer wanted`));
    expect(p.kind).toBe("reversal");
    expect(p.placed[0]).toMatchObject({ action: "deferred", number: n });
    const gate = [...Array(10).keys()].map((i) => getIssue(app.db, repo.id, i + 1)).find((i) => i?.title.startsWith("Later gate"))!;
    const blocked = app.db
      .query<{ c: number }, [string, string]>("SELECT COUNT(*) c FROM issue_dependency WHERE issue_id = ?1 AND blocked_by_id = ?2")
      .get(getIssue(app.db, repo.id, n)!.id, gate.id)!;
    expect(blocked.c).toBe(1);
  });

  test("an ambiguous thought gets its best placement and one question", async () => {
    app.config.decider = stub({ hmm: ["work", 0.4, "none", "P0"] });
    const p = await placeThought(app, fresh(), alice, think("hmm maybe something about speed"));
    expect(p.asked).toBe(true);
    expect(p.placed[0]!.action).toBe("opened");
    expect(p.reply).toContain("Opened #");
    expect(p.reply.endsWith("is that right?")).toBe(true);
  });

  test("a reversal that names nothing is kept on the direction with a question", async () => {
    app.config.decider = stub({ nope: ["reversal", 0.9, "none"] });
    const p = await placeThought(app, fresh(), alice, think("nope, undo the thing"));
    expect(p.asked).toBe(true);
    expect(p.reply).toContain("Which issue does this take back?");
  });

  test("the same words twice are linked, never opened twice", async () => {
    app.config.decider = stub({});
    const first = await placeThought(app, fresh(), alice, think("write the changelog"));
    const again = await placeThought(app, fresh(), alice, think("write the changelog"));
    expect(again.placed[0]).toMatchObject({ action: "linked", number: first.placed[0]!.number });
  });

  test("without a decider the rule answers, and still never stays silent", async () => {
    delete app.config.decider;
    expect(ruleKind("actually, forget that", false).kind).toBe("reversal");
    expect(ruleKind("from now on the vision is speed", false).kind).toBe("vision");
    const p = await placeThought(app, fresh(), alice, think("add a search box to the home page"));
    expect(p.reply.length).toBeGreaterThan(0);
    expect(placementOf(app.db, p.thoughtId)).toBeDefined();
  });

  test("thoughts are placed together once the first has waited two minutes, and not before", async () => {
    app.config.decider = stub({});
    const a = think("batch one");
    const b = think("batch two");
    const start = new Date();
    expect(await triageTick(app, new Date(start.getTime() + BATCH_MS - 5_000))).toBe(0);
    expect(placementOf(app.db, a.id)).toBeUndefined();
    const placed = await triageTick(app, new Date(start.getTime() + BATCH_MS + 5_000));
    expect(placed).toBeGreaterThanOrEqual(2);
    expect(placementOf(app.db, a.id)).toBeDefined();
    expect(placementOf(app.db, b.id)).toBeDefined();
    expect(await triageTick(app, new Date(start.getTime() + BATCH_MS + 10_000))).toBe(0);
  });

  test("thoughts older than a day never crowd out a fresh one", async () => {
    app.config.decider = stub({});
    const old = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString();
    for (let i = 0; i < 31; i++) {
      app.db
        .query("INSERT INTO thought (id, author, text, source, received_at) VALUES (?1, ?2, ?3, 'api', ?4)")
        .run(`stale-${i}`, alice.id, `stale ${i}`, old);
    }
    const f = think("fresh after the stale ones");
    const placed = await triageTick(app, new Date(Date.now() + BATCH_MS + 5_000));
    expect(placed).toBeGreaterThanOrEqual(1);
    expect(placementOf(app.db, f.id)).toBeDefined();
    expect(placementOf(app.db, "stale-0")).toBeUndefined();
  });

  test("a repeat raises what it repeats instead of opening a duplicate, and says when and where it stands", async () => {
    app.config.decider = stub({ build: ["work", 0.9, "none", "P7"] });
    const first = await placeThought(app, fresh(), alice, think("make the export button visible on phones"));
    const target = getIssue(app.db, repo.id, first.placed[0]!.number)!;
    const other = openIssue(app, alice, fresh(), { title: "Something older and unrelated to anything" });
    if (!other.ok) throw new Error(String(other.error));
    const count = () => app.db.query<{ c: number }, []>("SELECT COUNT(*) c FROM issue").get()!.c;
    const before = count();
    const again = think("Make the export button visible on phones!");
    const p = await placeThought(app, fresh(), alice, again);
    expect(count()).toBe(before);
    expect(p.placed[0]).toMatchObject({ action: "linked", number: target.number });
    expect(p.reply).toContain("You asked this on");
    expect(p.reply).toContain(`#${target.number} is open`);
    expect(linksFrom(app.db, again.id).repeats).toHaveLength(1);
    const ready = readyNow(repoGraph(app.db, repo.id)).map((r) => r.issue.number);
    expect(ready.indexOf(target.number)).toBe(0);
    expect(listComments(app.db, target.id).some((c) => c.body.includes(again.id))).toBe(true);
  });

  test("a reversal links the thought it takes back, which then reads as superseded", async () => {
    app.config.decider = stub({ build: ["work", 0.9, "none", "P7"], scrap: ["reversal", 0.9, "#0"] });
    const early = think("build a sparkline for spend per day");
    const placed = await placeThought(app, fresh(), alice, early);
    const num = placed.placed[0]!.number;
    app.config.decider = stub({ scrap: ["reversal", 0.9, `#${num}`] });
    const late = think(`scrap #${num}, no sparkline`);
    const p = await placeThought(app, fresh(), alice, late);
    expect(p.reply).toContain("you said it on");
    expect(linksFrom(app.db, late.id).supersedes).toEqual([early.id]);
    const row = thoughtStream(app.db, alice).find((t) => t.id === early.id)!;
    expect(row.state).toBe("superseded");
    expect(row.supersededBy?.id).toBe(late.id);
    expect(thoughtStream(app.db, alice).find((t) => t.id === late.id)!.supersedes[0]!.id).toBe(early.id);
  });

  test("a reversal in the same words is not a repeat and raises nothing", async () => {
    app.config.decider = stub({ build: ["work", 0.9, "none", "P7"] });
    const origin = think("make the search box visible on tablets");
    const first = await placeThought(app, fresh(), alice, origin);
    const target = getIssue(app.db, repo.id, first.placed[0]!.number)!;
    const raised = () => app.db.query<{ c: number }, [string]>("SELECT COUNT(*) c FROM issue_raise WHERE issue_id = ?1").get(target.id)!.c;
    for (const said of [
      "do not make the search box visible on tablets",
      "don't make the search box visible on tablets",
      "make the search box hidden on tablets",
    ]) {
      const later = think(said);
      const p = await placeThought(app, fresh(), alice, later);
      expect(linksFrom(app.db, later.id).repeats).not.toContain(origin.id);
      expect(p.reply).not.toContain(`#${target.number} is open`);
      expect(raised()).toBe(0);
    }
  });

  test("raising an issue for a repeated ask is an event on its repository", async () => {
    app.config.decider = stub({ build: ["work", 0.9, "none", "P7"] });
    const text = "show the build time next to each pull";
    const first = await placeThought(app, fresh(), alice, think(text));
    const number = first.placed[0]!.number;
    const raisedEvents = () =>
      app.db
        .query<{ c: number }, [string]>("SELECT COUNT(*) c FROM event WHERE kind = 'issue.raised' AND repo_id = ?1")
        .get(repo.id)!.c;
    const before = raisedEvents();
    const again = await placeThought(app, fresh(), alice, think(text));
    expect(again.reply).toContain("Raised it");
    expect(raisedEvents()).toBe(before + 1);
    expect(number).toBeGreaterThan(0);
  });

  test("a repeat of an ask that was deferred says so and does not claim to raise it", async () => {
    app.config.decider = stub({ build: ["work", 0.9, "none", "P7"], scrap: ["reversal", 0.9, "#0"] });
    const text = "build a heatmap of commits per hour";
    const placed = await placeThought(app, fresh(), alice, think(text));
    const num = placed.placed[0]!.number;
    app.config.decider = stub({ scrap: ["reversal", 0.9, `#${num}`], build: ["work", 0.9, "none", "P7"] });
    await placeThought(app, fresh(), alice, think(`scrap #${num}, no heatmap`));
    const issue = getIssue(app.db, repo.id, num)!;
    const deferred = repoGraph(app.db, repo.id).deferred.has(issue.id);
    const again = think(text);
    const p = await placeThought(app, fresh(), alice, again);
    if (deferred) {
      expect(p.reply).toContain("deferred");
      expect(p.reply).not.toContain("Raised it");
      expect(app.db.query("SELECT 1 FROM issue_raise WHERE issue_id = ?1").get(issue.id)).toBeNull();
    } else {
      expect(p.reply).not.toContain("deferred");
    }
  });

  test("the asked page says a thought was said again or takes one back, and escapes the earlier text", async () => {
    app.config.decider = stub({ build: ["work", 0.9, "none", "P7"], scrap: ["reversal", 0.9, "#0"] });
    const early = think("build a <b>bold</b> gauge for queue depth");
    const placed = await placeThought(app, fresh(), alice, early);
    const num = placed.placed[0]!.number;
    const again = think("build a <b>bold</b> gauge for queue depth");
    await placeThought(app, fresh(), alice, again);
    app.config.decider = stub({ scrap: ["reversal", 0.9, `#${num}`] });
    const late = think(`scrap #${num}, no <i>gauge</i>`);
    await placeThought(app, fresh(), alice, late);
    const rows = thoughtStream(app.db, alice);
    const repeatRow = String(thoughtRow(rows.find((t) => t.id === again.id)!, 7));
    expect(repeatRow).toContain("repeats “build a &lt;b&gt;bold&lt;/b&gt; gauge for queue depth”");
    const reverseRow = String(thoughtRow(rows.find((t) => t.id === late.id)!, 7));
    expect(reverseRow).toContain("takes back");
    expect(reverseRow).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(reverseRow).not.toContain("<b>bold</b>");
    expect(String(thoughtRow(rows.find((t) => t.id === early.id)!, 7))).toContain("superseded by");
  });

  test("a reply links its issue numbers and escapes everything else", () => {
    const html = replyUnder({
      thoughtId: "x", kind: "work", placed: [{ action: "opened", repo: "alice/forge", number: 12 }],
      reply: "Opened #12 <b>now</b>.", asked: false, decidedBy: "rule", placedAt: "",
    }).toString();
    expect(html).toContain('<a href="/alice/forge/issues/12">#12</a>');
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
  });
});
