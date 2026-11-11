/**
 * Talk runs the captain (#11011): memory is the owner's, editable and loaded
 * into every session's brief; routines post at most three lines into the
 * Captain thread on their schedule and push only when something needs the
 * person; the settings page is the owner's alone.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { listTurns } from "../src/core/conversations.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { addMemory, editMemory, listMemory, memoryBrief, removeMemory, rulesOf, seedMemory, STARTING_RULES } from "../src/core/talk_memory.ts";
import { due, listRoutines, ROUTINE_KINDS, setRoutine } from "../src/core/talk_routines.ts";
import { compose, LINES_MAX, type Facts } from "../src/crew/routine_report.ts";
import { releasesSince } from "../src/crew/routine_facts_story.ts";
import { runDue, runRoutine } from "../src/crew/routines.ts";
import { setNotifyUrl } from "../src/crew/notify.ts";
import { conversationBrief } from "../src/crew/conversation_brief.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let owner: User;
let other: User;
let third: User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-captain-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first = false) => {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
    if (!u.ok) throw new Error(u.error);
    return u.value;
  };
  owner = await mk("captainowner", true);
  other = await mk("buddy");
  third = await mk("third");
}, 30_000);

afterAll(async () => {
  servers.stop();
  await rm(dir, { recursive: true, force: true });
});

const quiet: Facts = { health: [], redMain: [], asks: 0, holds: {}, grokbotPulls: 0, mergedLastHour: 0, newPeople: [], waiting: 0, stuckRuns: 0, mergedToday: 0, openedToday: 0, releases: [], pillarsMoved: [] };

describe("memory", () => {
  test("is the person's own, bounded, and in the brief", () => {
    expect(addMemory(app.db, owner.id, "  ").ok).toBe(false);
    expect(addMemory(app.db, owner.id, "x".repeat(401))).toEqual({ ok: false, error: "too_long" });
    const added = addMemory(app.db, owner.id, "Never   rm\nanything.");
    if (!added.ok) throw new Error("add");
    expect(added.value.text).toBe("Never rm anything.");
    // The first write keeps the starting rules beside it.
    expect(memoryBrief(app.db, owner.id)).toContain(`${STARTING_RULES.length + 1}. Never rm anything.`);
    expect(memoryBrief(app.db, other.id)).toBe("");
    // Another person cannot edit or remove it.
    expect(editMemory(app.db, other.id, added.value.id, "mine now")).toEqual({ ok: false, error: "not_found" });
    expect(removeMemory(app.db, other.id, added.value.id)).toEqual({ ok: false, error: "not_found" });
    expect(editMemory(app.db, owner.id, added.value.id, "Never rm, ever.").ok).toBe(true);
    expect(listMemory(app.db, owner.id).at(-1)?.text).toBe("Never rm, ever.");
    expect(removeMemory(app.db, owner.id, added.value.id).ok).toBe(true);
    expect(memoryBrief(app.db, owner.id)).not.toContain("Never rm, ever.");
  });

  test("the starting rules are offered once and deleting them keeps them gone", () => {
    seedMemory(app.db, other.id);
    expect(listMemory(app.db, other.id).map((m) => m.text)).toEqual([...STARTING_RULES]);
    for (const m of listMemory(app.db, other.id)) removeMemory(app.db, other.id, m.id);
    seedMemory(app.db, other.id);
    expect(listMemory(app.db, other.id)).toEqual([]);
  });

  test("reading writes nothing: rules and routines are shown from defaults until a write", () => {
    const fresh = "reader-" + Date.now();
    expect(rulesOf(app.db, fresh).map((m) => m.text)).toEqual([...STARTING_RULES]);
    expect(listRoutines(app.db, fresh).map((r) => r.kind)).toEqual([...ROUTINE_KINDS]);
    expect(listMemory(app.db, fresh)).toEqual([]);
    expect(app.db.query("SELECT COUNT(*) AS n FROM talk_routine WHERE user_id = ?1").get(fresh)).toEqual({ n: 0 });
    expect(app.db.query("SELECT COUNT(*) AS n FROM user_setting WHERE user_id = ?1").get(fresh)).toEqual({ n: 0 });
  });

  test("a shown starting rule can be deleted before anything is stored", () => {
    const u = third.id;
    const first = rulesOf(app.db, u)[0]!;
    expect(first.id).toBe("start-0");
    expect(removeMemory(app.db, u, first.id).ok).toBe(true);
    expect(rulesOf(app.db, u).map((m) => m.text)).toEqual(STARTING_RULES.slice(1));
  });

  test("the brief fences routine posts as untrusted", () => {
    const brief = conversationBrief([]);
    expect(brief).toContain("untrusted data");
    expect(brief).not.toContain("your own earlier reports");
  });

  test("the brief tells the agent to act, and to ask first on money, DNS and a dark roll", () => {
    const brief = conversationBrief([]);
    expect(brief).toContain("instruction to act on at once");
    expect(brief).toContain("real money, DNS or a dark roll");
  });
});

describe("schedules", () => {
  const now = Date.parse("2026-11-10T12:30:00Z");
  test("an interval routine is due once its minutes have passed", () => {
    const r = { enabled: true, everyMin: 60, atHour: null, lastAt: "2026-11-10T11:31:00Z" };
    expect(due(r, now)).toBe(false);
    expect(due({ ...r, lastAt: "2026-11-10T11:30:00Z" }, now)).toBe(true);
    expect(due({ ...r, lastAt: null }, now)).toBe(true);
    expect(due({ ...r, enabled: false, lastAt: null }, now)).toBe(false);
  });
  test("a daily routine is due once per slot", () => {
    const r = { enabled: true, everyMin: 1440, atHour: 7, lastAt: "2026-11-10T07:00:30Z" };
    expect(due(r, now)).toBe(false);
    expect(due({ ...r, lastAt: "2026-11-09T07:00:30Z" }, now)).toBe(true);
  });
  test("a schedule is validated", () => {
    expect(setRoutine(app.db, owner.id, "nope", { enabled: true, everyMin: 60, atHour: null })).toEqual({ ok: false, error: "not_a_routine" });
    expect(setRoutine(app.db, owner.id, "checkin", { enabled: true, everyMin: 5, atHour: null })).toEqual({ ok: false, error: "bad_every" });
    expect(setRoutine(app.db, owner.id, "checkin", { enabled: true, everyMin: 60, atHour: 24 })).toEqual({ ok: false, error: "bad_hour" });
    const ok = setRoutine(app.db, owner.id, "checkin", { enabled: true, everyMin: 30, atHour: null });
    expect(ok.ok && ok.value.everyMin).toBe(30);
  });
});

describe("what a routine says", () => {
  test("the check-in names releases and pillars that moved, in one line, and never needs you for it", () => {
    const told = compose("checkin", { ...quiet, releases: ["0.7.9", "0.7.10"], pillarsMoved: [{ pillar: "Trust", merged: 2 }] });
    expect(told.lines.filter((l) => l.includes("0.7.10"))).toHaveLength(1);
    expect(told.lines.join(" ")).toContain("released 0.7.9, 0.7.10; moved: Trust 2");
    expect(told.lines.length).toBeLessThanOrEqual(LINES_MAX);
    expect(told.needs).toBe(false);
    const many = compose("checkin", { ...quiet, releases: ["1", "2", "3", "4", "5"], pillarsMoved: [] });
    expect(many.lines.join(" ")).toContain("released 5 (to 5)");
    expect(many.lines).toHaveLength(3);
    expect(compose("checkin", quiet).lines.join(" ")).not.toMatch(/released|moved/);
  });
  test("releases since an instant, oldest first", () => {
    const entries = [{ version: "0.7.3", date: "2026-11-10T11:00:00Z" }, { version: "0.7.2", date: "2026-11-10T10:00:00Z" }, { version: "0.7.1", date: "2026-11-10T08:00:00Z" }];
    expect(releasesSince(entries, Date.parse("2026-11-10T09:00:00Z"))).toEqual(["0.7.2", "0.7.3"]);
    expect(releasesSince(entries, Date.parse("2026-11-11T00:00:00Z"))).toEqual([]);
  });
  test("every report is at most three lines, and only trouble needs the person", () => {
    for (const kind of ["checkin", "friends", "paper"] as const) {
      expect(compose(kind, quiet).lines.length).toBeLessThanOrEqual(LINES_MAX);
      expect(compose(kind, quiet).needs).toBe(false);
      const loud = compose(kind, { ...quiet, health: ["disk is nearly full"], waiting: 2, newPeople: ["a", "b", "c", "d", "e", "f", "g"], stuckRuns: 1 });
      expect(loud.lines.length).toBeLessThanOrEqual(LINES_MAX);
    }
    expect(compose("checkin", { ...quiet, redMain: ["main is red"] })).toMatchObject({ needs: true });
    expect(compose("friends", { ...quiet, waiting: 1 }).needs).toBe(true);
    expect(compose("friends", { ...quiet, newPeople: ["ana"] }).needs).toBe(false);
    expect(compose("checkin", { ...quiet, holds: { juniper: 2 }, grokbotPulls: 1 }).lines.join(" ")).toContain("juniper 2");
  });
});

describe("the runner", () => {
  test("a due routine posts into one Captain thread; a quiet one does not push", async () => {
    const sent: string[] = [];
    const send = async (url: string, body: string) => (sent.push(`${url} ${body}`), true);
    const done = await runDue(app, new Date(), send);
    expect(done.map((d) => d.kind).sort()).toEqual(["checkin", "friends", "paper"]);
    expect(new Set(done.map((d) => d.conversationId)).size).toBe(1);
    const turns = listTurns(app.db, owner.id, done[0]!.conversationId, { limit: 50 });
    if (!turns.ok) throw new Error("turns");
    expect(turns.value.map((t) => t.role)).toEqual(["agent", "agent", "agent"]);
    expect(turns.value[0]!.text).toContain("**");
    expect(sent).toEqual([]);
    // Ran now: nothing is due a minute later, and a person who is not an admin gets none.
    expect(await runDue(app, new Date(Date.now() + 60_000), send)).toEqual([]);
    expect(listRoutines(app.db, owner.id).every((r) => r.lastAt !== null)).toBe(true);
    expect(app.db.query("SELECT COUNT(*) AS n FROM talk_routine WHERE user_id = ?1").get(other.id)).toEqual({ n: 0 });
  });

  test("a routine that needs the person pushes once, to their own URL", async () => {
    setNotifyUrl(app.db, owner.id, "https://ntfy.example/topic");
    app.db.query("INSERT INTO user (id, username, email, password_hash, kind) VALUES ('w1','newcomer','n@x.y','x','user')").run();
    app.db.query("INSERT INTO account_request (user_id, state, asked_at) VALUES ('w1','waiting', ?1)").run(new Date().toISOString());
    const sent: string[] = [];
    const posted = await runRoutine(app, owner, "friends", new Date(), async (url, body) => (sent.push(`${url}|${body}`), true));
    expect(posted.pushed).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("https://ntfy.example/topic|Friends watch:");
    expect(sent[0]).toContain(`/talk/${posted.conversationId}`);
  });
});

describe("Settings › Captain", () => {
  const cookie = (u: User) => `forge_session=${createSession(app.db, u.id).token}`;
  const post = (u: User, form: Record<string, string>, origin = servers.url) =>
    fetch(`${servers.url}/settings/captain`, { method: "POST", redirect: "manual", headers: { origin, cookie: cookie(u) }, body: new URLSearchParams(form) });

  test("the owner reads and edits memory and schedules; no one else sees it", async () => {
    const page = await fetch(`${servers.url}/settings/captain`, { headers: { cookie: cookie(owner) } });
    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain("Memory");
    expect(text).toContain("Morning paper");
    expect(text).toContain(STARTING_RULES[0]!);
    expect((await fetch(`${servers.url}/settings/captain`, { headers: { cookie: cookie(other) } })).status).toBe(404);
    expect((await fetch(`${servers.url}/settings/captain`, { redirect: "manual" })).status).not.toBe(200);

    expect((await post(owner, { do: "add", text: "Lend credit only to friends." })).status).toBe(303);
    expect(listMemory(app.db, owner.id).map((m) => m.text)).toContain("Lend credit only to friends.");
    const mine = listMemory(app.db, owner.id).find((m) => m.text.startsWith("Lend"))!;
    await post(owner, { do: "edit", id: mine.id, text: "Lend credit to nobody." });
    expect(listMemory(app.db, owner.id).some((m) => m.text === "Lend credit to nobody.")).toBe(true);
    await post(owner, { do: "delete", id: mine.id });
    expect(listMemory(app.db, owner.id).some((m) => m.id === mine.id)).toBe(false);

    expect((await post(owner, { do: "routine", kind: "checkin", enabled: "1", every: "30", hour: "" })).status).toBe(303);
    expect(listRoutines(app.db, owner.id).find((r) => r.kind === "checkin")?.everyMin).toBe(30);
    expect((await post(owner, { do: "routine", kind: "checkin", enabled: "1", every: "3", hour: "" })).status).toBe(422);
    expect((await post(other, { do: "add", text: "mine" })).status).toBe(404);
  });

  test("a post from another origin changes nothing", async () => {
    const before = listMemory(app.db, owner.id).length;
    const res = await post(owner, { do: "add", text: "forged" }, "https://evil.example");
    expect(res.status).toBe(403);
    expect(listMemory(app.db, owner.id).length).toBe(before);
  });
});

describe("the terminal screen", () => {
  test("reads a schedule as minutes or a daily UTC hour", async () => {
    const { parseSchedule, scheduleText } = await import("../src/tui/screens/captain.ts");
    expect(parseSchedule("45")).toEqual({ everyMin: 45, atHour: null });
    expect(parseSchedule("at 7")).toEqual({ everyMin: 15, atHour: 7 });
    expect(parseSchedule("daily 23")).toEqual({ everyMin: 15, atHour: 23 });
    expect(parseSchedule("soon")).toBeUndefined();
    expect(scheduleText({ everyMin: 60, atHour: null })).toBe("60");
    expect(scheduleText({ everyMin: 60, atHour: 7 })).toBe("at 7");
  });
});
