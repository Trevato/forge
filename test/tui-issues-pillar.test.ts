/** The issues list tags each row with its pillar (or `later`), and `P` narrows the list to one pillar. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { addDependency } from "../src/core/dependencies.ts";
import type { Issue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { issuesScreen } from "../src/tui/screens/issues.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let forge: Forge;
let alice: User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-issues-pillar-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(forge, {
    username: "alice",
    email: "alice@forge.test",
    password: "a-long-passphrase",
  });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
});
afterAll(async () => {
  forge.close?.();
  await rm(dir, { recursive: true, force: true });
});

const make = async (repo: Repo, title: string): Promise<Issue> => {
  const r = await openIssue(forge, alice, repo, { title, body: "x" });
  if (!r.ok) throw new Error(`issue failed: ${r.error}`);
  return r.value;
};

const open = async (repo: Repo) => {
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", user: alice },
    { terminal: headlessTerminal(120, 30), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  app.push(issuesScreen(session, app.ctx, local(session, repo), "issue"));
  await settleApp(app);
  const press = async (key: string): Promise<void> => {
    app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
    await settleApp(app);
  };
  return { app, press, text: () => app.screen.toText() };
};

test("a row carries its pillar, P narrows the list, and a repository without umbrellas has neither", async () => {
  const plain = await createRepo(forge, alice, { name: "plain", visibility: "public" });
  if (!plain.ok) throw new Error("repo failed");
  await make(plain.value, "Loose work");
  const bare = await open(plain.value);
  expect(bare.text()).toContain("Loose work");
  expect(bare.text()).not.toMatch(/\bP0\b|later/);
  expect(bare.text()).not.toContain("P  pillar");
  await bare.press("P");
  expect(bare.text()).toContain("Loose work");
  expect(bare.text()).not.toContain("pillar:");
  bare.app.stop();

  const r = await createRepo(forge, alice, { name: "plan", visibility: "public" });
  if (!r.ok) throw new Error("repo failed");
  const repo = r.value;
  const trust = await make(repo, "P0 Trust: be trusted");
  const speed = await make(repo, "P1 Speed: be quick");
  const gate = await make(repo, "Later gate: not yet");
  const a = await make(repo, "Sign the thing");
  const b = await make(repo, "Cache the thing");
  const c = await make(repo, "Defer the thing");
  await make(repo, "Unplaced thing");
  addDependency(forge.db, trust, a, alice.id);
  addDependency(forge.db, speed, b, alice.id);
  addDependency(forge.db, c, gate, alice.id);

  const h = await open(repo);
  const row = (title: string): string =>
    h.text().split("\n").find((l) => l.includes(title)) ?? "";
  expect(row("Sign the thing")).toContain("P0");
  expect(row("Cache the thing")).toContain("P1");
  expect(row("Defer the thing")).toContain("later");
  expect(row("Unplaced thing")).not.toMatch(/P\d|later/);
  expect(h.text()).toContain("P  pillar");

  await h.press("P");
  expect(h.text()).toContain("pillar:P0");
  expect(h.text()).toContain("Sign the thing");
  expect(h.text()).not.toContain("Cache the thing");
  await h.press("P");
  expect(h.text()).toContain("pillar:P1");
  expect(h.text()).toContain("Cache the thing");
  expect(h.text()).not.toContain("Sign the thing");
  await h.press("P");
  expect(h.text()).toContain("pillar:later");
  expect(h.text()).toContain("Defer the thing");
  expect(h.text()).not.toContain("Cache the thing");
  await h.press("P");
  expect(h.text()).not.toContain("pillar:");
  expect(h.text()).toContain("Sign the thing");
  expect(h.text()).toContain("Cache the thing");
  h.app.stop();
});

test("with a pillar on, pages past the first are read until its issues show", async () => {
  const r = await createRepo(forge, alice, { name: "paged", visibility: "public" });
  if (!r.ok) throw new Error("repo failed");
  const repo = r.value;
  const trust = await make(repo, "P0 Trust: be trusted");
  const old = await make(repo, "Oldest trusted thing");
  addDependency(forge.db, trust, old, alice.id);
  for (let n = 0; n < 45; n++) await make(repo, `Filler ${n}`);

  const h = await open(repo);
  // Newest first: the pillar's issue is on the second page.
  expect(h.text()).not.toContain("Oldest trusted thing");
  await h.press("P");
  expect(h.text()).toContain("pillar:P0");
  expect(h.text()).toContain("Oldest trusted thing");
  h.app.stop();
});
