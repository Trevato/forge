/** The terminal's Labels screen (#7841): a repository's labels with their hex; only for readers. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { LABEL_WORDS } from "../src/actions/label_words.ts";
import { createLabel, listLabels } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp, Session } from "../src/tui/forge.ts";
import type { Ctx } from "../src/tui/app/app.ts";
import { labelsCommands, labelsScreen, NOT_ALLOWED_LINE, NOT_FOUND_LINE, NO_LABELS_LINE } from "../src/tui/screens/labels.ts";
import { repoScreen } from "../src/tui/screens/repo.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let open: Repo;
let secret: Repo;
let bare: Repo;
let many: Repo;
let alice: User;
const guest = { sshUsername: "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test" };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-labels-"));
  app = createApp({ dataDir: dir, port: 0 });
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@f.dev",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
  const mk = async (name: string, visibility: "public" | "private") => {
    const repo = await createRepo(app, made.value, { name, visibility });
    if (!repo.ok) throw new Error(JSON.stringify(repo.error));
    return repo.value;
  };
  open = await mk("lab", "public");
  secret = await mk("secret", "private");
  bare = await mk("bare", "public");
  many = await mk("many", "public");
  for (let i = 0; i < 40; i++) createLabel(app.db, many.id, `l${String(i).padStart(2, "0")}`, "123456");
  for (const r of [open, secret]) {
    createLabel(app.db, r.id, r === open ? "bug" : "hidden-label", r === open ? "d73a4a" : "00ff00");
  }
  createLabel(app.db, open.id, "docs", "0075ca");
}, 60_000);

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

async function screenText(repo: Repo, user?: User, keys: string[] = []): Promise<string> {
  const terminal = headlessTerminal(100, 30);
  const { app: tui, session } = createForgeApp(app, user ? { ...guest, user } : guest, { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(labelsScreen(session, tui.ctx, repo));
  await settleApp(tui);
  for (const key of keys) tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

test("a reader sees each label with its hex, in name order", async () => {
  const text = await screenText(open);
  expect(text).toContain("bug");
  expect(text).toContain("#d73a4a");
  expect(text).toContain("#0075ca");
  expect(text.indexOf("bug")).toBeLessThan(text.indexOf("docs"));
});

test("a non-member opening a private repository's screen gets No such repository and no label", async () => {
  const text = await screenText(secret);
  expect(text).toContain(NOT_FOUND_LINE);
  expect(text).not.toContain("hidden-label");
  expect(text).not.toContain("#00ff00");
});

test("the command is offered to a reader and not for a repository the viewer cannot read", () => {
  const ctx = {} as Ctx;
  const stranger = new Session(app, guest);
  expect(labelsCommands(stranger, ctx, open).map((c) => c.id)).toEqual(["labels"]);
  expect(labelsCommands(stranger, ctx, secret)).toEqual([]);
  expect(labelsCommands(stranger, ctx, undefined)).toEqual([]);
});

test("the repository screen's commands carry Labels, and running it opens the screen", async () => {
  const terminal = headlessTerminal(100, 30);
  const { app: tui, session } = createForgeApp(app, guest, { terminal, exitHooks: false });
  tui.start();
  const screen = repoScreen(session, tui.ctx, local(session, open));
  tui.ctx.push(screen);
  await settleApp(tui);
  const command = screen.commands?.().find((c) => c.id === "labels");
  expect(command?.title).toBe("alice/lab — Labels");
  command!.run();
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop?.();
  expect(text).toContain("#d73a4a");
});

test("the owner opening the private repository's screen sees its labels", async () => {
  const text = await screenText(secret, alice);
  expect(text).toContain("hidden-label");
  expect(text).toContain("#00ff00");
  expect(text).not.toContain(NOT_FOUND_LINE);
});

test("a repository with no labels says so", async () => {
  expect(await screenText(bare)).toContain(NO_LABELS_LINE);
});

test("j moves a visible > marker and scrolls later labels into view", async () => {
  const first = await screenText(many);
  expect(first).toContain("> ");
  expect(first).toContain("l00");
  expect(first).not.toContain("l39");
  const text = await screenText(many, undefined, Array(39).fill("j"));
  expect(text).toContain("l39");
  expect(text).not.toContain("l00");
  expect(text.split("\n").find((l) => l.includes("l39"))).toContain(">");
});

/** label.created events on the bus for a repository: how web viewers hear of the write. */
const created = (repo: Repo): number =>
  app.db
    .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM event WHERE repo_id = ?1 AND kind = 'label.created'")
    .get(repo.id)!.n;

async function typed(repo: Repo, user: User | undefined, entry: string): Promise<string> {
  const terminal = headlessTerminal(100, 30);
  const { app: tui, session } = createForgeApp(app, user ? { ...guest, user } : guest, { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(labelsScreen(session, tui.ctx, repo));
  await settleApp(tui);
  const press = (key: string) => tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
  press("n");
  for (const ch of entry) press(ch);
  press("enter");
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

test("an admin makes a label with n and the list shows it at once", async () => {
  const before = created(bare);
  const text = await typed(bare, alice, "bug d73a4a");
  expect(created(bare)).toBe(before + 1);
  expect(text).toContain("#d73a4a");
  expect(text).not.toContain(NO_LABELS_LINE);
  expect(listLabels(app.db, bare.id).map((l) => l.name)).toEqual(["bug"]);
});

test("a bad colour shows the LABEL_WORDS text and makes nothing", async () => {
  const text = await typed(open, alice, "wontfix zzz");
  expect(text).toContain(LABEL_WORDS.shape);
  expect(listLabels(app.db, open.id).map((l) => l.name)).not.toContain("wontfix");
});

test("a taken name says so and makes nothing", async () => {
  const text = await typed(open, alice, "bug 111111");
  expect(text).toContain(LABEL_WORDS.taken);
  expect(listLabels(app.db, open.id).filter((l) => l.name === "bug")).toHaveLength(1);
});

test("a reader is not offered n and n makes nothing", async () => {
  const stranger = new Session(app, guest);
  const ctx = { invalidate() {}, push() { throw new Error("pushed"); } } as unknown as Ctx;
  const screen = labelsScreen(stranger, ctx, open);
  expect(screen.keys.some((k) => k.keys.includes("n"))).toBe(false);
  await screen.load!(new AbortController().signal);
  expect(screen.key!({ type: "key", key: "n", ctrl: false, alt: false, shift: false } as never)).toBe(false);
  const admin = labelsScreen(new Session(app, { ...guest, user: alice }), ctx, open);
  expect(admin.keys.some((k) => k.keys.includes("n"))).toBe(true);
});

test("a write by someone no longer admin is refused with its own words, not the shape text", async () => {
  const terminal = headlessTerminal(100, 30);
  const { app: tui, session } = createForgeApp(app, { ...guest, user: alice }, { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(labelsScreen(session, tui.ctx, many));
  await settleApp(tui);
  const before = created(many);
  const press = (key: string) => tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
  press("n");
  for (const ch of "sneaky 123456") press(ch);
  (session as { user: User | undefined }).user = undefined; // demoted mid-prompt
  press("enter");
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop?.();
  expect(text).toContain(NOT_ALLOWED_LINE);
  expect(text).not.toContain(LABEL_WORDS.shape);
  expect(listLabels(app.db, many.id).map((l) => l.name)).not.toContain("sneaky");
  expect(created(many)).toBe(before);
  // and the key bar follows the role
  expect(labelsScreen(session, tui.ctx, many).keys.some((k) => k.keys.includes("n"))).toBe(false);
});

test("a # before the colour and a name of several words are accepted", async () => {
  const text = await typed(bare, alice, "good first issue #7057ff");
  expect(text).toContain("good first issue");
  expect(text).toContain("#7057ff");
  expect(listLabels(app.db, bare.id).map((l) => l.name)).toContain("good first issue");
});
