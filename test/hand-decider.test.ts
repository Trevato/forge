/**
 * "Let the decider" on a hand-over card: a stand-in model answers (no real
 * call), the ledger row carries the context it saw, an unsure answer stays
 * with the owner, and undo restores the card for a day.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addComment, openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp as registerApp } from "../src/core/apps.ts";
import { getDecision, listDecisions } from "../src/core/decisions.ts";
import type { Issue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { decideAsk } from "../src/actions/asks_decide.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { BREAKER_NOTE } from "../src/crew/breaker.ts";
import type { Decider } from "../src/crew/decide.ts";
import {
  HAND_UNDO_MS,
  handContext,
  undoHandled,
} from "../src/crew/handover.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { askLinesFor } from "../src/web/studio/asks.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

describe("let the decider answer a hand-over", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let cookie = "";
  let alice: User;
  let repo: Repo;
  let seen: unknown[] = [];
  /** What the stand-in model says about a hand-over: set per test. */
  let says = 0.9;

  const standIn: Decider = {
    name: "stand-in",
    async decide(state, questions) {
      seen.push(state);
      const out: Record<string, any> = {};
      for (const [key, q] of Object.entries(questions)) {
        const [a, b] = q.options as [string, string];
        out[key] = {
          choice: a,
          p: says,
          probabilities: { [a]: says, [b]: 1 - says },
        };
      }
      return out as any;
    },
  };

  const parked = (title: string): Issue => {
    const made = openIssue(app, alice, repo, { title });
    if (!made.ok) throw new Error(String(made.error));
    expect(addComment(app, alice, repo, made.value, BREAKER_NOTE).ok).toBe(true);
    return made.value;
  };

  const asking = (issue: Issue): boolean =>
    askLinesFor(app.db, alice).some((r) => r.items.includes(`parked:${issue.id}`));

  const post = (path: string, fields: [string, string][] = []) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      headers: { cookie, origin: servers.url },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });

  const home = async (path = "/asks"): Promise<string> =>
    (await (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text()).replace(/\s+/g, " ");

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-hand-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.test",
      password: "a-long-hand-passphrase",
    });
    if (!made.ok) throw new Error("no alice");
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: "a-long-hand-passphrase" }),
      redirect: "manual",
    });
    cookie = `${(signin.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=studio`;
    alice = getUserByName(app.db, "alice")!;
    promote(app.db, alice);
    const r = await createRepo(app, alice, { name: "shelf", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    registerApp(app.db, { repoId: repo.id, slug: "shelf", access: "private" });
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# shelf\n" }],
    });
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    // Stops the pollers and the pooled git readers before their directory goes.
    app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  test("without a decider there is no third tap, and a post is refused", async () => {
    const issue = parked("no decider");
    expect((await home()).includes("Let the decider")).toBe(false);
    const res = await post("/asks/decide", [["ask", `parked:${issue.id}`]]);
    expect(res.status).not.toBe(303);
    expect(asking(issue)).toBe(true);
    expect(listDecisions(app.db, repo.id, { kind: "hand" })).toHaveLength(0);
  });

  test("a sure answer sets the card aside, in the ledger, with the context it saw", async () => {
    app.config.decider = standIn;
    says = 0.9;
    const issue = parked("old idea");
    expect((await home()).includes("Let the decider")).toBe(true);
    const res = await post("/asks/decide", [["ask", `parked:${issue.id}`]]);
    expect(res.status).toBe(303);
    expect(asking(issue)).toBe(false);
    const [row] = listDecisions(app.db, repo.id, { kind: "hand" });
    expect(row!.by).toBe("stand-in");
    expect(row!.answer).toBe("set_aside");
    expect(row!.p).toBeCloseTo(0.9);
    expect(row!.outcome).toBe("set_aside");
    const state = row!.state as any;
    expect(state.reason).toContain("90%");
    expect(state.repository).toEqual({ name: "shelf", pinned: false, muted: false });
    expect(state.spend.ceilingUsd).toBe(repo.autonomyCeilingUsd);
    expect(state.evidence.title).toBe("old idea");
    expect(state.evidence.reasons.length).toBe(1);
    expect(Array.isArray(state.recent)).toBe(true);
    // What the model was sent is what the row shows.
    expect(seen.at(-1)).toEqual(handContext(app, alice, repo, issue));
    // The board's ledger row says why; the home carries the receipt with Undo.
    const board = await home("/board");
    expect(board.includes("hand-over")).toBe(true);
    expect(board.includes("Saw:")).toBe(true);
    // Its why is the decider's own words: one clamped line, whole in its title (#10199).
    expect(board).toMatch(/<span class="row-note" title="[^"]*Saw:[^"]*">[^<]*Saw:/);
    const receipt = await home(res.headers.get("location")!);
    expect(receipt.includes("90% sure")).toBe(true);
    expect(receipt.includes(`/asks/decide/${row!.id}/undo`)).toBe(true);
  });

  test("an unsure answer goes back to the owner: the card stays", async () => {
    says = 0.55;
    const issue = parked("hard call");
    const res = await post("/asks/decide", [["ask", `parked:${issue.id}`]]);
    expect(res.status).toBe(303);
    expect(asking(issue)).toBe(true);
    const row = listDecisions(app.db, repo.id, { kind: "hand" })[0]!;
    expect(row.answer).toBe("ask_owner");
    expect(row.outcome).toBe("asked");
    expect((await home(res.headers.get("location")!)).includes("Unsure (55%")).toBe(true);
  });

  test("a decider that fails leaves the card with the owner", async () => {
    app.config.decider = {
      name: "down",
      async decide() {
        throw new Error("down");
      },
    };
    const issue = parked("decider is down");
    await post("/asks/decide", [["ask", `parked:${issue.id}`]]);
    expect(asking(issue)).toBe(true);
    const row = listDecisions(app.db, repo.id, { kind: "hand" })[0]!;
    expect(row.by).toBe("rule");
    expect(row.answer).toBe("ask_owner");
    app.config.decider = standIn;
  });

  test("undo puts the card back, once, and not after a day", async () => {
    says = 0.95;
    const issue = parked("changed my mind");
    const res = await post("/asks/decide", [["ask", `parked:${issue.id}`]]);
    expect(asking(issue)).toBe(false);
    const id = /decided=([A-Za-z0-9_-]+)/.exec(res.headers.get("location")!)![1]!;
    const undone = await post(`/asks/decide/${id}/undo`);
    expect(undone.status).toBe(303);
    expect(asking(issue)).toBe(true);
    expect(getDecision(app.db, id)!.outcome).toBe("undone");
    expect((await post(`/asks/decide/${id}/undo`)).status).toBe(404);

    const late = parked("too late to undo");
    const again = await post("/asks/decide", [["ask", `parked:${late.id}`]]);
    const lateId = /decided=([A-Za-z0-9_-]+)/.exec(again.headers.get("location")!)![1]!;
    const row = getDecision(app.db, lateId)!;
    const after = Date.parse(row.createdAt) + HAND_UNDO_MS + 1000;
    expect(undoHandled(app, alice, lateId, after)).toBe("too_late");
    expect(asking(late)).toBe(false);
  });

  test("only the owner's own cards: a stranger, a pull's id or a forged origin does nothing", async () => {
    says = 0.99;
    const issue = parked("not for bob");
    const bob = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.test",
      password: "a-long-hand-passphrase",
    });
    if (!bob.ok) throw new Error("no bob");
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "bob", password: "a-long-hand-passphrase" }),
      redirect: "manual",
    });
    const bobCookie = `${(signin.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=studio`;
    const count = listDecisions(app.db, repo.id, { kind: "hand" }).length;
    const asBob = await fetch(`${servers.url}/asks/decide`, {
      method: "POST",
      headers: { cookie: bobCookie, origin: servers.url },
      body: new URLSearchParams([["ask", `parked:${issue.id}`]]),
      redirect: "manual",
    });
    expect(asBob.status).not.toBe(303);
    const forged = await fetch(`${servers.url}/asks/decide`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.example" },
      body: new URLSearchParams([["ask", `parked:${issue.id}`]]),
      redirect: "manual",
    });
    expect(forged.status).toBeGreaterThanOrEqual(400);
    const wrongKind = await post("/asks/decide", [["ask", `look:${issue.id}`]]);
    expect(wrongKind.status).not.toBe(303);
    expect(listDecisions(app.db, repo.id, { kind: "hand" })).toHaveLength(count);
    expect(asking(issue)).toBe(true);
  });

  describe("the other doors", () => {
    const api = async (token: string, path: string, payload: unknown = {}) => {
      const res = await fetch(`${servers.url}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      return { status: res.status, body: (await res.json()) as any };
    };
    const mcp = async (token: string, name: string, args: unknown) => {
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
      return { error: body.result.isError === true, text: body.result.content[0]!.text };
    };
    let rw = "";
    let ro = "";
    let bobRw = "";
    beforeAll(() => {
      rw = createToken(app.db, alice.id, "rw", "rw").token;
      ro = createToken(app.db, alice.id, "ro", "ro").token;
      bobRw = createToken(app.db, getUserByName(app.db, "bob")!.id, "rw", "rw").token;
      app.config.decider = standIn;
      says = 0.9;
    });

    test("the JSON API answers, refuses a read-only token and a stranger, and undoes", async () => {
      const issue = parked("api card");
      expect((await api(ro, "/api/v1/asks/decide", { item: `parked:${issue.id}` })).status).toBe(403);
      expect((await api(bobRw, "/api/v1/asks/decide", { item: `parked:${issue.id}` })).status).toBe(404);
      expect(asking(issue)).toBe(true);
      const done = await api(rw, "/api/v1/asks/decide", { item: `parked:${issue.id}` });
      expect(done.status).toBe(201);
      expect(done.body.answer).toBe("set_aside");
      expect(done.body.context.evidence.title).toBe("api card");
      expect(asking(issue)).toBe(false);
      expect((await api(bobRw, `/api/v1/asks/decide/${done.body.id}/undo`)).status).toBe(404);
      expect((await api(ro, `/api/v1/asks/decide/${done.body.id}/undo`)).status).toBe(403);
      expect((await api(rw, `/api/v1/asks/decide/${done.body.id}/undo`)).status).toBe(201);
      expect(asking(issue)).toBe(true);
    });

    test("a card is handed over once in ten minutes: the second tap is refused and costs no call", async () => {
      says = 0.5;
      const issue = parked("tapped twice");
      const before = seen.length;
      expect((await api(rw, "/api/v1/asks/decide", { item: `parked:${issue.id}` })).status).toBe(201);
      const again = await api(rw, "/api/v1/asks/decide", { item: `parked:${issue.id}` });
      expect(again.status).toBe(429);
      expect(seen.length).toBe(before + 1);
      says = 0.9;
    });

    test("MCP: asks_decide is a write, refused read-only, and undone by asks_undecide", async () => {
      const issue = parked("mcp card");
      const item = `parked:${issue.id}`;
      expect((await mcp(ro, "asks_decide", { item })).error).toBe(true);
      expect(asking(issue)).toBe(true);
      expect((await mcp(createToken(app.db, getUserByName(app.db, "bob")!.id, "b", "rw").token, "asks_decide", { item })).error).toBe(true);
      const done = await mcp(rw, "asks_decide", { item });
      expect(done.error).toBe(false);
      expect(asking(issue)).toBe(false);
      const id = JSON.parse(done.text).id as string;
      expect((await mcp(ro, "asks_undecide", { id })).error).toBe(true);
      expect((await mcp(rw, "asks_undecide", { id })).error).toBe(false);
      expect(asking(issue)).toBe(true);
    });

    test("the terminal's door: a parked row is on the On you card, D hands it over, U takes it back", async () => {
      app.config.decider = standIn;
      says = 0.9;
      parked("tui card");
      const terminal = headlessTerminal(140, 40);
      const { app: ui } = createForgeApp(
        app,
        { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: alice },
        { terminal, exitHooks: false },
      );
      ui.start();
      const press = async (key: string) => {
        ui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
        await settleApp(ui);
      };
      await settleApp(ui);
      await press("tab");
      expect(ui.screen.toText()).toContain("tui card");
      expect(ui.screen.toText()).toContain("D let the decider");
      // The cursor is on the first parked row; earlier tests left others.
      const parkedNow = () =>
        askLinesFor(app.db, alice).flatMap((r) => r.items).filter((i) => i.startsWith("parked:")).length;
      const before = parkedNow();
      await press("D");
      expect(parkedNow()).toBe(before - 1);
      expect(ui.screen.toText()).toContain("U undo decider");
      await press("U");
      expect(parkedNow()).toBe(before);
      ui.stop();
    });

    test("the ledger API gives a hand-over's private part to its tapper only", async () => {
      app.config.decider = standIn;
      says = 0.9;
      const issue = parked("private part");
      expect((await decideAsk(app, alice, `parked:${issue.id}`)).ok).toBe(true);
      const read = async (headers: Record<string, string>) => {
        const res = await fetch(`${servers.url}/api/v1/repos/alice/shelf/decisions`, { headers });
        const rows = ((await res.json()) as any).decisions.filter((d: any) => d.issueId === issue.id);
        expect(rows).toHaveLength(1);
        return rows[0].state;
      };
      const mine = await read({ cookie });
      expect(mine.actor).toBe(alice.id);
      expect(mine.recent).toBeDefined();
      expect(mine.repository.pinned).toBe(false);
      const bob = getUserByName(app.db, "bob")!;
      for (const headers of [
        {},
        { authorization: `Bearer ${createToken(app.db, bob.id, "b2", "ro").token}` },
      ]) {
        const seenBy = await read(headers);
        expect(seenBy.actor).toBeUndefined();
        expect(seenBy.recent).toBeUndefined();
        expect(seenBy.repository.pinned).toBeUndefined();
        expect(seenBy.repository.muted).toBeUndefined();
        expect(seenBy.reason).toBeDefined();
      }
    });

    test("two quick taps pay once", async () => {
      says = 0.5;
      const issue = parked("double tap");
      const before = seen.length;
      const [a, b] = await Promise.all([
        decideAsk(app, alice, `parked:${issue.id}`),
        decideAsk(app, alice, `parked:${issue.id}`),
      ]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      expect(seen.length).toBe(before + 1);
      says = 0.9;
    });

    test("a co-owner who dismissed the same card cannot undo someone else's decision", async () => {
      says = 0.9;
      const issue = parked("not carol's undo");
      const done = await decideAsk(app, alice, `parked:${issue.id}`);
      if (!done.ok) throw new Error("no decision");
      const carol = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: "carol",
        email: "carol@forge.test",
        password: "a-long-hand-passphrase",
      });
      if (!carol.ok) throw new Error("no carol");
      app.db
        .query("INSERT INTO interaction (id, viewer_id, item_id, kind, repo_id, actor_id) SELECT 'x'||id, ?1, item_id, kind, repo_id, ?1 FROM interaction WHERE viewer_id = ?2 AND item_id = ?3 LIMIT 1")
        .run(carol.value.id, alice.id, `ask:parked:${issue.id}`);
      expect(undoHandled(app, carol.value, done.value.id)).toBe("not_found");
      expect(getDecision(app.db, done.value.id)!.outcome).toBe("set_aside");
    });
  });
});
