/** The deploys screen's Previews group: one row per open pull's preview, Enter opening the pull. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appPreviews } from "../src/actions/apps.ts";
import { createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { createApp as createAppRecord, type AppRecord } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { deploysScreen, previewRow } from "../src/tui/screens/deploys.ts";
import { envTone } from "../src/tui/screens/runwords.ts";
import { createRun } from "../src/core/runs.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let forge: Forge;
let runtime: AppsRuntime;
let alice: User;
let bob: User;
/** Every `status()` read the runtime answered, by app slug. */
const reads: string[] = [];
/** What `status()` answers, by app slug. */
const serving = new Map<string, EnvStatus[]>();

const env = (e: Partial<EnvStatus> & Pick<EnvStatus, "env" | "state" | "url">): EnvStatus => ({ commitOid: "a".repeat(40), ...e }) as EnvStatus;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-deploys-previews-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const b = await signUp(forge, { username: "bob", email: "bob@forge.test", password: "a-long-passphrase" }, { slot: fixtureSlot(forge) });
  if (!b.ok) throw new Error("signup failed");
  bob = b.value;
  runtime = new AppsRuntime(forge, { domain: "apps.test", scheme: "https", forgeUrl: "https://forge.test", concurrency: 1 });
  runtime.status = (record: AppRecord) => {
    reads.push(record.slug);
    return serving.get(record.slug) ?? [];
  };
});
afterAll(async () => {
  await runtime.stop();
  forge.close?.();
  await rm(dir, { recursive: true, force: true });
});

/** An app on a fresh repository, with open pulls numbered and titled as given. */
async function appWith(name: string, visibility: "public" | "private", pulls: [number, string][]): Promise<Repo> {
  const r = await createRepo(forge, alice, { name, visibility });
  if (!r.ok) throw new Error("repo failed");
  const made = createAppRecord(forge.db, { repoId: r.value.id, slug: name, access: "public" });
  if (!made.ok) throw new Error(made.error);
  for (const [n, title] of pulls) {
    const id = crypto.randomUUID();
    forge.db
      .query("INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES (?, ?, ?, 'pull', ?, ?)")
      .run(id, r.value.id, n, title, alice.id);
    forge.db
      .query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?, 'main', ?, 'b', 'h')")
      .run(id, `b${n}`);
  }
  return r.value;
}

/** The deploys screen held open: keys, clicks by a row's text, and what Enter says it does. */
async function hold(who: User, of: Repo) {
  const terminal = headlessTerminal(140, 40);
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: who.username, remoteAddress: "127.0.0.1", user: who },
    { terminal, exitHooks: false },
  );
  app.start();
  await settleApp(app);
  const screen = deploysScreen(session, app.ctx, of);
  app.push(screen);
  await settleApp(app);
  const text = (): string => app.screen.toText();
  return {
    text,
    enterHint: (): string | undefined => screen.keys.find((b) => b.keys.includes("enter"))?.help,
    async press(...keys: string[]): Promise<void> {
      for (const k of keys) {
        terminal.feed(k === "enter" ? "\r" : k);
        await settleApp(app);
      }
    },
    /** Click once on the grid row holding `what`, a little in from its left edge. */
    async click(what: string): Promise<void> {
      const row = text().split("\n").findIndex((line) => line.includes(what));
      if (row < 0) throw new Error(`no row holds ${what}`);
      terminal.feed(`\x1b[<0;5;${row + 1}M`);
      terminal.feed(`\x1b[<0;5;${row + 1}m`);
      await settleApp(app);
    },
    stop: (): void => app.stop(),
  };
}

async function drive(who: User, of: Repo, keys: string[] = []): Promise<string> {
  const terminal = headlessTerminal(140, 30);
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: who.username, remoteAddress: "127.0.0.1", user: who },
    { terminal, exitHooks: false },
  );
  app.start();
  await settleApp(app);
  app.push(deploysScreen(session, app.ctx, of));
  await settleApp(app);
  for (const k of keys) {
    terminal.feed(k === "enter" ? "\r" : k);
    await settleApp(app);
  }
  const text = app.screen.toText();
  app.stop();
  return text;
}

test("two previews, one running and one failed, draw a row each in the studio's words, from one status read", async () => {
  const repo = await appWith("ferry", "public", [
    [3, "Paint the hull"],
    [4, "Fix the rudder"],
    [5, "No preview yet"],
  ]);
  serving.set("ferry", [
    env({ env: "production", state: "running", url: "https://ferry.apps.test" }),
    env({ env: "pull-3", state: "running", url: "https://ferry--3.apps.test" }),
    env({ env: "pull-4", state: "failed", url: "https://ferry--4.apps.test", error: "exit 1" }),
  ]);

  reads.length = 0;
  const listed = appPreviews(forge, alice, repo);
  expect(reads).toEqual(["ferry"]);
  expect(listed?.map((p) => [p.number, p.env.state])).toEqual([
    [4, "failed"],
    [3, "running"],
  ]);

  const text = await drive(alice, repo);
  expect(text).toContain("Previews");
  expect(text).toContain("#3 Paint the hull · live · https://ferry--3.apps.test");
  expect(text).toContain("#4 Fix the rudder · not up · https://ferry--4.apps.test");
  // A pull with no environment is in the open pulls, not the previews.
  expect(text).not.toMatch(/#5 No preview yet · (live|not up|not running)/);
  expect(text).not.toContain("No previews.");

  // No deploys, so `j` lands on the first preview (#4, newest) and Enter opens its pull.
  const opened = await drive(alice, repo, ["j", "enter"]);
  expect(opened).toContain("Fix the rudder");
  expect(opened).not.toContain("Previews");
  const second = await drive(alice, repo, ["j", "j", "enter"]);
  expect(second).toContain("Paint the hull");
  expect(second).not.toContain("Previews");
});

test("an app with no previews says so", async () => {
  const repo = await appWith("barge", "public", [[1, "Load the barge"]]);
  serving.set("barge", [env({ env: "production", state: "running", url: "https://barge.apps.test" })]);
  expect(appPreviews(forge, alice, repo)).toEqual([]);
  const text = await drive(alice, repo);
  expect(text).toContain("Previews");
  expect(text).toContain("No previews.");
});

test("someone who may not read the repository sees no previews", async () => {
  const repo = await appWith("sub", "private", [[2, "Dive deeper"]]);
  serving.set("sub", [env({ env: "pull-2", state: "running", url: "https://sub--2.apps.test" })]);
  expect(appPreviews(forge, bob, repo)).toBeUndefined();
  const text = await drive(bob, repo);
  expect(text).not.toContain("Previews");
  expect(text).not.toContain("Dive deeper");
  expect(text).not.toContain("sub--2");
  expect(await drive(alice, repo)).toContain("#2 Dive deeper · live · https://sub--2.apps.test");
});

test("j and k cross between production's deploys and the previews; Enter opens a log above and a pull below", async () => {
  const repo = await appWith("tug", "public", [[6, "Tow the liner"]]);
  serving.set("tug", [env({ env: "pull-6", state: "running", url: "https://tug--6.apps.test" })]);
  for (const [oid, summary] of [["1", "FIRST-DEPLOY"], ["2", "SECOND-DEPLOY"]] as const)
    createRun(forge.db, { repoId: repo.id, kind: "deploy", env: "production", commitOid: oid.repeat(40), summary });

  const s = await hold(alice, repo);
  try {
    expect(s.text()).toContain("#6 Tow the liner · live · https://tug--6.apps.test");
    expect(s.enterHint()).toBe("open the log");
    // On the first deploy, `j` stays among the deploys.
    await s.press("j");
    expect(s.enterHint()).toBe("open the log");
    // On the last deploy, `j` moves into the previews.
    await s.press("j");
    expect(s.enterHint()).toBe("open the pull");
    // `k` on the first preview returns to the last deploy.
    await s.press("k");
    expect(s.enterHint()).toBe("open the log");
    await s.press("enter");
    expect(s.text()).toContain("Run log");
    expect(s.text()).not.toContain("Tow the liner");
  } finally {
    s.stop();
  }

  const t = await hold(alice, repo);
  try {
    await t.press("j", "j", "enter");
    expect(t.text()).not.toContain("Run log");
    expect(t.text()).not.toContain("Previews");
    expect(t.text()).toContain("Tow the liner");
  } finally {
    t.stop();
  }
});

test("more previews than the group shows scroll, keeping the cursor's row in view", async () => {
  const pulls: [number, string][] = Array.from({ length: 8 }, (_, i) => [20 + i, `Deck ${20 + i}`]);
  const repo = await appWith("liner", "public", pulls);
  serving.set(
    "liner",
    pulls.map(([n]) => env({ env: `pull-${n}`, state: "running", url: `https://liner--${n}.apps.test` })),
  );
  const s = await hold(alice, repo);
  try {
    // Newest first: #27 … #22 fit, #21 and #20 wait below.
    expect(s.text()).toContain("#27 Deck 27 · live");
    expect(s.text()).toContain("#22 Deck 22 · live");
    expect(s.text()).not.toContain("#20 Deck 20 · live");
    await s.press(..."jjjjjjjj");
    expect(s.enterHint()).toBe("open the pull");
    expect(s.text()).toContain("#20 Deck 20 · live");
    expect(s.text()).not.toContain("#27 Deck 27 · live");
    await s.press("enter");
    expect(s.text()).toContain("Deck 20");
    expect(s.text()).not.toContain("Previews");
  } finally {
    s.stop();
  }
});

test("a click selects a preview and a second click opens its pull", async () => {
  const repo = await appWith("dinghy", "public", [
    [1, "Row ashore"],
    [2, "Bail out"],
  ]);
  serving.set("dinghy", [
    env({ env: "pull-1", state: "running", url: "https://dinghy--1.apps.test" }),
    env({ env: "pull-2", state: "running", url: "https://dinghy--2.apps.test" }),
  ]);
  createRun(forge.db, { repoId: repo.id, kind: "deploy", env: "production", commitOid: "9".repeat(40) });
  const s = await hold(alice, repo);
  try {
    await s.click("#1 Row ashore · live");
    expect(s.enterHint()).toBe("open the pull");
    await s.click("#1 Row ashore · live");
    expect(s.text()).not.toContain("Previews");
    expect(s.text()).toContain("Row ashore");
    expect(s.text()).not.toContain("Bail out");
  } finally {
    s.stop();
  }
});

test("a row's dot wears the studio's tone: a failed preview danger, a live one success, a starting one none", () => {
  const p = (state: EnvStatus["state"]) => ({ number: 1, title: "t", env: env({ env: "pull-1", state, url: "u" }) });
  expect(previewRow(p("failed")).tone).toBe("danger");
  expect(previewRow(p("running")).tone).toBe("success");
  expect(previewRow(p("deploying")).tone).toBeUndefined();
  expect(previewRow(p("running")).title).toBe("#1 t · live · u");
  expect(envTone("danger")).toBe("danger");
  expect(envTone("attn")).toBe("attn");
  expect(envTone("default")).toBeUndefined();
});
