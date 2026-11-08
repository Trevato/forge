/**
 * The toolbar page's other two doors in the terminal (#810): "Working now"
 * while an agent run is live (a sealed issue's run hidden from who may not
 * see it), and "Make it yours" for whoever cannot write the repository.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { repoScreen } from "../src/tui/screens/repo.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let bob: User;
let repo: Repo;

/** The longest a screen gets to show what an assertion reads. */
const SHOW_MS = 2000;

/**
 * Open the palette as `user`, type `keys`, and return the screen once the
 * list has rendered: the search is no longer "searching…", and when the
 * caller expects a row (`shows`) that row is on screen. A negative assertion
 * made on the result therefore reads a drawn list, not an empty frame.
 */
async function palette(user: User, keys: string[], shows?: string): Promise<string> {
  const terminal = headlessTerminal(120, 40);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
    { terminal, exitHooks: false },
  );
  tui.start();
  tui.ctx.push(repoScreen(session, tui.ctx, local(session, repo)));
  await settleApp(tui);
  for (const k of keys) {
    terminal.feed(k);
    await settleApp(tui);
  }
  const deadline = Date.now() + SHOW_MS;
  let text = tui.screen.toText();
  while (Date.now() < deadline && (text.includes("searching…") || (shows !== undefined && !text.includes(shows)))) {
    await new Promise<void>((r) => setTimeout(r, 10));
    await settleApp(tui);
    text = tui.screen.toText();
  }
  if ((text.includes("searching…") || (shows !== undefined && !text.includes(shows)))) throw new Error(`never came: still waiting while (text.includes("searching…") || (shows !== undefined && !text.includes(shows)))`);
  tui.stop?.();
  return text;
}

/** A live agent run of this test's own; `done()` finishes it. */
function liveRun(summary: string, issueId?: string): { id: string; done: () => void } {
  const run = createRun(app.db, { repoId: repo.id, kind: "agent", issueId, actorId: alice.id, summary });
  claimRun(app.db, run.id);
  return { id: run.id, done: () => void finishRun(app.db, run.id, { state: "ok", summary: "done" }) };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-working-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  alice = await mk("alice", true);
  bob = await mk("bob");
  proveAll(app);
  const made = await createRepo(app, alice, { name: "lobby", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("working now in the terminal", () => {
  test("shown while a run is live, gone once it finishes", async () => {
    expect(await palette(bob, [":", "Working"])).not.toContain("Working now");
    const run = liveRun("LIVEJOB sanding the door");
    try {
      expect(await palette(bob, [":", "Working"], "LIVEJOB")).toContain("LIVEJOB sanding the door");
    } finally {
      run.done();
    }
    expect(await palette(bob, [":", "Working"])).not.toContain("Working now");
  });

  test("a run on a sealed issue is hidden from bob and shown to its filer", async () => {
    const sealed = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title: "hole", sealed: true });
    if (!sealed.ok) throw new Error(sealed.error);
    const run = liveRun("SEALEDJOB", sealed.value.id);
    try {
      expect(await palette(alice, [":", "Working"], "SEALEDJOB")).toContain("SEALEDJOB");
      expect(await palette(bob, [":", "Working"])).not.toContain("SEALEDJOB");
    } finally {
      run.done();
    }
  });
});

describe("make it yours in the terminal", () => {
  test("a writer does not see it; a reader who cannot write does", async () => {
    expect(await palette(alice, [":", "Make it"])).not.toContain("Make it yours");
    expect(await palette(bob, [":", "Make it"], "Make it yours")).toContain("alice/lobby — Make it yours");
  });

  test("it opens the make-it-yours screen", async () => {
    const text = await palette(bob, [":", "make it", "\r"], "your own");
    expect(text).toContain("Make alice/lobby your own");
  });
});
