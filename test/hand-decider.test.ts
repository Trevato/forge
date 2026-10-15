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
import { quietLogs } from "./helpers/globals.ts";

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

  const home = async (path = "/"): Promise<string> =>
    (await (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text()).replace(/\s+/g, " ");

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-hand-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
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
    await rm(dataDir, { recursive: true, force: true });
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
});
