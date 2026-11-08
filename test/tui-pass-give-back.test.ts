/**
 * The terminal's On you row of a pull a pass assigned to this person says the
 * pass's reason, and `b` gives it back to the builder who last worked on it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addComment } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { addCrew, createAgentRow } from "../src/core/agents.ts";
import { getIssueById } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { HANDOVER_NOTE } from "../src/crew/guard.ts";
import { id } from "../src/kernel/id.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

const ZERO = "0".repeat(40);

describe("terminal: give back a pull a pass handed over", () => {
  let dir = "";
  let forge: Forge;
  let alice: User;
  let builder: User;
  let repo: Repo;

  const boot = async () => {
    const terminal = headlessTerminal(200, 32);
    const { app } = createForgeApp(
      forge,
      { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: alice },
      { terminal, exitHooks: false },
    );
    app.start();
    await settleApp(app);
    const press = async (key: string) => {
      app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
      await settleApp(app);
    };
    await press("tab");
    return { press, text: () => app.screen.toText(), stop: () => app.stop() };
  };

  /** An open pull the builder worked on, assigned to alice. */
  const pull = (n: number): string => {
    const pullId = id();
    forge.db
      .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, assignee_id) VALUES (?1, ?2, ?3, 'pull', 'Rebase me', '', ?4, 'open', ?5)`)
      .run(pullId, repo.id, n, builder.id, alice.id);
    forge.db
      .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id) VALUES (?1, 'main', 'b/x', ?2, ?2, ?3)`)
      .run(pullId, ZERO, repo.id);
    forge.db
      .query(`INSERT INTO run (id, repo_id, kind, issue_id, env, commit_oid, branch, actor_id, reason, state, created_at) VALUES (?1, ?2, 'agent', ?3, 'preview', ?4, 'b', ?5, 'conflict', 'ok', '2026-10-01T00:00:00.000Z')`)
      .run(id(), repo.id, pullId, ZERO, builder.id);
    return pullId;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-tui-back-"));
    forge = createApp({ dataDir: dir, port: 0 });
    const a = await seedAdmin(forge, { username: "alice", email: "a@forge.test", password: "a-long-passphrase" });
    if (!a.ok) throw new Error("signup failed");
    alice = a.value;
    const r = await createRepo(forge, alice, { name: "lamp", visibility: "public" });
    if (!r.ok) throw new Error("repo failed");
    repo = r.value;
    const made = await createUser(forge.db, { username: "builder", email: "builder@forge.test", agent: true, origin: "agent" });
    if (!made.ok) throw new Error(made.error);
    builder = made.value;
    createAgentRow(forge.db, { userId: builder.id, brief: "b" });
    addCrew(forge.db, repo.id, builder.id, alice.id);
  }, 30_000);

  afterAll(async () => {
    forge.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("the row says why, and b assigns the builder", async () => {
    const pullId = pull(1);
    addComment(forge, alice, repo, getIssueById(forge.db, pullId)!, `${HANDOVER_NOTE} two runs ended without a push. (The forge posts this under your name; you did not write it.)`);
    const h = await boot();
    expect(h.text()).toContain("handed to you: two runs ended without a push.");
    expect(h.text()).toContain("b  give back to the crew");
    await h.press("b");
    expect(getIssueById(forge.db, pullId)!.assigneeId).toBe(builder.id);
    expect(h.text()).not.toContain("Rebase me");
    h.stop();
  });

  test("a plain assignment has no reason, and b still gives it to the crew", async () => {
    const pullId = pull(2);
    const h = await boot();
    expect(h.text()).not.toContain("handed to you");
    expect(h.text()).toContain("b  give back to the crew");
    await h.press("b");
    expect(getIssueById(forge.db, pullId)!.assigneeId).toBe(builder.id);
    h.stop();
  });
});
