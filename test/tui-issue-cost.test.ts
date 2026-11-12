/**
 * The terminal's issue screen shows what the issue and its closing pulls cost
 * (the same `issueCostFor` gate as the web page), and shows a viewer who may
 * not see it nothing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import type { Issue } from "../src/core/issues.ts";
import { createRun } from "../src/core/runs.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { issueScreen } from "../src/tui/screens/issue.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("the terminal's issue screen and its cost", () => {
  let dataDir = "";
  let app: App;
  let alice: User;
  let bob: User;
  let repo: Repo;
  const fresh = () => getRepoById(app.db, repo.id)!;
  const newIssue = (title: string): Issue => {
    const o = openIssue(app, alice, repo, { title });
    if (!o.ok) throw new Error(o.error);
    return o.value;
  };

  /** A terminal signed in as `user`, on the issue screen of `number`. */
  const open = async (user: User, number: number, where: Repo = fresh(), rows = 40) => {
    const terminal = headlessTerminal(140, rows);
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user },
      { terminal, exitHooks: false },
    );
    tui.start();
    await settleApp(tui);
    tui.push(issueScreen(session, tui.ctx, local(session, where), number));
    await settleApp(tui);
    const press = async (...keys: string[]) => {
      for (const key of keys)
        tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
      await settleApp(tui);
    };
    const type = (text: string) => press(...text);
    const text = () => tui.screen.toText();
    /** Click the first cell of `needle` on the row that also holds `row`. */
    const click = async (row: string, needle: string) => {
      const rows = text().split("\n");
      const y = rows.findIndex((r) => r.includes(row) && r.includes(needle));
      if (y < 0) throw new Error(`no row with ${row} and ${needle}:\n${text()}`);
      const x = rows[y]!.indexOf(needle, rows[y]!.indexOf(row));
      tui.dispatch({ type: "mouse", kind: "press", button: 0, x, y, ctrl: false, alt: false, shift: false });
      tui.dispatch({ type: "mouse", kind: "release", button: 0, x, y, ctrl: false, alt: false, shift: false });
      await settleApp(tui);
    };
    return { tui, press, type, text, click, stop: () => tui.stop() };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-issue-cost-"));
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
    const seeded = await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const spend = (issue: Issue, usd: number, pull = false) => {
    if (pull)
      app.db.query("UPDATE issue SET kind = 'pull' WHERE id = ?1").run(issue.id);
    if (pull)
      app.db
        .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?1, 'main', 'x', '', '')`)
        .run(issue.id);
    const r = createRun(app.db, { repoId: repo.id, kind: "agent", issueId: issue.id });
    app.db.query("UPDATE run SET cost_usd = ?1 WHERE id = ?2").run(usd, r.id);
  };

  test("the owner sees the sentence, a reader who cannot write sees nothing", async () => {
    const issue = newIssue("Prune");
    spend(issue, 0.5);
    const pull = newIssue("Fix prune");
    app.db.query("UPDATE issue SET body = ?2 WHERE id = ?1").run(pull.id, `Closes #${issue.number}`);
    spend(pull, 0.25, true);
    const t = await open(alice, issue.number);
    try {
      expect(t.text()).toContain(`Cost $0.75: this issue $0.50, #${pull.number} $0.25`);
    } finally {
      t.stop();
    }
    const r = await open(bob, issue.number);
    try {
      expect(r.text()).toContain("Prune");
      expect(r.text()).not.toContain("Cost $");
    } finally {
      r.stop();
    }
  });
});
