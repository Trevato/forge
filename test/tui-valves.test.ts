/** #8698: the valves in the terminal, a forge admin's who is a person; a turn made there reaches everyone live, and only those who may hear it. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { turnValveFor } from "../src/actions/valves.ts";
import { audienceFilter } from "../src/core/event_audience.ts";
import { listEvents } from "../src/core/events.ts";
import { createUser, type User } from "../src/core/users.ts";
import { readLevels } from "../src/flow/valve_store.ts";
import { createForgeApp, forgeCommands } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let bob: User;
let repoId: string;
const identity = (user: User) => ({ sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-valves-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, adminIfFirst: boolean) => {
    const r = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  alice = await mk("alice", true);
  bob = await mk("bob", false);
  const made = await createRepo(app, alice, { name: "vault", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  repoId = made.value.id;
  turnValveFor(app, alice, "alice/vault", 50);
}, 30_000);

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const door = (u: User) => {
  const { app: tui, session } = createForgeApp(app, identity(u), { terminal: headlessTerminal(140, 24), exitHooks: false });
  const ids = forgeCommands(session)(tui.ctx).map((c) => c.id);
  tui.stop?.();
  return ids;
};

test("only an admin who is a person is offered Valves", () => {
  expect(door(alice)).toContain("valves");
  expect(door(bob)).not.toContain("valves");
});

test("a turn made in the terminal is kept, announced, and shown", async () => {
  const { app: tui, session } = createForgeApp(app, identity(alice), { terminal: headlessTerminal(140, 24), exitHooks: false });
  tui.start();
  const press = async (k: string) => {
    tui.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
    await settleApp(tui);
  };
  tui.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
  for (const ch of "Valves") tui.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
  await settleApp(tui);
  await press("enter");
  await settleUntil(tui, "alice/vault", { timeoutMs: 4_000 });
  expect(tui.screen.toText()).toContain("50%");
  await press("h");
  expect(readLevels(app.db).get(repoId)).toBe(40);
  await settleUntil(tui, "40%", { timeoutMs: 4_000 });
  await press("x");
  expect(readLevels(app.db).get(repoId)).toBe(0);
  const turned = listEvents(app.db, { repoId }).filter((e) => e.kind === "valve.turned");
  expect(turned.length).toBeGreaterThanOrEqual(3);
  tui.stop?.();
  expect(session.user?.id).toBe(alice.id);
});

test("a turn elsewhere reaches an open screen live", async () => {
  const { app: tui } = createForgeApp(app, identity(alice), { terminal: headlessTerminal(140, 24), exitHooks: false });
  tui.start();
  tui.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
  for (const ch of "Valves") tui.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
  await settleApp(tui);
  tui.dispatch({ type: "key", key: "enter", ctrl: false, alt: false, shift: false });
  await settleUntil(tui, "alice/vault  0%", { timeoutMs: 4_000 });
  turnValveFor(app, alice, "alice/vault", 70);
  await settleUntil(tui, "alice/vault  70%", { timeoutMs: 4_000 });
  tui.stop?.();
});

test("valve.turned names a repository, so only those who administer it hear it", () => {
  const all = listEvents(app.db, { repoId }).filter((e) => e.kind === "valve.turned");
  expect(all.length).toBeGreaterThan(0);
  expect(all.filter(audienceFilter(app.db, bob))).toEqual([]);
  expect(all.filter(audienceFilter(app.db, undefined))).toEqual([]);
  expect(all.filter(audienceFilter(app.db, alice)).length).toBe(all.length);
});
