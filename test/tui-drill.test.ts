/** The terminal's failure domains screen runs a restore drill with `d` and a confirm (#7298). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { DrillResult } from "../src/snapshot/drill.ts";
import { startSnapshots } from "../src/snapshot/service.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { domainsScreen } from "../src/tui/screens/domains.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let forge: Forge;
let alice: User;
let bob: User;
let runs = 0;
let handle: ReturnType<typeof startSnapshots> | undefined;

const result = (verdict: "green" | "red"): DrillResult => ({
  at: new Date().toISOString(),
  snapshotId: "s1",
  ms: 5,
  counts: { repositories: 0, issues: 0, users: 0, pulls: 0, apps: 0 },
  health: verdict === "green" ? "ok" : "unreached",
  verdict,
  failedStep: verdict === "green" ? null : "fetch",
  phases: [],
  budgetMs: 1000,
  reason: null,
}) as DrillResult;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-drill-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const b = await createUser(forge.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.test", password: "a-long-passphrase" });
  if (!b.ok) throw new Error("bob failed");
  bob = b.value;
});
afterAll(async () => {
  await handle?.stop();
  forge.close?.();
  await rm(dir, { recursive: true, force: true });
});

async function open(user: User) {
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", user },
    { terminal: headlessTerminal(160, 30), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  app.push(domainsScreen(session, app.ctx));
  await settleApp(app);
  const press = async (key: string): Promise<string> => {
    app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
    await settleApp(app);
    return app.screen.toText();
  };
  return { app, press, text: () => app.screen.toText() };
}

test("a non-admin is not offered d and a press asks nothing", async () => {
  const h = await open(bob);
  expect(h.text()).not.toMatch(/d +restore drill/);
  expect(await h.press("d")).not.toContain("Restore the newest snapshot");
  h.app.stop();
});

test("no store says so in words", async () => {
  const h = await open(alice);
  expect(h.text()).toMatch(/d +restore drill/);
  expect(await h.press("d")).toContain("Restore the newest snapshot");
  await h.press("left");
  const text = await h.press("enter");
  expect(text).toContain("This forge has no snapshots to drill.");
  h.app.stop();
});

test("a restore drill says its outcome in words and leaves the domain row alone", async () => {
  let next: "green" | "red" = "green";
  handle = startSnapshots(forge, dirStore(join(dir, "store")), {
    version: "0",
    nightly: false,
    drill: async () => {
      runs++;
      return result(next);
    },
  });
  const h = await open(alice);
  expect(h.text()).toMatch(/The snapshot store +never run/);
  await h.press("d");
  await h.press("left");
  let text = await h.press("enter");
  expect(runs).toBe(1);
  expect(text).toContain("The drill restored green.");
  expect(text).toMatch(/The snapshot store +never run/); // the domain row is the fault drill's, not this one's

  next = "red";
  await h.press("d");
  await h.press("left");
  text = await h.press("enter");
  expect(runs).toBe(2);
  expect(text).toContain("The drill failed at fetch.");
  expect(text).toMatch(/The snapshot store +never run/);
  h.app.stop();
});

test("declining runs nothing", async () => {
  const h = await open(alice);
  const before = runs;
  await h.press("d");
  const text = await h.press("enter"); // defaults to Cancel
  expect(text).not.toContain("restored green");
  expect(runs).toBe(before);
  h.app.stop();
});

test("an admin demoted after load runs nothing", async () => {
  const carol = await createUser(forge.db, { origin: "seed", trusted: true, username: "carol", email: "carol@forge.test", password: "a-long-passphrase" });
  if (!carol.ok) throw new Error("carol failed");
  const user = { ...carol.value, isAdmin: true } as User;
  const h = await open(user);
  expect(h.text()).toMatch(/d +restore drill/);
  const before = runs;
  await h.press("d");
  (user as { isAdmin: boolean }).isAdmin = false;
  await h.press("left");
  const text = await h.press("enter");
  expect(runs).toBe(before);
  expect(text).not.toContain("restored green");
  h.app.stop();
});
