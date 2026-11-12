/** `v` on the About card reads the repository's events as MCP `events` does. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { ForgeEvent } from "../src/core/events.ts";
import { opensOf } from "../src/tui/screens/events.ts";
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
  for (const branch of ["main", "feat"]) {
    const c = await commitToBranch(forge, alice, repo, { branch, message: branch, files: [{ path: `${branch}.md`, content: "x\n" }] });
    if (!c.ok) throw new Error("commit failed");
  }
  // Opening the pull appends its `pull.opened` event: the row `enter` must open.
  const pull = await openPull(forge, alice, repo, { title: "Brighter bulb", body: "", baseBranch: "main", headBranch: "feat" });
  if (!pull.ok) throw new Error("pull failed");
  const issue = openIssue(forge, alice, repo, { title: "The lamp flickers" });
  if (!issue.ok) throw new Error("issue failed");
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
  expect(first.events).not.toContain("alice opened an issue: #2");
  const all = await open(alice, ["n", "G"]);
  expect(all.events).toContain("alice opened an issue: #2");
  expect(all.events).not.toContain("next page");
});

test("an admin sees the webhook event; a reader does not, nor its URL", async () => {
  const admin = await open(alice, ["n", "G"]);
  expect(admin.events).toContain("alice added a webhook");
  expect(admin.events).not.toContain("hooks.example");
  const reader = await open(bob, ["n", "G"]);
  expect(reader.events).not.toContain("added a webhook");
  expect(reader.events).not.toContain("hooks.example");
  expect(reader.events).toContain("alice opened an issue: #2");
});

/** Open the events list and press the keys; return the screen's text. */
async function press(keys: string[]): Promise<string> {
  const { events } = await open(alice, keys);
  return events;
}

// Newest first, the oldest last: created, push main, push feat, pull, issue (#2), webhook, then 60 pushes.
const END = ["n", "G"];
const up = (n: number): string[] => Array<string>(n).fill("k");

test("enter on an issue row opens the issue, on a pull row the pull, esc returns", async () => {
  const issue = await press([...END, ...up(4), "enter"]);
  expect(issue).toContain("The lamp flickers");
  expect(issue).not.toContain("alice pushed");
  const pull = await press([...END, ...up(3), "enter"]);
  expect(pull).toContain("Brighter bulb");
  expect(pull).not.toContain("The lamp flickers");
  expect(pull).not.toContain("not found");
  const back = await press([...END, ...up(4), "enter", "esc"]);
  expect(back).toContain("About › Events");
  expect(back).toContain("▸ alice opened an issue: #2");
});

test("enter on a row with nothing to open does nothing, and the key bar offers open only where it works", async () => {
  const push = await press(["enter"]);
  expect(push).toContain("About › Events");
  expect(push).not.toMatch(/enter\s+open/);
  expect((await press([...END, "enter"]))).toContain("About › Events");
  expect(await press([...END, ...up(3)])).toMatch(/enter\s+open/);
});

test("opensOf names the number and the screen, and nothing for a number that is not one", () => {
  const ev = (kind: string, number?: unknown) =>
    ({ kind, payload: number === undefined ? {} : { number } }) as unknown as ForgeEvent;
  expect(opensOf(ev("issue.opened", 1))).toEqual({ pull: false, number: 1 });
  expect(opensOf(ev("pull.merged", 7))).toEqual({ pull: true, number: 7 });
  expect(opensOf(ev("issue.opened", 0))).toBeUndefined();
  expect(opensOf(ev("pull.opened", 1.5))).toBeUndefined();
  expect(opensOf(ev("issue.opened", "3"))).toBeUndefined();
  expect(opensOf(ev("issue.opened"))).toBeUndefined();
  expect(opensOf(ev("push"))).toBeUndefined();
});

test("t keeps only the kind of the row under the cursor, and again lifts it", async () => {
  const narrowed = await open(alice, ["G", "G", "t"]);
  expect(narrowed.events).toContain("alice pushed: b");
  expect(narrowed.events).toContain("Events · pushes");
  expect(narrowed.events).not.toContain("alice opened an issue");
  const lifted = await open(alice, ["t", "t"]);
  expect(lifted.events).toContain("alice pushed: b59");
  expect(lifted.events).not.toContain("Events · ");
});
