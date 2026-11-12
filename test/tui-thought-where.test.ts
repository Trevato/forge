/** Enter on a thought in the terminal's asked screen says where it went (#7473). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import { savePlacement } from "../src/core/placements.ts";
import { linkThoughts } from "../src/core/thought_links.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { askedLines, askedScreen, thoughtCard } from "../src/tui/screens/asked.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let bob: User;

const thought = (who: User, id: string, text: string, at: string) =>
  app.db
    .query("INSERT INTO thought (id, author, text, source, received_at) VALUES (?1, ?2, ?3, 'composer', ?4)")
    .run(id, who.id, text, at);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-thought-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    promote(app.db, r.value);
    return r.value;
  };
  await mk("carol", true);
  alice = await mk("alice");
  bob = await mk("bob");
  const lobby = await createRepo(app, alice, { name: "lobby", visibility: "public" });
  if (!lobby.ok) throw new Error(String(lobby.error));
  const i = createIssue(app.db, { repoId: lobby.value.id, authorId: alice.id, title: "Louder lobby" });
  if (!i.ok) throw new Error(i.error);
  thought(alice, "t1", "make the lobby louder", "2026-01-01T00:00:00.000Z");
  thought(alice, "t2", "louder lobby please", "2026-01-02T00:00:00.000Z");
  thought(bob, "t3", "bob's idea", "2026-01-03T00:00:00.000Z");
  const vault = await createRepo(app, bob, { name: "vault", visibility: "private" });
  if (!vault.ok) throw new Error(String(vault.error));
  const secret = createIssue(app.db, { repoId: vault.value.id, authorId: bob.id, title: "Hidden vault door" });
  if (!secret.ok) throw new Error(secret.error);
  thought(alice, "t5", "hide the vault door", "2026-01-05T00:00:00.000Z");
  savePlacement(app.db, {
    thoughtId: "t5", kind: "work", asked: false, decidedBy: "rule", reply: "ok",
    placed: [{ action: "opened", repo: "bob/vault", number: secret.value.number }],
    placedAt: "2026-01-05T00:01:00.000Z",
  });
  thought(alice, "t6", "and again", "2026-01-06T00:00:00.000Z");
  linkThoughts(app.db, "t6", "t3", "repeats");
  linkThoughts(app.db, "t6", "t3", "supersedes");
  savePlacement(app.db, {
    thoughtId: "t1", kind: "work", asked: false, decidedBy: "rule", reply: "ok",
    placed: [{ action: "opened", repo: "alice/lobby", number: i.value.number }],
    placedAt: "2026-01-01T00:01:00.000Z",
  });
  linkThoughts(app.db, "t2", "t1", "repeats");
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

const titles = (id: string, who: User) => thoughtCard(app.db, who, id)?.map((l) => l.title);

describe("a thought's card", () => {
  test("the placed one names its issue and the thought that repeated it", () => {
    const lines = titles("t1", alice)!.join("\n");
    expect(lines).toContain("It opened alice/lobby #1: Louder lobby.");
    expect(lines).toContain("Repeated later by \u201clouder lobby please\u201d.");
    expect(thoughtCard(app.db, alice, "t1")!.some((l) => l.issue?.repo.name === "lobby")).toBe(true);
  });

  test("the repeating one says what it repeats and that it is not placed yet", () => {
    const lines = titles("t2", alice)!.join("\n");
    expect(lines).toContain("Not placed yet");
    expect(lines).toContain("It repeats \u201cmake the lobby louder\u201d.");
  });

  test("a placement with nothing on the map is kept as a note", () => {
    thought(alice, "t4", "we value small things", "2026-01-04T00:00:00.000Z");
    savePlacement(app.db, {
      thoughtId: "t4", kind: "vision", asked: false, decidedBy: "rule", reply: "noted", placed: [],
      placedAt: "2026-01-04T00:01:00.000Z",
    });
    expect(titles("t4", alice)).toContain("Kept as a note.");
  });

  test("a placement in a repository the viewer cannot read names nothing and opens nothing", () => {
    const card = thoughtCard(app.db, alice, "t5")!;
    expect(card.map((l) => l.title)).toContain("It opened something in a repository you cannot read.");
    const all = JSON.stringify(card);
    for (const leak of ["bob/vault", "Hidden", "#1"]) expect(all).not.toContain(leak);
    expect(card.some((l) => l.issue !== undefined)).toBe(false);
  });

  test("a sealed issue in a readable repository names nothing and opens nothing", async () => {
    // A public repository of bob's: alice reads it but does not write it.
    const open = await createRepo(app, bob, { name: "open", visibility: "public" });
    if (!open.ok) throw new Error(String(open.error));
    const sealed = createIssue(app.db, { repoId: open.value.id, authorId: bob.id, title: "Sealed zero-day", sealed: true });
    if (!sealed.ok) throw new Error(sealed.error);
    thought(alice, "t8", "what about the zero-day", "2025-12-31T00:00:00.000Z");
    savePlacement(app.db, {
      thoughtId: "t8", kind: "work", asked: false, decidedBy: "rule", reply: "ok",
      placed: [{ action: "opened", repo: "bob/open", number: sealed.value.number }],
      placedAt: "2026-01-08T00:01:00.000Z",
    });
    const card = thoughtCard(app.db, alice, "t8")!;
    expect(card.map((l) => l.title)).toContain("It opened something in a repository you cannot read.");
    const all = JSON.stringify(card);
    expect(all).not.toContain("Sealed zero-day");
    expect(all).not.toContain(`#${sealed.value.number}`);
    expect(card.some((l) => l.issue !== undefined)).toBe(false);
  });

  test("a link to another person's thought reads as gone and quotes nothing of it", () => {
    const card = thoughtCard(app.db, alice, "t6")!;
    const titles = card.map((l) => l.title);
    expect(titles).toContain("It repeats a thought that is gone.");
    expect(titles).toContain("It takes back a thought that is gone.");
    expect(JSON.stringify(card)).not.toContain("bob's idea");
  });

  test("someone else's thought and a missing one are alike nothing", () => {
    expect(thoughtCard(app.db, alice, "t3")).toBeUndefined();
    expect(thoughtCard(app.db, alice, "nope")).toBeUndefined();
    expect(thoughtCard(app.db, undefined, "t1")).toBeUndefined();
  });

  // A thought is never deleted, so a test that needs it gone lifts the guard for one statement.
  const vanish = (id: string) => {
    app.db.run("DROP TRIGGER thought_no_delete");
    app.db.query("DELETE FROM thought WHERE id = ?1").run(id);
    app.db.run("CREATE TRIGGER thought_no_delete BEFORE DELETE ON thought BEGIN SELECT RAISE(ABORT, 'a thought is never deleted'); END");
  };

  const open = async (text: string) => {
    const terminal = headlessTerminal(120, 30);
    const { app: tui, session } = createForgeApp(app, { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: alice }, { terminal, exitHooks: false });
    tui.start();
    tui.ctx.push(askedScreen(session, tui.ctx));
    await settleApp(tui);
    // Select the row by its text, not by its place in the list.
    const at = askedLines(app.db, alice).thoughts.findIndex((t) => t.title === text);
    if (at < 0) throw new Error(`no thought ${text}`);
    terminal.feed("j".repeat(at));
    await settleApp(tui);
    return { tui, terminal };
  };

  test("enter on a thought in the screen opens its card", async () => {
    const { tui, terminal } = await open("make the lobby louder");
    terminal.feed("\r");
    await settleApp(tui);
    const text = tui.screen.toText();
    tui.stop?.();
    expect(text).toContain("It opened alice/lobby #1");
  });

  test("enter on a thought that has gone toasts and opens no card", async () => {
    thought(alice, "t9", "soon gone", "2026-01-09T00:00:00.000Z");
    const { tui, terminal } = await open("soon gone");
    vanish("t9");
    terminal.feed("\r");
    await settleApp(tui);
    const text = tui.screen.toText();
    tui.stop?.();
    expect(text).toContain("No such thought");
    expect(text).toContain("Asked");
    expect(text).not.toContain("Not placed yet");
  });

  test("r on a card reads again, and a card whose thought has gone toasts and pops", async () => {
    thought(alice, "t10", "to be placed", "2026-01-10T00:00:00.000Z");
    const { tui, terminal } = await open("to be placed");
    terminal.feed("\r");
    await settleApp(tui);
    expect(tui.screen.toText()).toContain("Not placed yet");
    savePlacement(app.db, {
      thoughtId: "t10", kind: "vision", asked: false, decidedBy: "rule", reply: "noted", placed: [],
      placedAt: "2026-01-10T00:01:00.000Z",
    });
    terminal.feed("r");
    await settleApp(tui);
    expect(tui.screen.toText()).toContain("Kept as a note.");
    vanish("t10");
    terminal.feed("r");
    await settleApp(tui);
    const text = tui.screen.toText();
    tui.stop?.();
    expect(text).toContain("No such thought");
    expect(text).not.toContain("Kept as a note.");
    expect(text).toContain("Asked");
  });
});
