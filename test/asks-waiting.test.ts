/**
 * The asks list holds every pull waiting on a person (#3256): one handed
 * over, or untouched by a person for a day whatever its check says. A crew
 * pull still young stays the crew's.
 */

import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addCrew, createAgentRow } from "../src/core/agents.ts";
import { addComment } from "../src/core/issues.ts";
import { setHold } from "../src/core/holds.ts";
import { createRepo, type Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { id } from "../src/kernel/id.ts";
import { askLinesFor } from "../src/web/studio/asks.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const ZERO = "0".repeat(40);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

interface Row {
  id: string;
  kind: string;
  why?: string;
  recommendation?: { verdict: string; reason: string };
}

describe("asks that wait on a person", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let owner: User;
  let builder: User;
  let reviewer: User;
  let repo: Repo;
  let token = "";
  let seq = 0;

  const user = async (username: string, agent: boolean) => {
    const made = await createUser(app.db, {
      username,
      email: `${username}@forge.test`,
      ...(agent
        ? { agent: true, origin: "agent" as const }
        : { password: "a-good-passphrase", origin: "seed" as const, trusted: true, adminIfFirst: true }),
    });
    if (!made.ok) throw new Error(`seed ${username}: ${made.error}`);
    if (agent) createAgentRow(app.db, { userId: made.value.id, brief: `${username}.` });
    return made.value;
  };

  const pull = (author: User, title: string, age: number) => {
    const issueId = id();
    const number = app.db
      .query<{ issue_seq: number }, [string]>(
        "UPDATE repo SET issue_seq = issue_seq + 1 WHERE id = ?1 RETURNING issue_seq",
      )
      .get(repo.id)!.issue_seq;
    app.db
      .query(
        `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at)
         VALUES (?1, ?2, ?3, 'pull', ?4, '', ?5, 'open', ?6)`,
      )
      .run(issueId, repo.id, number, title, author.id, hoursAgo(age));
    app.db
      .query(
        `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id)
         VALUES (?1, 'main', ?2, ?3, ?3, ?4)`,
      )
      .run(issueId, `b/${++seq}`, ZERO, repo.id);
    return issueId;
  };

  const rows = async (): Promise<Row[]> => {
    const res = await fetch(`${servers.url}/api/v1/asks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return ((await res.json()) as { rows: Row[] }).rows;
  };

  let handed = "";
  let old = "";
  let young = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-asks-waiting-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    owner = await user("alice", false);
    builder = await user("builder", true);
    reviewer = await user("reviewer", true);
    const made = await createRepo(app.db, app.reposRoot, {
      ownerId: owner.id,
      name: "wait",
      visibility: "public",
      description: "wait",
    });
    if (!made.ok) throw new Error(`seed repo: ${made.error}`);
    repo = made.value;
    for (const agent of [builder, reviewer]) addCrew(app.db, repo.id, agent.id, owner.id);
    seatAs(app.db, repo.id, reviewer.id, "reviewer");
    token = createToken(app.db, owner.id, "ro", "ro").token;

    handed = pull(builder, "Handed over", 3);
    for (let r = 0; r < 3; r++)
      submitReview(app.db, {
        issueId: handed,
        authorId: reviewer.id,
        state: "changes_requested",
        body: `Round ${r}.`,
        commitOid: ZERO,
      });
    old = pull(owner, "Thirty hours", 30);
    young = pull(builder, "Two hours", 2);
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("lists the handed-over pull and the 30 h pull, each with its why, and not the young crew pull", async () => {
    const got = await rows();
    expect(got.map((r) => r.id).sort()).toEqual([`handover:${handed}`, `waiting:${old}`].sort());
    const byKind = new Map(got.map((r) => [r.kind, r]));
    expect(byKind.get("handover")!.why).toContain("three reviews asked for changes");
    expect(byKind.get("waiting")!.why).toBe("waiting 30 hours");
    expect(got.some((r) => r.id.endsWith(young))).toBe(false);
  });

  test("a handed-over row carries the crew's recommendation too", async () => {
    addComment(app.db, {
      issueId: handed,
      authorId: reviewer.id,
      body: "Recommendation: close — three rounds and no progress.",
    });
    const row = (await rows()).find((r) => r.id === `handover:${handed}`)!;
    expect(row.recommendation).toEqual({ verdict: "close", reason: "three rounds and no progress." });
  });

  test("a pull the viewer holds never asks again for being idle", async () => {
    const held = pull(builder, "Held aside", 50);
    expect((await rows()).some((r) => r.id === `waiting:${held}`)).toBe(true);
    setHold(app.db, held, owner.id, "later");
    expect((await rows()).some((r) => r.id === `waiting:${held}`)).toBe(false);
  });

  test("/asks shows the Waiting row, its advice, and a pick box to ship or close it with the rest", async () => {
    const adv = pull(builder, "Advised idle", 40);
    addComment(app.db, { issueId: adv, authorId: reviewer.id, body: "Recommendation: change — rename the flag <b>." });
    const signed = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
      redirect: "manual",
    });
    const cookie = (signed.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await (
      await fetch(`${servers.url}/asks`, { headers: { cookie: `${cookie}; forge_mode=studio` } })
    ).text();
    expect(page).toContain("Waiting");
    expect(page).toContain("Advised idle");
    expect(page).toContain("The crew advises: change");
    expect(page).toContain("rename the flag &lt;b&gt;.");
    expect(page).not.toContain("flag <b>");
    // The row can be acted on where it stands: ship and close forms, a word, no Settings dead end.
    const row = page.slice(page.indexOf("Advised idle") - 1500, page.indexOf("Advised idle") + 2500);
    expect(page).toMatch(/<form id="ask-waiting:[^"]+" method="post" hidden action="[^"]*\/pulls\/\d+\/ship">/);
    expect(page).toMatch(/<form id="ask-waiting:[^"]+-close" method="post" hidden action="[^"]*\/pulls\/\d+\/state">/);
    expect(page).toContain("Say what to change");
    expect(row).not.toContain("/settings/autonomy");
    expect(page).toContain(">Handed over<");
    expect(page).toMatch(/<label class="check"><input[^>]*name="item"[^>]*value="waiting:[^"]+"[^>]*data-kind="waiting"/);
  });

  test("the MCP asks tool carries the waiting kind, its why and the recommendation", async () => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "asks", arguments: {} } }),
    });
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    const got = JSON.parse(body.result.content[0]!.text) as { rows: Row[] };
    const waiting = got.rows.filter((r) => r.kind === "waiting");
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting.every((r) => r.why?.startsWith("waiting "))).toBe(true);
    expect(waiting.some((r) => r.recommendation?.verdict === "change")).toBe(true);
  });

  test("the terminal lists the waiting pull with its advice, for its viewer only", async () => {
    const lines = askLinesFor(app.db, owner);
    expect(lines.some((r) => r.kind === "waiting")).toBe(true);
    const sees = async (user: User) => {
      const terminal = headlessTerminal(240, 40);
      const { app: ui } = createForgeApp(
        app,
        { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user },
        { terminal, exitHooks: false },
      );
      ui.start();
      await settleApp(ui);
      for (const key of ["tab", "j"]) {
        ui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
        await settleApp(ui);
      }
      const text = ui.screen.toText();
      ui.stop();
      return text;
    };
    const mine = await sees(owner);
    expect(mine).toContain("waiting ");
    expect(mine).toContain("crew advises: change");
    expect(await sees(builder)).not.toContain("crew advises");
  });

  test("the terminal's handed-over row says what the crew advised", async () => {
    const terminal = headlessTerminal(240, 60);
    const { app: ui } = createForgeApp(
      app,
      { sshUsername: owner.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: owner },
      { terminal, exitHooks: false },
    );
    ui.start();
    await settleApp(ui);
    const text = ui.screen.toText();
    ui.stop();
    expect(text).toContain("handed over");
    expect(text).toContain("crew advises: close — three rounds and no progress.");
  });

  test("a person's word restarts the clock; the crew's recommendation rides along", async () => {
    addComment(app.db, {
      issueId: old,
      authorId: reviewer.id,
      body: "Recommendation: merge — the diff is small and green.",
    });
    const advised = (await rows()).find((r) => r.id === `waiting:${old}`)!;
    expect(advised.recommendation).toEqual({ verdict: "merge", reason: "the diff is small and green." });

    const said = addComment(app.db, { issueId: old, authorId: owner.id, body: "Looking." });
    if (!said.ok) throw new Error(said.error);
    expect((await rows()).some((r) => r.id === `waiting:${old}`)).toBe(false);
  });

  test("bulk close and bulk ship take a waiting:<id> item through the same checks", async () => {
    const rw = createToken(app.db, owner.id, "rw", "rw").token;
    const post = async (action: string, items: string[]) => {
      const res = await fetch(`${servers.url}/api/v1/asks/bulk`, {
        method: "POST",
        headers: { authorization: `Bearer ${rw}`, "content-type": "application/json" },
        body: JSON.stringify({ action, items, preview: false }),
      });
      return (await res.json()) as { rows: { outcome: string; reason?: string }[]; skipped: unknown[] };
    };
    const a = pull(builder, "Bulk close me", 60);
    const closed = await post("close", [`waiting:${a}`]);
    expect(closed.rows.map((r) => r.outcome)).toEqual(["ok"]);
    expect((await rows()).some((r) => r.id === `waiting:${a}`)).toBe(false);
    const b = pull(builder, "Bulk ship me", 60);
    const shipped = await post("ship", [`waiting:${b}`]);
    expect(shipped.skipped).toEqual([]);
    expect(shipped.rows).toHaveLength(1);
  });
});
