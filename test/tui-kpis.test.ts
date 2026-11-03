/** The terminal's first screen carries the figures the web home does (#2871): an admin sees them; nobody else does. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { readVitals, vitalsLine } from "../src/flow/vitals.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

let dir: string;
let forge: Forge;
let alice: User;
let bob: User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-kpis-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(forge, { username: "alice", email: "a@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const b = await createUser(forge.db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "b@forge.test",
    password: "a-long-passphrase",
  });
  if (!b.ok) throw new Error(b.error);
  bob = b.value;
});

afterAll(async () => {
  forge.close();
  await rm(dir, { recursive: true, force: true });
});

async function firstScreen(user?: User, host: Forge = forge): Promise<string> {
  const terminal = headlessTerminal(200, 32);
  const { app } = createForgeApp(
    host,
    { sshUsername: user?.username ?? "guest", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", ...(user ? { user } : {}) },
    { terminal, exitHooks: false },
  );
  app.start();
  await settleApp(app);
  const text = app.screen.toText();
  app.stop();
  return text;
}

async function withCommit<T>(commit: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = { c: process.env["FORGE_COMMIT"], a: process.env["FORGE_APP_COMMIT"] };
  delete process.env["FORGE_APP_COMMIT"];
  if (commit === undefined) delete process.env["FORGE_COMMIT"];
  else process.env["FORGE_COMMIT"] = commit;
  try {
    return await fn();
  } finally {
    for (const [k, v] of [["FORGE_COMMIT", saved.c], ["FORGE_APP_COMMIT", saved.a]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("the terminal's first screen shows the three figures; a non-admin and a guest have none", async () => {
  const text = await withCommit(undefined, () => firstScreen(alice));
  expect(text).toContain("Shipped per hour 0.0");
  expect(text).toContain("Live version — nothing live yet");
  expect(text).toContain("Median check time —");
  expect(await firstScreen(bob)).not.toContain("Shipped per hour");
  expect(await firstScreen()).not.toContain("Shipped per hour");
});

test("the live figure is the running commit, as /releases shows it", async () => {
  const text = await withCommit("1234567abcdef", () => firstScreen(alice));
  expect(text).toContain("Live version 1234567, live");
});

test("the admin's figures carry the configured daily ceiling, and say so when there is none", async () => {
  const capped = { ...forge, config: { ...forge.config, crewCeilingUsd: 40 } };
  expect(await firstScreen(alice, capped)).toContain("Crew spend today $0.00 of $40");
  expect(await firstScreen(alice)).toContain("Crew spend today $0.00, no forge ceiling");
  expect(await firstScreen(alice)).toContain("Reporting browsers 0 today, 0 in 7 days");
});

test("past the forge cap the terminal and the web tile read the same words", async () => {
  const { spendCeilingWords } = await import("../src/flow/kpi_words.ts");
  const w = spendCeilingWords({ todayUsd: 601, ceilingUsd: 600, hitAt: "2026-10-25T14:03:20.000Z" });
  expect(w).toEqual({ note: "ceiling hit 14:03Z, builders idle", title: "ceiling hit 14:03Z, builders idle", attn: true });
});

test("an admin's first screen carries the flow vitals line; a non-admin's does not (#5935)", async () => {
  const text = await withCommit(undefined, () => firstScreen(alice));
  expect(text).toContain(vitalsLine(readVitals(forge.db)));
  expect(await firstScreen(bob)).not.toContain("open pulls");
});
