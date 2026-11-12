/** The terminal's explorer pages with `n` when the answer has a next cursor (#11474). */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import * as explore from "../src/actions/explore.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let forge: Forge;
let alice: User;
const COUNT = 61;
const pad = (i: number): string => `app${String(i).padStart(2, "0")}`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-paging-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const u = await createUser(forge.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!u.ok) throw new Error(u.error);
  proveAll(forge);
  promote(forge.db, u.value);
  alice = u.value;
  for (let i = 1; i <= COUNT; i++) {
    const made = await createRepo(forge, alice, { name: pad(i), visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const rec = insertApp(forge.db, { repoId: made.value.id, slug: `alice-${pad(i)}`, access: "public" });
    if (!rec.ok) throw new Error(rec.error);
  }
});

afterAll(async () => {
  forge.close();
  await rm(dir, { recursive: true, force: true });
});

async function session(line: string, keys: string[], rows = 90): Promise<string> {
  const terminal = headlessTerminal(160, rows);
  const { app } = createForgeApp(
    forge,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: alice },
    { terminal, exitHooks: false },
  );
  app.start();
  await settleApp(app);
  const press = (key: string): void => app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
  press("/");
  for (const ch of line) press(ch);
  await settleApp(app);
  for (const k of keys) {
    press(k);
    await settleApp(app);
  }
  const text = app.screen.toText();
  app.stop();
  return text;
}

const shownApps = (text: string): number => new Set(text.match(/alice\/app\d\d/g) ?? []).size;

test("61 rows give a first page of 60 and a line; n adds the rest and the line goes", async () => {
  const first = await session("kind:app sort:name", ["enter"]);
  expect(shownApps(first)).toBe(60);
  expect(first).toContain("more results — n");
  expect(first).not.toContain("alice/app61");

  const second = await session("kind:app sort:name", ["enter", "n"]);
  expect(shownApps(second)).toBe(61);
  expect(second).toContain("alice/app61");
  expect(second).not.toContain("more results");
});

test("a short list shows no line, and n there is not a page", async () => {
  const text = await session("kind:app sort:name owner:nobody", ["enter", "n"]);
  expect(text).not.toContain("more results");
  // `n` was not a page: it is still the new-repo key.
  expect(text).toContain("New repository");
});

/** Answer the first call for real and the next ones as `later` says. */
async function withLater(later: () => Promise<never>, keys: string[], rows?: number): Promise<{ text: string; calls: number }> {
  const real = explore.explorePage;
  let calls = 0;
  const spy = spyOn(explore, "explorePage").mockImplementation((...args) => {
    calls++;
    return args[3] === null ? real(...args) : later();
  });
  try {
    const text = await session("kind:app sort:name", keys, rows);
    return { text, calls };
  } finally {
    spy.mockRestore();
  }
}

test("a cursor the forge refuses shows the first page again with one plain line", async () => {
  const { text } = await withLater(async () => null as never, ["enter", "n"]);
  expect(text).toContain("that page is no longer there — showing the first page");
  expect(shownApps(text)).toBe(60);
  expect(text).not.toContain("alice/app61");
  expect(text).toContain("more results — n");
});

test("a failed fetch keeps the rows and says to try again, not that the page is gone", async () => {
  const { text } = await withLater(async () => { throw new Error("boom"); }, ["enter", "n"]);
  expect(text).toContain("could not fetch more results — n to retry");
  expect(text).not.toContain("no longer there");
  expect(shownApps(text)).toBe(60);
});

test("on a short terminal the more-results line still has its row", async () => {
  const text = await session("kind:app sort:name", ["enter"], 14);
  expect(text).toContain("more results — n");
});
