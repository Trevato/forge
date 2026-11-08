/**
 * The issue screen's `S` (#7996): a writer seals or unseals a report after a
 * confirm, and the toast says what the issue page's Seal form says.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { SEAL_ISSUE_SAYS } from "../src/actions/seal_issue_words.ts";
import { createApp, type App } from "../src/app.ts";
import { getIssue, type Issue } from "../src/core/issues.ts";
import { createOrigin, linkRepoToOrigin } from "../src/core/origins.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { issueScreen } from "../src/tui/screens/issue.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("the terminal's issue screen seals with S", () => {
  let dataDir = "";
  let app: App;
  let alice: User;
  let carol: User;
  let repo: Repo;

  const open = async (user: User, issue: Issue, on: Repo = getRepoById(app.db, repo.id)!) => {
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user },
      { terminal: headlessTerminal(140, 40), exitHooks: false },
    );
    tui.start();
    await settleApp(tui);
    tui.push(issueScreen(session, tui.ctx, local(session, on), issue.number));
    await settleApp(tui);
    const key = async (k: string) => {
      tui.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
      await settleApp(tui);
    };
    return { tui, key, text: () => tui.screen.toText() };
  };

  const sealedNow = (issue: Issue, on: Repo = repo): boolean =>
    getIssue(app.db, on.id, issue.number)!.sealed;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-issue-seal-"));
    app = createApp({ dataDir, port: 0 });
    for (const username of ["alice", "carol"]) {
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
      else carol = made.value;
    }
    const r = await createRepo(app, alice, { name: "garden", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const newIssue = (title: string, on: Repo = repo): Issue => {
    const o = openIssue(app, alice, on, { title, body: "A hole." });
    if (!o.ok) throw new Error(o.error);
    return o.value;
  };

  test("a writer seals with S then confirm, and S again unseals", async () => {
    const issue = newIssue("A leak");
    const t = await open(alice, issue);
    try {
      expect(t.text()).toMatch(/\bS  seal\b/);
      await t.key("S");
      expect(t.text()).toContain(
        `Seal #${issue.number}? Only people who can write here and the crew will see it.`,
      );
      await t.key("left");
      await t.key("enter");
      expect(sealedNow(issue)).toBe(true);
      expect(t.text()).toContain(SEAL_ISSUE_SAYS.sealed);
    } finally {
      t.tui.stop();
    }
    // The toast covers the key bar; a fresh screen shows the new state.
    const u = await open(alice, issue);
    try {
      expect(u.text()).toMatch(/\bS  unseal\b/);
      await u.key("S");
      expect(u.text()).toContain(
        `Unseal #${issue.number}? Everyone who can read alice/garden sees it and its fix.`,
      );
      await u.key("left");
      await u.key("enter");
      expect(sealedNow(issue)).toBe(false);
      expect(u.text()).toContain(SEAL_ISSUE_SAYS.unsealed);
    } finally {
      u.tui.stop();
    }
  });

  test("Cancel is chosen first and leaves the issue as it was", async () => {
    const issue = newIssue("A draught");
    const t = await open(alice, issue);
    try {
      await t.key("S");
      await t.key("enter");
      expect(sealedNow(issue)).toBe(false);
      expect(t.text()).not.toContain(`Seal #${issue.number}?`);
    } finally {
      t.tui.stop();
    }
  });

  test("a reader is not offered S, and pressing it asks nothing", async () => {
    const issue = newIssue("A crack");
    const t = await open(carol, issue);
    try {
      expect(t.text()).toContain("A crack");
      expect(t.text()).not.toMatch(/\bS  (un)?seal\b/);
      await t.key("S");
      expect(t.text()).not.toContain(`Seal #${issue.number}?`);
      expect(sealedNow(issue)).toBe(false);
    } finally {
      t.tui.stop();
    }
  });

  test("sealing on a mirror toasts the mirror refusal", async () => {
    const made = await createRepo(app, alice, { name: "widgets", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const issue = newIssue("A cog", made.value);
    const o = createOrigin(app.db, dataDir, {
      userId: alice.id,
      kind: "forgejo",
      apiUrl: "https://codeberg.org/api/v1",
      webUrl: "https://codeberg.org",
      login: "alice",
      token: "t0ken",
    });
    if (!o.ok) throw new Error(o.error);
    linkRepoToOrigin(app.db, made.value.id, {
      originId: o.value.id,
      fullName: "octo/widgets",
      remoteId: "1",
      htmlUrl: "https://codeberg.org/octo/widgets",
    });
    const t = await open(alice, issue, getRepoById(app.db, made.value.id)!);
    try {
      await t.key("S");
      await t.key("left");
      await t.key("enter");
      expect(sealedNow(issue, made.value)).toBe(false);
      expect(t.text()).toContain(SEAL_ISSUE_SAYS.mirrored);
    } finally {
      t.tui.stop();
    }
  });
});
