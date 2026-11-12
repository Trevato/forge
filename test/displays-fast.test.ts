/**
 * `/displays` answers inside its budget even when the display cache is cold
 * (#11007): the cold read is two git processes per repository on the forge,
 * so the page waits `LIST_WAIT_MS` at most and answers with what is kept.
 * Also: the page says what a display is. Counted, never timed.
 */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { DISPLAYS_NOTE, DISPLAYS_READING, DISPLAYS_SENTENCE, knownDisplays, listedDisplaysWithin, warmDisplays, type ListedDisplay } from "../src/display/known.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { displaysScreen } from "../src/tui/screens/displays.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { LIST_WAIT_MS, listWait } from "../src/web/pages/displays.ts";
import { settleApp } from "./helpers/tui.ts";
import { proveAll } from "./helpers/verified.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let bob: User;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-displays-fast-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
  const other = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!other.ok) throw new Error(other.error);
  bob = other.value;
  proveAll(app);
  for (let i = 0; i < 12; i++) {
    const r = await createRepo(app, alice, { name: `r${i}`, visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
  }
  const c = await commitToBranch(app, alice, getRepo(app.db, "alice", "r0")!, {
    message: "display",
    files: [{ path: "display.json", content: JSON.stringify({ title: "Shelf one", layout: "shelf", sources: ["alice/r1"] }) }],
  });
  if (!c.ok) throw new Error(JSON.stringify(c.error));
  const secret = await createRepo(app, alice, { name: "secret", visibility: "private" });
  if (!secret.ok) throw new Error(String(secret.error));
  const s = await commitToBranch(app, alice, getRepo(app.db, "alice", "secret")!, {
    message: "display",
    files: [{ path: "display.json", content: JSON.stringify({ title: "Private shelf", layout: "grid", sources: ["alice/secret"] }) }],
  });
  if (!s.ok) throw new Error(JSON.stringify(s.error));
});

afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

/** An app on the same data with nothing kept: the cold forge. */
const coldApp = () => createApp({ dataDir, port: 0 });
const gitCalls = (calls: unknown[][]) =>
  calls.filter((c) => {
    const first = c[0];
    const argv = Array.isArray(first) ? first : (first as { cmd?: unknown } | undefined)?.cmd;
    return Array.isArray(argv) && /(^|\/)git$/.test(String(argv[0]));
  }).length;

test("a cold list that cannot finish in time answers with what is kept, and the later call has the row", async () => {
  const cold = coldApp();
  const early = await listedDisplaysWithin(cold, alice, 0);
  expect(early.complete).toBe(false);
  expect(early.rows).toEqual([]);
  const later = await listedDisplaysWithin(cold, alice, 60_000);
  expect(later.complete).toBe(true);
  expect(later.rows.map((d) => `${d.repo.ownerName}/${d.repo.name}`).sort()).toEqual(["alice/r0", "alice/secret"]);
  expect(later.rows[0]!.demos).toBe(0);
});

test("a cold, empty answer says it is still reading, links Reload, and never says No displays", async () => {
  const cold = coldApp();
  const srv = await serve(cold);
  listWait.ms = 0;
  const cookie = () => ({ cookie: `forge_session=${createSession(cold.db, alice.id).token}` });
  try {
    const res = await fetch(`${srv.url}/displays`, { headers: cookie() });
    const page = await res.text();
    expect(res.status).toBe(200);
    expect(page).toContain(DISPLAYS_SENTENCE);
    expect(page).toContain('data-by="displays-reading"');
    expect(page).toMatch(/data-by="displays-reading"[^]*?<a href="\/displays">Reload<\/a>/);
    expect(page).not.toContain("No displays");
    expect(page).not.toContain('data-display="');
    // Once read, the notice is gone and the row is there.
    await listedDisplaysWithin(cold, alice, 60_000);
    const full = await (await fetch(`${srv.url}/displays`, { headers: cookie() })).text();
    expect(full).not.toContain('data-by="displays-reading"');
    expect(full).not.toContain(">Reload<");
    expect(full).toContain('data-display="alice/r0"');
  } finally {
    listWait.ms = LIST_WAIT_MS;
    await srv.stop();
  }
});

test("a warmed list reads no git", async () => {
  const warmed = coldApp();
  await warmDisplays(warmed);
  const spawn = spyOn(Bun, "spawn");
  const spawnSync = spyOn(Bun, "spawnSync");
  try {
    const got = await listedDisplaysWithin(warmed, alice, 60_000);
    expect(got.complete).toBe(true);
    expect(got.rows).toHaveLength(2);
    expect(gitCalls(spawn.mock.calls) + gitCalls(spawnSync.mock.calls)).toBe(0);
  } finally {
    spawn.mockRestore();
    spawnSync.mockRestore();
  }
});

test("what is kept hides a private repository's display from a non-reader", async () => {
  const warmed = coldApp();
  await warmDisplays(warmed);
  const names = (u: User) => knownDisplays(warmed, u).rows.map((d) => `${d.repo.ownerName}/${d.repo.name}`).sort();
  expect(knownDisplays(warmed, bob).complete).toBe(true);
  expect(names(alice)).toEqual(["alice/r0", "alice/secret"]);
  expect(names(bob)).toEqual(["alice/r0"]);
  expect(knownDisplays(warmed, undefined).rows.map((d) => d.repo.name)).toEqual(["r0"]);
});

test("the terminal at 80 columns shows the whole sentence over two rows, and a cold screen says it is reading, then fills in", async () => {
  const cold = coldApp();
  listWait.ms = 0;
  let release: (rows: ListedDisplay[]) => void = () => undefined;
  const held = new Promise<ListedDisplay[]>((resolve) => {
    release = resolve;
  });
  const { app: tui, session } = createForgeApp(
    cold,
    { sshUsername: alice.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: alice },
    { terminal: headlessTerminal(80, 24), exitHooks: false },
  );
  try {
    tui.start();
    tui.ctx.push(displaysScreen(session, tui.ctx, () => held));
    await settleApp(tui);
    const first = tui.screen.toText();
    // The sentence's last words are on screen, not cut at the width.
    expect(first).toContain("open full screen.");
    expect(first.replace(/\s+/g, " ")).toContain(DISPLAYS_SENTENCE.split(" ").slice(0, 6).join(" "));
    // Cold, and the rest still held: the screen says it is reading, and not that there are none.
    expect(first).toContain(DISPLAYS_READING);
    expect(first).not.toContain(DISPLAYS_NOTE);
    release((await listedDisplaysWithin(cold, alice, 60_000)).rows);
    await settleApp(tui);
    const later = tui.screen.toText();
    expect(later).toContain("alice/r0");
    expect(later).not.toContain(DISPLAYS_READING);
  } finally {
    tui.stop?.();
    listWait.ms = LIST_WAIT_MS;
  }
});
