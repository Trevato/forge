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

async function palette(user: User, keys: string[] = [":"]): Promise<string> {
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
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-working-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
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
    const run = createRun(app.db, { repoId: repo.id, kind: "agent", actorId: alice.id, summary: "LIVEJOB sanding the door" });
    claimRun(app.db, run.id);
    expect(await palette(bob, [":", "Working"])).toContain("Working now: LIVEJOB sanding the door");
    finishRun(app.db, run.id, { state: "ok", summary: "done" });
    expect(await palette(bob, [":", "Working"])).not.toContain("Working now");
  });

  test("a run on a sealed issue is hidden from bob and shown to its filer", async () => {
    const sealed = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title: "hole", sealed: true });
    if (!sealed.ok) throw new Error(sealed.error);
    const run = createRun(app.db, { repoId: repo.id, kind: "agent", issueId: sealed.value.id, actorId: alice.id, summary: "SEALEDJOB" });
    claimRun(app.db, run.id);
    expect(await palette(bob, [":", "Working"])).not.toContain("SEALEDJOB");
    expect(await palette(alice, [":", "Working"])).toContain("SEALEDJOB");
    finishRun(app.db, run.id, { state: "ok", summary: "done" });
  });
});

describe("make it yours in the terminal", () => {
  test("a writer does not see it; a reader who cannot write does", async () => {
    expect(await palette(alice, [":", "Make it"])).not.toContain("Make it yours");
    expect(await palette(bob, [":", "Make it"])).toContain("alice/lobby — Make it yours");
  });

  test("it opens the fork screen", async () => {
    const text = await palette(bob, [":", "make it", "\r"]);
    expect(text).toContain("Fork");
  });
});
