/**
 * The terminal's issue screen puts an issue first with `f` (#7636): the same
 * action as the web button, so a repository with no `flow` label gets one for
 * a writer, `f` again takes it back, and a reader has no key and makes nothing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { labelsFor, listLabels, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { issueScreen } from "../src/tui/screens/issue.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("the terminal's issue screen puts an issue first with f", () => {
  let dataDir = "";
  let app: App;
  let alice: User;
  let bob: User;
  let repo: Repo;

  /** Every terminal opened here, stopped before the database closes: a live one keeps drawing into the next file. */
  const opened: { stop(): void }[] = [];

  const open = async (user: User, issue: Issue) => {
    const terminal = headlessTerminal(140, 40);
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user },
      { terminal, exitHooks: false },
    );
    tui.start();
    opened.push(tui);
    await settleApp(tui);
    tui.push(issueScreen(session, tui.ctx, local(session, getRepoById(app.db, repo.id)!), issue.number));
    await settleApp(tui);
    const key = async (k: string) => {
      tui.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
      await settleApp(tui);
    };
    return { key, text: () => tui.screen.toText() };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-flow-first-"));
    app = createApp({ dataDir, port: 0 });
    for (const username of ["alice", "bob"]) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: username === "alice",
      });
      if (!made.ok) throw new Error(made.error);
      if (username === "alice") alice = made.value;
      else bob = made.value;
    }
    const r = await createRepo(app, alice, { name: "garden", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
  }, 30_000);

  afterAll(async () => {
    for (const tui of opened) tui.stop();
    await new Promise((r) => setTimeout(r, 100));
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const newIssue = (title: string): Issue => {
    const o = openIssue(app, alice, getRepoById(app.db, repo.id)!, { title, body: "" });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
  };

  test("a reader has no key and makes no label", async () => {
    const issue = newIssue("for a reader");
    const t = await open(bob, issue);
    expect(t.text()).not.toContain("flow first");
    await t.key("f");
    expect(listLabels(app.db, repo.id)).toEqual([]);
    expect(labelsFor(app.db, issue.id)).toEqual([]);
  });

  test("a writer's f makes the label on a repository without one, and f again takes it back", async () => {
    const issue = newIssue("first please");
    expect(listLabels(app.db, repo.id)).toEqual([]);
    const t = await open(alice, issue);
    expect(t.text()).toContain("flow first");
    await t.key("f");
    expect(labelsFor(app.db, issue.id).map((l) => l.name)).toEqual(["flow"]);
    await t.key("f");
    expect(labelsFor(app.db, issue.id)).toEqual([]);
  });
});
