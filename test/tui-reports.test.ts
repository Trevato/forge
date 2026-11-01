/**
 * Reports from outside in the terminal (#7233): two reports filed through the
 * API wait under "Reports (2)" in the owner's palette; `a` accepts one as an
 * issue and says its number, `d` dismisses the other after a confirm, and the
 * row is gone once nothing waits. A reader has no row; a report someone else
 * decided meanwhile is refused in REPORT_ALREADY_DECIDED's words.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPORT_ALREADY_DECIDED } from "../src/actions/origin_app_words.ts";
import { dismissReport, waitingReports } from "../src/actions/reports.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getIssue } from "../src/core/issues.ts";
import { insertReport } from "../src/core/reports.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import type { Ctx } from "../src/tui/app/app.ts";
import { reportsCommands } from "../src/tui/screens/reports.ts";
import type { Session } from "../src/tui/session.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { repoScreen } from "../src/tui/screens/repo.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let alice: User;
let bob: User;
let repo: Repo;

/** A repository screen for `user`; `run` feeds keys and reads the screen. */
async function open(user: User) {
  const terminal = headlessTerminal(140, 36);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
    { terminal, exitHooks: false },
  );
  tui.start();
  tui.ctx.push(repoScreen(session, tui.ctx, local(session, repo)));
  await settleApp(tui);
  return {
    run: async (...keys: string[]) => {
      for (const k of keys) {
        terminal.feed(k);
        await settleApp(tui);
      }
      return tui.screen.toText();
    },
    stop: () => tui.stop?.(),
  };
}

async function file(title: string, body: string, page: string): Promise<void> {
  const res = await fetch(`${servers.url}/api/v1/repos/alice/lib/reports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title, body, page }),
  });
  expect(res.status).toBe(202);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-reports-"));
  app = createApp({ dataDir: dir, port: 0, host: "forge.test" });
  servers = await serve(app);
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  alice = await mk("alice", true);
  bob = await mk("bob");
  const made = await createRepo(app, alice, { name: "lib", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
});

afterAll(async () => {
  await servers.stop();
  await rm(dir, { recursive: true, force: true });
});

const waiting = () => {
  const r = waitingReports(app, alice, repo);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe("reports from outside, in the terminal", () => {
  test("no row while nothing waits", async () => {
    const h = await open(alice);
    expect(await h.run(":", "Reports (")).not.toContain("lib — Reports (");
    h.stop();
  });

  test("the owner accepts one and dismisses one; a reader has no row", async () => {
    await file("The save button does nothing", "Clicked save twice, nothing happened.", "https://lib.example/edit");
    await file("Typo on the front page", "It says teh.", "https://lib.example/");
    expect(waiting()).toHaveLength(2);

    const reader = await open(bob);
    expect(await reader.run(":", "Reports (")).not.toContain("lib — Reports (");
    reader.stop();

    const h = await open(alice);
    let text = await h.run(":", "Reports (");
    expect(text).toContain("alice/lib — Reports (2)");
    text = await h.run("\r");
    expect(text).toContain("The save button does nothing");
    expect(text).toContain("Typo on the front page");
    expect(text).toContain("https://lib.example/edit");
    expect(text).toContain("Clicked save twice, nothing happened.");

    text = await h.run("a");
    const number = Number(/Accepted as issue #(\d+)\./.exec(text)?.[1]);
    expect(number).toBeGreaterThan(0);
    const issue = getIssue(app.db, repo.id, number)!;
    expect(issue.title).toContain("The save button does nothing");
    expect(issue.body).toContain("Clicked save twice, nothing happened.");
    expect(waiting().map((r) => r.title)).toEqual(["Typo on the front page"]);

    // The confirm's first button keeps it waiting; the second dismisses.
    await h.run("d", "\r");
    expect(waiting()).toHaveLength(1);
    text = await h.run("d", "\x1b[C", "\r");
    expect(text).toContain("Dismissed.");
    expect(text).toContain("Nothing waits.");
    expect(waiting()).toHaveLength(0);
    h.stop();

    const after = await open(alice);
    expect(await after.run(":", "Reports (")).not.toContain("lib — Reports (");
    after.stop();
  });

  test("a report decided by someone else meanwhile says so", async () => {
    await file("Login loops", "Back to the login page every time.", "https://lib.example/login");
    const h = await open(alice);
    await h.run(":", "Reports (", "\r");
    const [report] = waiting();
    expect(dismissReport(app, alice, repo, report!.id).ok).toBe(true);
    expect(await h.run("a")).toContain(REPORT_ALREADY_DECIDED);
    h.stop();
  });
});

describe("no row for an agent or a guest", () => {
  test("the owner, turned agent, with a report waiting, has no row; neither has a guest", async () => {
    // Straight to the table: the API has already taken this source's share for the window.
    insertReport(app.db, repo.id, { title: "Broken link", body: "", page: null });
    // As a person the owner sees "Reports (1)"; the same account as an agent sees nothing.
    expect(reportsCommands({ app, user: alice } as Session, {} as Ctx, repo)).toHaveLength(1);
    app.db.query("UPDATE user SET is_agent = 1 WHERE id = ?1").run(alice.id);
    try {
      const agent = getUserByName(app.db, "alice")!;
      expect(agent.kind).toBe("agent");
      expect(reportsCommands({ app, user: agent } as Session, {} as Ctx, repo)).toEqual([]);
    } finally {
      app.db.query("UPDATE user SET is_agent = 0 WHERE id = ?1").run(alice.id);
    }
    expect(reportsCommands({ app, user: undefined } as Session, {} as Ctx, repo)).toEqual([]);
  });
});

describe("who filed it, in the terminal (#7658)", () => {
  test("each row names its filer and the head counts them, most first", async () => {
    for (const r of waiting()) dismissReport(app, alice, repo, r.id);
    insertReport(app.db, repo.id, { title: "Stuck at sign-in", body: "", page: null }, bob.id);
    insertReport(app.db, repo.id, { title: "Stuck at the map", body: "", page: null }, bob.id);
    insertReport(app.db, repo.id, { title: "Search hangs", body: "", page: null, claimed: "grokbot" });
    insertReport(app.db, repo.id, { title: "Typo", body: "", page: null });
    const h = await open(alice);
    const text = await h.run(":", "Reports (", "\r");
    expect(text).toContain("From 2 @bob · 1 claims to be grokbot, unproven · 1 anonymous; unchecked.");
    expect(text).toContain("Sent just now by @bob");
    h.stop();
  });
});
