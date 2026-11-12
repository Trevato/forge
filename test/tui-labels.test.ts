/** The terminal's Labels screen (#7841): a repository's labels with their hex; only for readers. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo, deleteLabel } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { LABEL_WORDS } from "../src/actions/label_words.ts";
import { createIssue, labelsFor, setIssueLabels, createLabel, listLabels } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp, Session } from "../src/tui/forge.ts";
import type { Ctx } from "../src/tui/app/app.ts";
import { DELETED_LINE, GONE_LINE, labelsCommands, labelsScreen, NOT_ALLOWED_LINE, NOT_FOUND_LINE, NO_LABELS_LINE } from "../src/tui/screens/labels.ts";
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

async function deleting(repo: Repo, user: User | undefined, keys: string[], beforeLast?: () => void) {
  const terminal = headlessTerminal(100, 30);
  const { app: tui, session } = createForgeApp(app, user ? { ...guest, user } : guest, { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(labelsScreen(session, tui.ctx, repo));
  await settleApp(tui);
  const press = (key: string) => tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
  keys.forEach((k, i) => {
    if (i === keys.length - 1) beforeLast?.();
    press(k);
  });
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

test("d asks naming the label; cancel is the default and keeps it", async () => {
  const mid = await deleting(many, alice, ["d"]);
  expect(mid).toContain("l00");
  expect(mid).toContain("Delete the label l00?");
  const text = await deleting(many, alice, ["d", "enter"]);
  expect(text).not.toContain(DELETED_LINE);
  expect(listLabels(app.db, many.id).map((l) => l.name)).toContain("l00");
});

test("d then Delete removes the label and the list drops it", async () => {
  createLabel(app.db, open.id, "aaa-doomed", "123456");
  const text = await deleting(open, alice, ["d", "right", "enter"]);
  expect(text).toContain(DELETED_LINE);
  expect(text).not.toContain("aaa-doomed");
  expect(listLabels(app.db, open.id).map((l) => l.name)).not.toContain("aaa-doomed");
});

test("the result line clears on the next key", async () => {
  createLabel(app.db, open.id, "aac-doomed", "123456");
  const text = await deleting(open, alice, ["d", "right", "enter", "j"]);
  expect(text).not.toContain(DELETED_LINE);
});

test("a delete that fails says so and changes nothing", async () => {
  const doomed = createLabel(app.db, open.id, "aab-gone", "123456");
  if (!doomed.ok) throw new Error("label");
  const text = await deleting(open, alice, ["d", "right", "enter"], () => {
    deleteLabel(app, alice, open, doomed.value.id);
  });
  expect(text).toContain(GONE_LINE);
  expect(text).not.toContain(DELETED_LINE);
});

test("a reader is not offered d and d deletes nothing", async () => {
  const stranger = new Session(app, guest);
  const ctx = { invalidate() {}, push() { throw new Error("pushed"); } } as unknown as Ctx;
  const screen = labelsScreen(stranger, ctx, open);
  expect(screen.keys.some((k) => k.keys.includes("d"))).toBe(false);
  await screen.load!(new AbortController().signal);
  expect(screen.key!({ type: "key", key: "d", ctrl: false, alt: false, shift: false } as never)).toBe(false);
  expect(labelsScreen(new Session(app, { ...guest, user: alice }), ctx, open).keys.some((k) => k.keys.includes("d"))).toBe(true);
});

async function editing(repo: Repo, user: User | undefined, keys: string[]) {
  const terminal = headlessTerminal(100, 30);
  const { app: tui, session } = createForgeApp(app, user ? { ...guest, user } : guest, { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(labelsScreen(session, tui.ctx, repo));
  await settleApp(tui);
  for (const k of keys) tui.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

const BACK = Array(20).fill("backspace");

test("e opens the form prefilled; an admin renames and recolours, and the issue still carries it", async () => {
  const r = await createRepo(app, alice, { name: "editing", visibility: "public" });
  if (!r.ok) throw new Error("repo");
  const label = createLabel(app.db, r.value.id, "zeta", "123456");
  if (!label.ok) throw new Error("label");
  const issue = createIssue(app.db, { repoId: r.value.id, authorId: alice.id, title: "carries it" });
  if (!issue.ok) throw new Error("issue");
  setIssueLabels(app.db, issue.value.id, [label.value.id]);
  const mid = await editing(r.value, alice, ["e"]);
  expect(mid).toContain("zeta 123456");
  const text = await editing(r.value, alice, ["e", ...BACK, ..."alpha #00ff00", "enter"]);
  expect(text).toContain("alpha");
  expect(text).toContain("#00ff00");
  expect(text).not.toContain("zeta");
  const after = listLabels(app.db, r.value.id);
  expect(after.map((l) => [l.id, l.name, l.color])).toEqual([[label.value.id, "alpha", "00ff00"]]);
  expect(labelsFor(app.db, issue.value.id).map((l) => l.name)).toEqual(["alpha"]);
});

test("a taken name is refused in place and keeps what was typed", async () => {
  const text = await editing(open, alice, ["e", ...BACK, ..."docs 111111", "enter"]);
  expect(text).toContain(LABEL_WORDS.taken);
  expect(text).toContain("docs 111111");
  expect(listLabels(app.db, open.id).find((l) => l.name === "bug")?.color).toBe("d73a4a");
});

test("a reader is not offered e and e opens nothing", async () => {
  const stranger = new Session(app, guest);
  const ctx = { invalidate() {}, push() { throw new Error("pushed"); } } as unknown as Ctx;
  const screen = labelsScreen(stranger, ctx, open);
  expect(screen.keys.some((k) => k.keys.includes("e"))).toBe(false);
  await screen.load!(new AbortController().signal);
  expect(screen.key!({ type: "key", key: "e", ctrl: false, alt: false, shift: false } as never)).toBe(false);
  expect(labelsScreen(new Session(app, { ...guest, user: alice }), ctx, open).keys.some((k) => k.keys.includes("e"))).toBe(true);
});

test("a label deleted under the open form says it is gone and changes nothing", async () => {
  const r = await createRepo(app, alice, { name: "vanish", visibility: "public" });
  if (!r.ok) throw new Error("repo");
  const label = createLabel(app.db, r.value.id, "ghost", "123456");
  if (!label.ok) throw new Error("label");
  const terminal = headlessTerminal(100, 30);
  const { app: tui, session } = createForgeApp(app, { ...guest, user: alice }, { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(labelsScreen(session, tui.ctx, r.value));
  await settleApp(tui);
  const press = (key: string) => tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
  press("e");
  press("backspace");
  press("9");
  deleteLabel(app, alice, r.value, label.value.id);
  press("enter");
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop?.();
  expect(text).toContain(LABEL_WORDS.gone);
  expect(text).not.toContain(NOT_ALLOWED_LINE);
  expect(listLabels(app.db, r.value.id)).toEqual([]);
});

test("an admin demoted under the open form is told so and the label is unchanged", async () => {
  const r = await createRepo(app, alice, { name: "demoted", visibility: "public" });
  if (!r.ok) throw new Error("repo");
  createLabel(app.db, r.value.id, "keep", "123456");
  const terminal = headlessTerminal(100, 30);
  const { app: tui, session } = createForgeApp(app, { ...guest, user: alice }, { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(labelsScreen(session, tui.ctx, r.value));
  await settleApp(tui);
  const press = (key: string) => tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
  press("e");
  press("backspace");
  press("9");
  (session as { user: User | undefined }).user = undefined;
  press("enter");
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop?.();
  expect(text).toContain(NOT_ALLOWED_LINE);
  expect(text).not.toContain(LABEL_WORDS.gone);
  expect(listLabels(app.db, r.value.id).map((l) => l.name)).toEqual(["keep"]);
});

test("an admin sees N open / unused per label and the delete confirm names the count; a reader sees neither", async () => {
  const r = await createRepo(app, alice, { name: "counted", visibility: "public" });
  if (!r.ok) throw new Error("repo");
  const repo = r.value;
  const used = createLabel(app.db, repo.id, "used", "112233");
  createLabel(app.db, repo.id, "idle", "445566");
  const made = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title: "t" });
  if (!used.ok || !made.ok) throw new Error("setup");
  setIssueLabels(app.db, made.value.id, [used.value.id]);
  const admin = await screenText(repo, alice);
  expect(admin).toContain("1 open");
  expect(admin).toContain("unused");
  const asked = await screenText(repo, alice, ["j", "d"]);
  expect(asked).toContain("1 open carry it");
  const reader = await screenText(repo);
  expect(reader).not.toContain("1 open");
  expect(reader).not.toContain("unused");
});
