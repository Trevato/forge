/**
 * The adapter's terminal door (#10037) is gated like the page: owner facts
 * (`canSeeOwnerFacts`) only. A guest or a signed-in outsider gets no palette
 * entry and, were the screen reached, no rows; the owner gets both.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createApp as createAppRecord, getAppByRepo } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { recordPull } from "../src/apps/pull.ts";
import { shownRuns, type AdapterFacts } from "../src/apps/adapter_facts.ts";
import { PULL_NOW_REFUSALS } from "../src/actions/app_pull.ts";
import type { Ctx } from "../src/tui/app/app.ts";
import type { Session } from "../src/tui/session.ts";
import { theme } from "../src/tui/ui/theme.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { adapterCommands, adapterScreen } from "../src/tui/screens/adapter.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

let dir: string;
let app: App;
let olive: User;
let otto: User;
let repo: Repo;

const facts: AdapterFacts = {
  spec: { schedule: { every: 900 }, source: { name: "Shop API", hosts: ["api.shop.example"] } },
  last: undefined,
  cursor: "c-secret-9",
  runs: [
    { id: "r1", at: "2026-11-09T10:00:00.000Z", durationMs: 5, state: "failed", error: "upstream said no", written: 0, skipped: 0, failed: 0, cursor: null, repeat: false },
  ],
};

async function mk(username: string, first = false): Promise<User> {
  const r = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username,
    email: `${username}@forge.local`,
    password: "a-good-passphrase",
    adminIfFirst: first,
  });
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-adapter-tui-"));
  app = createApp({ dataDir: dir, port: 0 });
  await mk("siteadmin", true); // the site admin, so neither below is one
  olive = await mk("olive");
  otto = await mk("otto");
  proveAll(app);
  promote(app.db, olive, otto);
  const made = await createRepo(app, olive, { name: "shop", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  const record = createAppRecord(app.db, { repoId: repo.id, slug: "shop", access: "public" });
  if (!record.ok) throw new Error(String(record.error));
});

afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

async function look(user: User | undefined) {
  const terminal = headlessTerminal(100, 20);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: user?.username ?? "guest", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", ...(user ? { user } : {}) },
    { terminal, exitHooks: false },
  );
  tui.start();
  let read = 0;
  const commands = adapterCommands(session, tui.ctx, repo);
  tui.ctx.push(adapterScreen(session, tui.ctx, repo, async () => (read++, facts)));
  await settleApp(tui);
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop?.();
  return { commands, text, read };
}

test("the owner gets the palette entry and the rows", async () => {
  const seen = await look(olive);
  expect(seen.commands.map((c) => c.id)).toEqual(["adapter"]);
  expect(seen.text).toContain("Shop API");
  expect(seen.text).toContain("c-secret-9");
  expect(seen.text).toContain("Pull runs");
  expect(seen.text).toContain("failed 0 written, 0 skipped, 0 failed · upstream said no");
});

test("the runs are the last ten and no more", () => {
  const record = getAppByRepo(app.db, repo.id);
  if (record === undefined) throw new Error("no app");
  for (let i = 0; i < 12; i++) recordPull(app.db, record.id, { ok: false, reason: `boom ${i}`, durationMs: 1 });
  const shown = shownRuns(app.db, record.id);
  expect(shown.length).toBe(10);
  expect(shown[0]?.error).toBe("boom 11");
});

test("a signed-in outsider gets no entry, and the screen reads nothing", async () => {
  const seen = await look(otto);
  expect(seen.commands).toEqual([]);
  expect(seen.read).toBe(0);
  expect(seen.text).not.toContain("Shop API");
  expect(seen.text).not.toContain("c-secret-9");
  expect(seen.text).not.toContain("upstream said no");
});

test("a guest gets no entry, and the screen reads nothing", async () => {
  const seen = await look(undefined);
  expect(seen.commands).toEqual([]);
  expect(seen.read).toBe(0);
  expect(seen.text).not.toContain("c-secret-9");
  expect(seen.text).not.toContain("upstream said no");
});

// Pull now (#10126): one key for a writer, none for anyone else.
function press(user: User, pull: Parameters<typeof adapterScreen>[4], reads: { n: number }) {
  const toasts: string[] = [];
  const ctx = {
    theme: theme("dark"),
    invalidate() {},
    toast: (t: string) => toasts.push(t),
  } as unknown as Ctx;
  const f = { app, db: app.db, user } as unknown as Session;
  const screen = adapterScreen(f, ctx, repo, async () => (reads.n++, facts), pull);
  return { screen, toasts, send: (k: string) => screen.key({ key: k } as never) };
}
const settle = () => new Promise((r) => setTimeout(r, 10));

test("a writer sees the p key, pulls now, and the rows are read again", async () => {
  const reads = { n: 0 };
  const calls: string[] = [];
  const run = { state: "ok" } as never;
  const t = press(olive, async (_a, actor) => (calls.push(actor!.username), { ok: true, value: run }), reads);
  expect(t.screen.keys.map((b) => b.keys[0])).toEqual(["p"]);
  expect(t.send("p")).toBe(true);
  await settle();
  expect(calls).toEqual(["olive"]);
  expect(reads.n).toBe(2);
  expect(t.toasts).toEqual(["pulled: ok"]);
});

test("a refusal shows its sentence", async () => {
  const t = press(olive, async () => ({ ok: false, error: "asleep" }), { n: 0 });
  t.send("p");
  await settle();
  expect(t.toasts).toEqual([PULL_NOW_REFUSALS.asleep]);
});

test("a reader is shown no key and p does nothing", async () => {
  const calls: number[] = [];
  const t = press(otto, async () => (calls.push(1), { ok: false, error: "forbidden" }), { n: 0 });
  expect(t.screen.keys).toEqual([]);
  expect(t.send("p")).toBe(false);
  await settle();
  expect(calls).toEqual([]);
  expect(t.toasts).toEqual([]);
});

test("j scrolls the runs when they overflow, and the facts stay", async () => {
  const many = { ...facts, runs: Array.from({ length: 10 }, (_, i) => ({ ...facts.runs![0]!, id: `r${i}`, error: `boom ${i}` })) };
  const terminal = headlessTerminal(100, 12);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: olive.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: olive },
    { terminal, exitHooks: false },
  );
  tui.start();
  const screen = adapterScreen(session, tui.ctx, repo, async () => many);
  tui.ctx.push(screen);
  await settleApp(tui);
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("boom 0");
  for (let i = 0; i < 3; i++) expect(screen.key?.({ key: "j" } as never)).toBe(true);
  tui.ctx.invalidate();
  await settleApp(tui);
  const text = tui.screen.toText();
  expect(text).not.toContain("boom 0");
  expect(text).toContain("Shop API");
  tui.stop?.();
});
