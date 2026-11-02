/**
 * A proof is a run (#7706): the doors read it — MCP `runs`, the API, the
 * terminal's runs list, `/runs/<id>` — and a push ends the old head's wait.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import { endProofRun, getProofRun, openProofRun } from "../src/core/proof_runs.ts";
import type { Repo } from "../src/core/repos.ts";
import { createRun, getRun, listRuns } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { runsScreen } from "../src/tui/screens/runs.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { runStateBadge } from "../src/web/ui.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("proof runs through the doors", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let pullId: string;
  let token: string;
  let rpc = 1;

  const mcp = async (args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: rpc++, method: "tools/call", params: { name: "runs", arguments: args } }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-proof-runs-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const u = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
      password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    alice = u.value;
    token = createToken(app.db, alice.id, "ro", "ro").token;
    const made = await createRepo(app, alice, { name: "vault", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const issue = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title: "A pull" });
    if (!issue.ok) throw new Error(issue.error);
    pullId = issue.value.id;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const open = (head: string, state: "queued" | "running" = "queued", summary = "no check slot is spare") =>
    openProofRun(app.db, { repoId: repo.id, pullId, head, base: "b".repeat(40), state, summary });

  test("a new head ends the old head's waiting proof as superseded, and leaves the new one queued", () => {
    const old = open("a".repeat(40));
    const fresh = open("c".repeat(40));
    const ended = getProofRun(app.db, old.id)!;
    expect(ended.state).toBe("cancelled");
    expect(ended.summary).toBe("superseded by a push");
    expect(ended.finishedAt).not.toBeNull();
    expect(getProofRun(app.db, fresh.id)!.state).toBe("queued");
    endProofRun(app.db, fresh.id, "ok", "green");
  });

  test("MCP runs lists proofs unfiltered and filters by kind=proof; a bad kind is refused", async () => {
    createRun(app.db, { repoId: repo.id, kind: "deploy", env: "production", reason: "push" });
    const proof = open("d".repeat(40), "running", "");
    const all = await mcp({ repo: "alice/vault" });
    expect(all.value.runs.map((r: any) => r.kind)).toContain("proof");
    const only = await mcp({ repo: "alice/vault", kind: "proof" });
    expect(only.value.runs.length).toBeGreaterThan(0);
    expect(only.value.runs.every((r: any) => r.kind === "proof")).toBe(true);
    expect(only.value.runs[0].id).toBe(proof.id);
    const deploys = await mcp({ repo: "alice/vault", kind: "deploy" });
    expect(deploys.value.runs.every((r: any) => r.kind === "deploy")).toBe(true);
    expect((await mcp({ repo: "alice/vault", kind: "bogus" })).error).toContain("kind");
    endProofRun(app.db, proof.id, "failed", "red");
  });

  test("the API filters ?kind=proof", async () => {
    const res = await fetch(`${servers.url}/api/v1/repos/alice/vault/runs?kind=proof`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body: any = await res.json();
    const items = body.items ?? body.runs ?? body;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((r: any) => r.kind === "proof")).toBe(true);
  });

  test("callers that omit kind still read only `run`; the lists ask for proofs", () => {
    expect(listRuns(app.db, repo.id).some((r) => r.kind === "proof")).toBe(false);
    expect(listRuns(app.db, repo.id, { withProofs: true }).some((r) => r.kind === "proof")).toBe(true);
    expect(listRuns(app.db, repo.id, { kind: "proof", env: "production" })).toEqual([]);
  });

  test("the merged list pages across both tables with no run lost or repeated", () => {
    createRun(app.db, { repoId: repo.id, kind: "deploy", env: "production", reason: "push" });
    open("9".repeat(40), "running", "");
    createRun(app.db, { repoId: repo.id, kind: "agent", reason: "assigned" });
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const page = listRuns(app.db, repo.id, { withProofs: true, limit: 2, ...(cursor ? { cursor } : {}) });
      if (page.length === 0) break;
      seen.push(...page.map((r) => r.id));
      cursor = page[page.length - 1]!.id;
    }
    const whole = listRuns(app.db, repo.id, { withProofs: true, limit: 200 }).map((r) => r.id);
    expect(seen).toEqual(whole);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...whole].sort().reverse()).toEqual(whole);
    expect(whole.length).toBeGreaterThanOrEqual(7);
  });

  test("the badges name a proof's states Green, Cut off and Failed", () => {
    expect(String(runStateBadge("ok", "proof"))).toContain("Green");
    expect(String(runStateBadge("cancelled", "proof"))).toContain("Cut off");
    expect(String(runStateBadge("queued", "proof"))).toContain("Queued");
    expect(String(runStateBadge("ok", "check"))).toContain("Passed");
  });

  test("/runs/<id> opens a proof run, and its short door finds it", async () => {
    const run = open("e".repeat(40), "running", "");
    endProofRun(app.db, run.id, "ok", "green");
    expect(getRun(app.db, run.id)!.kind).toBe("proof");
    const page = await fetch(`${servers.url}/alice/vault/runs/${run.id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Proof of eeeeeee");
    const api = await fetch(`${servers.url}/api/v1/repos/alice/vault/runs/${run.id}`, { headers: { authorization: `Bearer ${token}` } });
    expect(((await api.json()) as any).kind).toBe("proof");
  });

  test("the terminal's runs list shows a proof row with its summary", async () => {
    const run = open("f".repeat(40), "queued", "no check slot is spare");
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: "alice", remoteAddress: "127.0.0.1", user: alice },
      { terminal: headlessTerminal(140, 30), exitHooks: false },
    );
    tui.start();
    await settleApp(tui);
    tui.push(runsScreen(session, tui.ctx, repo));
    await settleApp(tui);
    const text = tui.screen.toText();
    expect(text).toContain("Proof of fffffff");
    expect(text).toContain("no check slot is spare");
    tui.stop();
    endProofRun(app.db, run.id, "cancelled", "cut off: the forge stopped");
  });
});
