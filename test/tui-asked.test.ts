/**
 * /asked in the terminal (#1755): the screen reads the page's own rows, so a
 * guest sees nothing, a viewer sees only their own thoughts, and a placement
 * in a repository they cannot read names nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createIssue, setIssueState } from "../src/core/issues.ts";
import { savePlacement } from "../src/core/placements.ts";
import { linkThoughts } from "../src/core/thought_links.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp, forgeCommands, Session } from "../src/tui/forge.ts";
import { askedLines, askedScreen } from "../src/tui/screens/asked.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let bob: User;
let carol: User;

const identity = (user?: User) => ({
  sshUsername: user?.username ?? "git",
  remoteAddress: "127.0.0.1",
  fingerprint: "SHA256:test",
  user,
});

const thought = (who: User, id: string, text: string) =>
  app.db
    .query("INSERT INTO thought (id, author, text, source, received_at) VALUES (?1, ?2, ?3, 'composer', ?4)")
    .run(id, who.id, text, new Date().toISOString());

async function screenText(user?: User, keys = ""): Promise<string> {
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(app, identity(user), { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(askedScreen(session, tui.ctx));
  await settleApp(tui);
  if (keys !== "") {
    terminal.feed(keys);
    await settleApp(tui);
  }
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

const ask = (repoId: string, who: User, title: string, at: string) => {
  const r = createIssue(app.db, { repoId, authorId: who.id, title });
  if (!r.ok) throw new Error(r.error);
  app.db.query("UPDATE issue SET created_at = ?1 WHERE id = ?2").run(at, r.value.id);
  return r.value;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-asked-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    promote(app.db, r.value);
    return r.value;
  };
  carol = await mk("carol", true);
  alice = await mk("alice");
  bob = await mk("bob");
  const lobby = await createRepo(app, alice, { name: "lobby", visibility: "public" });
  if (!lobby.ok) throw new Error(String(lobby.error));
  const secret = await createRepo(app, bob, { name: "vault", visibility: "private" });
  if (!secret.ok) throw new Error(String(secret.error));
  const now = Date.now();
  const iso = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
  ask(lobby.value.id, alice, "Newer ask for the lobby", iso(1));
  ask(lobby.value.id, alice, "Older ask for the lobby", iso(2));
  setIssueState(app.db, ask(lobby.value.id, alice, "Already shipped ask", iso(3)).id, "closed");
  ask(secret.value.id, bob, "Secret ask in the vault", iso(1));
  thought(alice, "t1", "make the lobby louder");
  thought(alice, "t2", "hide the vault door");
  thought(bob, "t3", "bob's private idea");
  savePlacement(app.db, {
    thoughtId: "t2", kind: "work", asked: false, decidedBy: "rule", reply: "ok",
    placed: [{ action: "opened", repo: "bob/vault", number: 1 }],
    placedAt: new Date().toISOString(),
  });
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the asked screen", () => {
  test("a signed-in user sees their own thoughts and no one else's", async () => {
    const text = await screenText(alice);
    expect(text).toContain("make the lobby louder");
    expect(text).toContain("hide the vault door");
    expect(text).not.toContain("bob's private idea");
  });

  test("a placement in an unreadable repository shows no slug or state", async () => {
    const text = await screenText(alice);
    expect(text).toContain("→ in a repository you cannot read");
    expect(text).not.toContain("bob/vault");
  });

  test("a guest sees nothing", async () => {
    const text = await screenText();
    expect(text).toContain("Nothing asked yet");
    expect(text).not.toContain("make the lobby louder");
    expect(text).not.toContain("bob's private idea");
  });

  test("asks are unshipped, oldest first, with their address, and an unreadable repository's is absent", () => {
    // Only the asks this file filed up front: other tests file their own.
    const filed = new Set(["Newer ask for the lobby", "Older ask for the lobby", "Already shipped ask", "Secret ask in the vault"]);
    const asks = askedLines(app.db, alice).asks.filter((a) => filed.has(a.title));
    expect(asks.map((a) => a.title)).toEqual(["Older ask for the lobby", "Newer ask for the lobby"]);
    expect(asks[0]!.secondary).toContain("alice/lobby #");
    expect(asks[0]!.secondary).toContain("alice");
    expect(asks[0]!.path).toMatch(/^\/alice\/lobby\/issues\/\d+$/);
    expect(JSON.stringify(askedLines(app.db, alice))).not.toContain("Secret ask");
  });

  test("the screen shows the ask and its address, never the unreadable one", async () => {
    const text = await screenText(alice);
    expect(text).toContain("Older ask for the lobby");
    expect(text).toContain("alice/lobby #");
    expect(text).not.toContain("Already shipped ask");
    expect(text).not.toContain("Secret ask");
  });

  test("an admin sees every ask, a guest none", () => {
    const titles = askedLines(app.db, carol).asks.map((a) => a.title);
    expect(titles).toContain("Secret ask in the vault");
    expect(titles).toContain("Older ask for the lobby");
    expect(askedLines(app.db, undefined)).toEqual({ thoughts: [], asks: [] });
  });

  test("enter on an ask hands over its web address", async () => {
    const { asks, thoughts } = askedLines(app.db, alice);
    const down = "j".repeat(thoughts.length);
    const text = await screenText(alice, `${down}\r`);
    expect(text).toContain(asks[0]!.path!);
  });

  test("r reads again, so a new ask appears", async () => {
    const terminal = headlessTerminal(120, 30);
    const { app: tui, session } = createForgeApp(app, identity(alice), { terminal, exitHooks: false });
    tui.start();
    tui.ctx.push(askedScreen(session, tui.ctx));
    await settleApp(tui);
    const lobby = app.db.query<{ id: string }, []>("SELECT id FROM repo WHERE name = 'lobby'").get()!;
    ask(lobby.id, alice, "Asked while watching", new Date().toISOString());
    expect(tui.screen.toText()).not.toContain("Asked while watching");
    terminal.feed("r");
    await settleApp(tui);
    expect(tui.screen.toText()).toContain("Asked while watching");
    tui.stop?.();
  });

  test("the palette offers the door to the signed in only", () => {
    const ctx = {} as never;
    const ids = (u?: User) => forgeCommands(new Session(app, identity(u)))(ctx).map((c) => c.id);
    expect(ids(alice)).toContain("asked");
    expect(ids()).not.toContain("asked");
  });
  test("a thought says where it went in /asked's words: the issue, the question back, a note, or not yet (#7509)", () => {
    const lobby = app.db.query<{ id: string }, []>("SELECT id FROM repo WHERE name = 'lobby'").get()!;
    const issue = createIssue(app.db, { repoId: lobby.id, authorId: alice.id, title: "Louder lobby" });
    if (!issue.ok) throw new Error(issue.error);
    const n = issue.value.number;
    const placed = (thoughtId: string, reply: string, asked: boolean, number?: number) =>
      savePlacement(app.db, {
        thoughtId, kind: number === undefined ? "decision" : "work", asked, decidedBy: "rule", reply,
        placed: number === undefined ? [] : [{ action: "opened", repo: "alice/lobby", number }],
        placedAt: new Date().toISOString(),
      });
    thought(alice, "t4", "a louder lobby, again");
    thought(alice, "t5", "which one was it");
    thought(alice, "t6", "we like plain words");
    placed("t1", "ok", false, n);
    placed("t4", "ok", false, n);
    linkThoughts(app.db, "t4", "t1", "repeats");
    placed("t5", "Do you mean the lobby or the vault?", true);
    placed("t6", "ok", false);
    thought(alice, "t7", "and a dark theme");

    const by = new Map(askedLines(app.db, alice).thoughts.map((t) => [t.title, t.secondary]));
    expect(by.get("make the lobby louder")).toBe(`→ alice/lobby#${n} Louder lobby`);
    expect(by.get("a louder lobby, again")).toStartWith(`→ alice/lobby#${n} Louder lobby · repeats “make the lobby louder”`);
    expect(by.get("which one was it")).toBe("Do you mean the lobby or the vault?");
    expect(by.get("we like plain words")).toBe("kept as a note");
    expect(by.get("and a dark theme")).toBe("not placed yet");
  });
});
