/**
 * "Give back to the crew" on a hand-over card: drawn on a crew pull's card
 * and not a person's; one POST assigns the pull to its builder, comments,
 * and the card leaves; a foreign Origin is refused; a reader gets a 404.
 */

import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { addComment } from "../src/actions/issues.ts";
import { startCrew } from "../src/crew/dispatch.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addCrew, createAgentRow } from "../src/core/agents.ts";
import { getIssueById, listComments, setAssignee } from "../src/core/issues.ts";
import { handoverOf } from "../src/crew/guard.ts";
import { createRepo, type Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { id } from "../src/kernel/id.ts";
import { askLinesFor } from "../src/web/studio/asks.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

const ZERO = "0".repeat(40);

describe("give a handed-over pull back to the crew", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let owner: User;
  let builder: User;
  let reviewer: User;
  let repo: Repo;
  let reader: User;
  let cookie = "";
  let readerCookie = "";
  let seq = 0;

  const signIn = async (username: string, password: string) => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password }),
      redirect: "manual",
    });
    return `${(res.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=studio`;
  };

  const nextNumber = (): number =>
    app.db
      .query<{ issue_seq: number }, [string]>(
        "UPDATE repo SET issue_seq = issue_seq + 1 WHERE id = ?1 RETURNING issue_seq",
      )
      .get(repo.id)!.issue_seq;

  /** An open issue held by `holder`; returns its id and number. */
  const heldIssue = (holder: User): { id: string; number: number } => {
    const issueId = id();
    const number = nextNumber();
    app.db
      .query(
        `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, assignee_id)
         VALUES (?1, ?2, ?3, 'issue', 'Held', '', ?4, 'open', ?4)`,
      )
      .run(issueId, repo.id, number, owner.id);
    app.db.query("UPDATE issue SET assignee_id = ?2 WHERE id = ?1").run(issueId, holder.id);
    return { id: issueId, number };
  };

  const handedOver = (author: User, title: string, body = "", assigned = false): string => {
    const issueId = id();
    const number = nextNumber();
    app.db
      .query(
        `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state)
         VALUES (?1, ?2, ?3, 'pull', ?4, ?6, ?5, 'open')`,
      )
      .run(issueId, repo.id, number, title, author.id, body);
    app.db
      .query(
        `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id)
         VALUES (?1, 'main', ?2, ?3, ?3, ?4)`,
      )
      .run(issueId, `b/${++seq}`, ZERO, repo.id);
    // As production opens a crew pull: assigned to the agent that made it.
    if (assigned && author.kind === "agent") setAssignee(app.db, issueId, author.id);
    for (let r = 0; r < 3; r++)
      submitReview(app.db, {
        issueId,
        authorId: reviewer.id,
        state: "changes_requested",
        body: `Round ${r}.`,
        commitOid: ZERO,
      });
    return issueId;
  };

  const asking = (pullId: string): boolean =>
    askLinesFor(app.db, owner).some((r) => r.items.includes(`handover:${pullId}`));

  const page = async (): Promise<string> =>
    (await (await fetch(`${servers.url}/asks`, { headers: { cookie } })).text()).replace(/\s+/g, " ");

  const post = (ask: string, headers: Record<string, string> = {}, as = cookie) =>
    fetch(`${servers.url}/asks/give-back`, {
      method: "POST",
      headers: { cookie: as, origin: servers.url, ...headers },
      body: new URLSearchParams({ ask }),
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-give-back-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const make = async (username: string, agent: boolean) => {
      const made = await createUser(app.db, {
        username,
        email: `${username}@forge.test`,
        ...(agent
          ? { agent: true, origin: "agent" as const }
          : { password: "a-good-passphrase", origin: "seed" as const, trusted: true }),
      });
      if (!made.ok) throw new Error(`seed ${username}: ${made.error}`);
      if (agent) createAgentRow(app.db, { userId: made.value.id, brief: `${username}.` });
      return made.value;
    };
    owner = await make("alice", false);
    reader = await make("reader", false);
    builder = await make("builder", true);
    reviewer = await make("reviewer", true);
    promote(app.db, getUserByName(app.db, "alice")!);
    const made = await createRepo(app.db, app.reposRoot, {
      ownerId: owner.id,
      name: "back",
      visibility: "public",
      description: "back",
    });
    if (!made.ok) throw new Error(`seed repo: ${made.error}`);
    repo = made.value;
    for (const agent of [builder, reviewer]) addCrew(app.db, repo.id, agent.id, owner.id);
    seatAs(app.db, repo.id, reviewer.id, "reviewer");
    cookie = await signIn("alice", "a-good-passphrase");
    readerCookie = await signIn("reader", "a-good-passphrase");
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  test("the button is on a crew pull's card and not on a person's", async () => {
    const crew = handedOver(builder, "Crew pull");
    const mine = handedOver(owner, "Person pull");
    expect(asking(crew)).toBe(true);
    expect(asking(mine)).toBe(true);
    const html = await page();
    expect(html.split("Give back to the crew").length - 1).toBe(1);
    expect(html).toContain(`id="ask-handover:${crew}-back"`);
    expect(html).not.toContain(`id="ask-handover:${mine}-back"`);
    expect((await post(`handover:${mine}`)).status).not.toBe(303);
    expect(getIssueById(app.db, mine)!.assigneeId).toBeNull();
  });

  test("a foreign Origin is refused and a reader gets 404", async () => {
    const crew = handedOver(builder, "Guarded");
    expect((await post(`handover:${crew}`, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(`handover:${crew}`, {}, readerCookie)).status).toBe(404);
    expect(getIssueById(app.db, crew)!.assigneeId).toBeNull();
    expect(asking(crew)).toBe(true);
  });

  test("the post assigns the builder, comments, and the card leaves", async () => {
    const crew = handedOver(builder, "Given back");
    const res = await post(`handover:${crew}`);
    expect(res.status).toBe(303);
    expect(getIssueById(app.db, crew)!.assigneeId).toBe(builder.id);
    expect(listComments(app.db, crew).map((c) => c.body)).toContain("Given back to the crew by @alice");
    expect(asking(crew)).toBe(false);
  });

  test("the issue a person holds goes to the builder too; one an agent holds is left alone", async () => {
    const mine = heldIssue(owner);
    const theirs = heldIssue(builder);
    const crew = handedOver(builder, "Closes two", `Closes #${mine.number}\nCloses #${theirs.number}`);
    expect((await post(`handover:${crew}`)).status).toBe(303);
    expect(getIssueById(app.db, crew)!.assigneeId).toBe(builder.id);
    expect(getIssueById(app.db, mine.id)!.assigneeId).toBe(builder.id);
    // Still the builder's, untouched: no second assignment event.
    expect(getIssueById(app.db, theirs.id)!.assigneeId).toBe(builder.id);
    const other = heldIssue(reviewer);
    const second = handedOver(builder, "Closes the reviewer's", `Closes #${other.number}`);
    expect((await post(`handover:${second}`)).status).toBe(303);
    expect(getIssueById(app.db, other.id)!.assigneeId).toBe(reviewer.id);
  });

  test("when the issue cannot be assigned nothing is done and the card stays", async () => {
    const mine = heldIssue(owner);
    const crew = handedOver(builder, "Half done", `Closes #${mine.number}`);
    // Archived: assigning an agent is refused, so the whole give-back is.
    app.db.query("UPDATE repo SET archived_at = ?2 WHERE id = ?1").run(repo.id, new Date().toISOString());
    const res = await post(`handover:${crew}`);
    app.db.query("UPDATE repo SET archived_at = NULL WHERE id = ?1").run(repo.id);
    expect(res.status).not.toBe(303);
    expect(getIssueById(app.db, crew)!.assigneeId).toBeNull();
    expect(getIssueById(app.db, mine.id)!.assigneeId).toBe(owner.id);
    expect(listComments(app.db, crew).map((c) => c.body)).not.toContain("Given back to the crew by @alice");
    expect(asking(crew)).toBe(true);
  });

  test("the planner's one-more-round comment gives the pull back and starts a run; no one else's does", async () => {
    const planner = await createUser(app.db, {
      username: "planner",
      email: "planner@forge.test",
      agent: true,
      origin: "agent",
    });
    if (!planner.ok) throw new Error(planner.error);
    createAgentRow(app.db, { userId: planner.value.id, brief: "plans." });
    addCrew(app.db, repo.id, planner.value.id, owner.id);
    seatAs(app.db, repo.id, planner.value.id, "planner");
    const fake = join(dataDir, "fake-claude.sh");
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","total_cost_usd":0.01,"num_turns":1}'
`,
    );
    chmodSync(fake, 0o755);
    const crew = await startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: fake,
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
    });
    const runsOn = (issueId: string): number =>
      app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM run WHERE issue_id = ?1").get(issueId)!.n;
    const say = (user: User, pullId: string, body: string): void => {
      const pull = getIssueById(app.db, pullId)!;
      const said = addComment(app, user, repo, pull, body);
      if (!said.ok) throw new Error(String(said.error));
    };
    try {
      const one = handedOver(builder, "Planner sends it back", "", true);
      const two = handedOver(builder, "Someone else asks", "", true);
      const plain = handedOver(builder, "Planner says something else", "", true);
      const person = handedOver(owner, "A person's pull");
      say(planner.value, one, "Planner, one more round: change only the heading.");
      say(reader, two, "Planner, one more round: please");
      say(reviewer, two, "Planner, one more round: please");
      say(planner.value, plain, "Re-scoped; nothing to add.");
      say(planner.value, person, "Planner, one more round: go");
      for (let i = 0; i < 100 && runsOn(one) === 0; i++) await Bun.sleep(50);
      expect(getIssueById(app.db, one)!.assigneeId).toBe(builder.id);
      expect(runsOn(one)).toBeGreaterThan(0);
      // The planner is an agent, not a director: the hand-over stands.
      expect(handoverOf(app.db, repo, one)).toBeDefined();
      for (const other of [two, plain, person]) {
        expect(runsOn(other)).toBe(0);
      }
      expect(getIssueById(app.db, person)!.assigneeId).toBeNull();
    } finally {
      await crew.stop();
    }
  });

  test("the terminal: b gives the row back, and a reader's b does nothing", async () => {
    const crew = handedOver(builder, "Terminal pull");
    const drive = async (user: User, keys: string[]) => {
      const terminal = headlessTerminal(140, 40);
      const { app: ui } = createForgeApp(
        app,
        { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user },
        { terminal, exitHooks: false },
      );
      ui.start();
      await settleApp(ui);
      for (const key of keys) {
        ui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
        await settleApp(ui);
      }
      const text = ui.screen.toText();
      ui.stop();
      return text;
    };
    const reader = getUserByName(app.db, "reader")!;
    await drive(reader, ["tab", "b"]);
    expect(getIssueById(app.db, crew)!.assigneeId).toBeNull();
    // Earlier tests left other handed-over rows: step down until this one is given back.
    const keys = ["tab"];
    for (let n = 0; n < 8; n++) keys.push("b", "j");
    await drive(owner, keys);
    expect(getIssueById(app.db, crew)!.assigneeId).toBe(builder.id);
    expect(asking(crew)).toBe(false);
  });
});
