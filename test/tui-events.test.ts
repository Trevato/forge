/** `v` on the About card reads the repository's events as MCP `events` does. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { aboutScreen } from "../src/tui/screens/about.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { localSource } from "../src/view/local.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

let dir: string;
let forge: Forge;
let alice: User;
let bob: User;
let repo: Repo;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-events-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const b = await signUp(forge, { username: "bob", email: "bob@forge.test", password: "a-long-passphrase" }, { slot: fixtureSlot(forge) });
  if (!b.ok) throw new Error("signup failed");
  bob = b.value;
  const r = await createRepo(forge, alice, { name: "lamp", visibility: "public" });
  if (!r.ok) throw new Error("repo failed");
  repo = r.value;
  forge.bus.append({ kind: "issue.opened", repoId: repo.id, actorId: alice.id, payload: { number: 1 } });
  forge.bus.append({
    kind: "webhook.created",
    repoId: repo.id,
    actorId: alice.id,
    payload: { url: "https://hooks.example/secret-path" },
  });
  for (let i = 0; i < 60; i++)
    forge.bus.append({ kind: "push", repoId: repo.id, actorId: alice.id, payload: { updates: [{ ref: `refs/heads/b${i}` }] } });
});
afterAll(async () => {
  forge.close?.();
  await rm(dir, { recursive: true, force: true });
});

/** Open the About card as `who`, press `v`, then the given keys; return the card's and the list's text. */
async function open(who: User, keys: string[] = []): Promise<{ about: string; events: string }> {
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: who.username, remoteAddress: "127.0.0.1", user: who },
    { terminal: headlessTerminal(120, 40), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  const src = localSource(forge, repo, who);
  const about = aboutScreen(session, app.ctx, { render() {} } as never, src, undefined, "main");
  app.push(about);
  await settleApp(app);
  const card = app.screen.toText();
  for (const key of ["v", ...keys]) app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
  await settleApp(app);
  const events = app.screen.toText();
  app.stop();
  return { about: card, events };
}

test("the About card offers v, and v lists the events newest first", async () => {
  const { about, events } = await open(alice);
  expect(about).toMatch(/\bv\b[^\n]*events/);
  expect(events).toContain("alice pushed: b59");
  expect(events.indexOf("alice pushed: b59")).toBeLessThan(events.indexOf("alice pushed: b58"));
  expect(events).toContain("next page");
});

test("n loads the next page past 50, ending at the oldest event", async () => {
  const first = await open(alice, ["G"]);
  expect(first.events).toContain("alice pushed: b10");
  expect(first.events).not.toContain("alice opened an issue: #1");
  const all = await open(alice, ["n", "G"]);
  expect(all.events).toContain("alice opened an issue: #1");
  expect(all.events).not.toContain("next page");
});

test("an admin sees the webhook event; a reader does not, nor its URL", async () => {
  const admin = await open(alice, ["n", "G"]);
  expect(admin.events).toContain("alice added a webhook");
  expect(admin.events).not.toContain("hooks.example");
  const reader = await open(bob, ["n", "G"]);
  expect(reader.events).not.toContain("added a webhook");
  expect(reader.events).not.toContain("hooks.example");
  expect(reader.events).toContain("alice opened an issue: #1");
});
