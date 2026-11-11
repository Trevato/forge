/**
 * The forge button's notes in the terminal (#4758): a repository that is an
 * app offers "Tell the builders" and "Notes from the app" in its palette,
 * with the page's gating: a person sees their own, the admin everyone's and
 * may hide or ban; a repository that is not an app offers nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { sendNote, type Sender } from "../src/actions/app_notes.ts";
import { isBanned } from "../src/core/app_notes.ts";
import { getAppBySlug } from "../src/core/apps.ts";
import { addComment, getIssue, labelsFor } from "../src/core/issues.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { repoScreen } from "../src/tui/screens/repo.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settlePalette } from "./helpers/tui.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let bob: User;
let notes: Repo;
let plain: Repo;

async function palette(user: User, repo: Repo, keys: string[]): Promise<string> {
  const terminal = headlessTerminal(120, 40);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
    { terminal, exitHooks: false },
  );
  tui.start();
  tui.ctx.push(repoScreen(session, tui.ctx, local(session, repo)));
  await settleApp(tui);
  for (const k of keys) {
    terminal.feed(k);
    await settlePalette(tui);
  }
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-notes-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  alice = await mk("alice", true);
  bob = await mk("bob");
  proveAll(app);
  const made = await newApp(app, alice, { name: "notes", description: "Words", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  notes = getRepo(app.db, "alice", "notes")!;
  const p = await createRepo(app, alice, { name: "lobby", visibility: "public" });
  if (!p.ok) throw new Error(String(p.error));
  plain = p.value;
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("notes from the app, in the terminal", () => {
  test("only an app's repository has the rows", async () => {
    // Filtered, so the row's presence does not depend on how many others the palette lists.
    expect(await palette(bob, notes, [":", "Tell the"])).toContain("alice/notes — Tell the builders");
    expect(await palette(bob, plain, [":", "Tell the"])).not.toContain("Tell the builders");
  }, 30_000);

  test("a note files a from-app issue as the person", async () => {
    const text = await palette(bob, notes, [":", "Tell the", "\r", ..."the logo is blurry".split(""), "\r"]);
    const row = app.db.query<{ issue_number: number; name: string }, []>("SELECT issue_number, name FROM app_note").get()!;
    // The sender is told the issue's number and where it is.
    expect(text).toContain(`Sent as #${row.issue_number}`);
    expect(text).toContain(`alice/notes/issues/${row.issue_number}`);
    expect(row.name).toBe("@bob");
    const issue = getIssue(app.db, notes.id, row.issue_number)!;
    expect(labelsFor(app.db, issue.id).map((l) => l.name)).toEqual(["from-app"]);
    expect(issue.body).toContain("by @bob.");
  }, 30_000);

  test("a person sees their own with its status; the admin sees all and bans", async () => {
    const number = app.db.query<{ issue_number: number }, []>("SELECT issue_number FROM app_note").get()!.issue_number;
    expect(await palette(bob, notes, [":", "Notes from", "\r"])).toContain(`#${number} the logo is blurry`);
    expect(await palette(alice, notes, [":", "Notes from", "\r"])).toContain("the logo is blurry");
    // alice has none of her own, bob picks and is only told the status; alice bans.
    const asBob = await palette(bob, notes, [":", "Notes from", "\r", "\r"]);
    expect(asBob).not.toContain("Moderate this note");
    const asAlice = await palette(alice, notes, [":", "Notes from", "\r", "\r"]);
    expect(asAlice).toContain("Moderate this note");
    await palette(alice, notes, [":", "Notes from", "\r", "\r", "\x1b[C", "\x1b[C", "\r"]);
    const record = getAppBySlug(app.db, "notes")!;
    expect(isBanned(app.db, record.id, `u:${bob.id}`)).toBe(true);
  }, 30_000);

  test("the admin lists the banned senders and unbans one; a reader has no such row", async () => {
    const record = getAppBySlug(app.db, "notes")!;
    expect(isBanned(app.db, record.id, `u:${bob.id}`)).toBe(true);
    expect(await palette(bob, notes, [":"])).not.toContain("Banned senders");
    const listed = await palette(alice, notes, [":", "Banned", "\r"]);
    expect(listed).toContain("@bob");
    expect(await palette(bob, notes, [":", "Banned", "\r"])).not.toContain("Unban");
    await palette(alice, notes, [":", "Banned", "\r", "\r", "\x1b[C", "\r"]);
    expect(isBanned(app.db, record.id, `u:${bob.id}`)).toBe(false);
    const sender: Sender = { key: `u:${bob.id}`, name: "@bob", person: true };
    const again = await sendNote(app, record, notes, "production", undefined, sender, { text: "back again", page: "", viewport: "unknown" }, "ssh:again");
    expect(again.ok).toBe(true);
    expect(await palette(alice, notes, [":", "Banned", "\r"])).not.toContain("Unban this sender");
  }, 30_000);

  test("a writer's reply shows to the sender on picking the note, and in the admin's moderation body", async () => {
    for (const row of app.db.query<{ issue_number: number }, []>("SELECT issue_number FROM app_note").all())
      addComment(app.db, { issueId: getIssue(app.db, notes.id, row.issue_number)!.id, authorId: alice.id, body: "we are on it" });
    const list = await palette(bob, notes, [":", "Notes from", "\r"]);
    expect(list).toMatch(/#\d+ back again \(\d+ replies?\)/);
    const asBob = await palette(bob, notes, [":", "Notes from", "\r", "\r"]);
    expect(asBob).toContain("alice");
    expect(asBob).toContain("we are on it");
    const asAlice = await palette(alice, notes, [":", "Notes from", "\r", "\r"]);
    expect(asAlice).toContain("Moderate this note");
    expect(asAlice).toContain("we are on it");
  }, 30_000);
});
