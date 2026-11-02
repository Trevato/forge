/** The terminal's Labels screen (#7841): a repository's labels with their hex; only for readers. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createLabel } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp, Session } from "../src/tui/forge.ts";
import type { Ctx } from "../src/tui/app/app.ts";
import { labelsCommands, labelsScreen, NOT_FOUND_LINE, NO_LABELS_LINE } from "../src/tui/screens/labels.ts";
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
