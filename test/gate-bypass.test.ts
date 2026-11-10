/**
 * The gate cannot lock itself out (#7790): three red gates of one cause say
 * landing has stopped, in the flow alarms (owner-only); only then, and only
 * on the forge's own repository, an owner lands one named pull past the
 * checks with a recorded reason, from the page, the MCP and the terminal.
 * Review and conflicts still hold; the next pull lands normally.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { landPastGate } from "../src/checks/bypass.ts";
import { landingStopped } from "../src/checks/gate_stopped.ts";
import { keepGateResult } from "../src/checks/gate_result.ts";
import { createAgentRow } from "../src/core/agents.ts";
import { claimRun, createRun, finishRun, setRunBase } from "../src/core/runs.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { listComments } from "../src/core/issues.ts";
import { updateRepoSettings, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { firedAlarms } from "../src/flow/alarms.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("landing past a broken gate", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let owner: User;
  let outsider: User;
  let agent: User;
  let repo: Repo;
  let other: Repo;
  let ownerCookie: string;
  let n = 0;
  const HOUR = 3_600_000;

  const pullIn = async (r: Repo, branch: string, file = `${branch}.txt`, content = `${branch}\n`) => {
    const made = await commitToBranch(app, owner, r, { branch, message: branch, files: [{ path: file, content }] });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    const opened = await openPull(app, owner, r, { title: branch, baseBranch: "main", headBranch: branch });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value;
  };
  const pullOf = (branch: string) => pullIn(repo, branch);
  const gate = (at: number, state: "red" | "green", failing: string[], reason = "tests") => {
    n += 1;
    keepGateResult(app.db, `gate-${String(n).padStart(4, "0")}`, {
      repoId: repo.id,
      runId: `gate-${n}`,
      tipOid: "a".repeat(40),
      pulls: [n],
      state,
      ...(state === "red" ? { reason } : {}),
      passed: 1,
      failed: failing.length,
      failing: failing.map((name) => ({ name, errors: [] })),
      startedAt: new Date(at).toISOString(),
      finishedAt: new Date(at).toISOString(),
    });
  };
  /** Three red gates of one cause, in the future so no earlier landing clears them. */
  const stop = () => {
    const t = Date.now() + HOUR;
    for (let i = 0; i < 3; i++) gate(t + i * 1000, "red", ["the gate > is broken", `unrelated ${i}`]);
  };
  const green = async (pull: Pull) => {
    const base = (await resolveOid(repoDir(app.reposRoot, "trevato", "forge"), "refs/heads/main"))!;
    const run = createRun(app.db, { repoId: repo.id, kind: "check", issueId: pull.id, env: "pull", commitOid: pull.headOid });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "all green" });
    setRunBase(app.db, run.id, base);
  };
  const post = (p: Pull, cookie: string | null, reason: string, extra: Record<string, string> = {}, bearer?: string) =>
    fetch(`${servers.url}/trevato/forge/pulls/${p.number}/land-past`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie === null ? {} : { cookie }),
        ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
        ...extra,
      },
      body: new URLSearchParams({ reason }),
    });
  const page = async (p: Pull, cookie: string) =>
    (await fetch(`${servers.url}/trevato/forge/pulls/${p.number}/files`, { headers: { cookie } })).text();
  const mcp = async (token: string, args: Record<string, unknown>) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "land_past_gate", arguments: args } }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };
  const isMerged = (p: Pull) => getPull(app.db, repo.id, p.number)?.mergedAt != null;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-bypass-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false, isAgent = false) => {
      const made = await createUser(app.db, {
        origin: isAgent ? "agent" : "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: isAgent ? "" : "a-good-passphrase",
        adminIfFirst: first,
        ...(isAgent ? { agent: true } : {}),
      });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    owner = await mk("trevato", true);
    outsider = await mk("mallory");
    agent = await mk("wright", false, true);
    createAgentRow(app.db, { userId: agent.id, brief: "Builds." });
    ownerCookie = `forge_session=${createSession(app.db, owner.id).token}`;
    for (const [name, mine] of [["forge", true], ["elsewhere", false]] as const) {
      const made = await createRepo(app, owner, { name, visibility: "public", description: "f" });
      if (!made.ok) throw new Error(JSON.stringify(made.error));
      const done = await commitToBranch(app, owner, made.value, { branch: "main", message: "seed", files: [{ path: "README.md", content: "x\n" }] });
      if (!done.ok) throw new Error(JSON.stringify(done.error));
      const set = updateRepoSettings(app.db, made.value, { requireChecks: true });
      if (mine) repo = set;
      else other = set;
    }
  }, 30_000);
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  beforeEach(() => {
    app.db.query("DELETE FROM gate_result").run();
    repo = updateRepoSettings(app.db, repo, { requireChecks: true, requireReview: false });
  });

  test("two red gates are not a stop; three of one cause are, in one sentence", () => {
    const t = Date.now() + HOUR;
    gate(t, "red", ["the gate > is broken"]);
    gate(t + 1, "red", ["the gate > is broken"]);
    expect(landingStopped(app.db, repo.id)).toBeUndefined();
    gate(t + 2, "red", ["the gate > is broken", "other"]);
    expect(landingStopped(app.db, repo.id)?.gates).toBe(3);
    const alarm = firedAlarms(app.db, new Date(), { dataDir: null }).find((a) => a.key === "landing_stopped");
    expect(alarm?.says).toStartWith("Landing has stopped:");
    expect(alarm?.says.split(". ").length).toBe(1);
  });

  test("the alarm is the owner's: a public-only reader never sees it", () => {
    stop();
    expect(firedAlarms(app.db, new Date(), { dataDir: null }).some((a) => a.key === "landing_stopped")).toBe(true);
    expect(firedAlarms(app.db, new Date(), { dataDir: null, publicOnly: true }).some((a) => a.key === "landing_stopped")).toBe(false);
  });

  test("three red gates of different causes, or mixed with a green, are not a stop", () => {
    const t = Date.now() + HOUR;
    gate(t, "red", ["a > broke"]);
    gate(t + 1, "red", ["b > broke"]);
    gate(t + 2, "red", ["c > broke"]);
    expect(landingStopped(app.db, repo.id)).toBeUndefined();
    gate(t + 3, "red", ["a > broke"]);
    gate(t + 4, "green", []);
    gate(t + 5, "red", ["a > broke"]);
    expect(landingStopped(app.db, repo.id)).toBeUndefined();
  });

  test("three reds followed by a landing do not alarm", async () => {
    const t = Date.now() - 5000;
    for (let i = 0; i < 3; i++) gate(t + i, "red", ["the gate > is broken"]);
    expect(landingStopped(app.db, repo.id)?.gates).toBe(3);
    const next = await pullOf("lands-after-reds");
    await green(next);
    expect((await mergePull(app, owner, repo, next, "squash")).ok).toBe(true);
    expect(landingStopped(app.db, repo.id)).toBeUndefined();
    expect(firedAlarms(app.db, new Date(), { dataDir: null }).some((a) => a.key === "landing_stopped")).toBe(false);
  });

  test("core: refused while landing is running, for an outsider, an agent, a short reason; then it lands and records", async () => {
    const fix = await pullOf("fix-the-gate");
    expect(await landPastGate(app, owner, repo, fix, "a fine reason here")).toEqual({ ok: false, error: { kind: "not_stopped" } });
    stop();
    expect((await mergePull(app, owner, repo, fix, "squash")).ok).toBe(false);
    expect(await landPastGate(app, outsider, repo, fix, "a fine reason here")).toEqual({ ok: false, error: { kind: "forbidden" } });
    expect(await landPastGate(app, agent, repo, fix, "a fine reason here")).toEqual({ ok: false, error: { kind: "forbidden" } });
    expect(await landPastGate(app, owner, repo, fix, "no")).toEqual({ ok: false, error: { kind: "reason" } });
    expect(isMerged(fix)).toBe(false);

    const landed = await landPastGate(app, owner, repo, fix, "the gate's own bug blocks its fix");
    expect(landed.ok).toBe(true);
    expect(isMerged(fix)).toBe(true);
    const bodies = listComments(app.db, fix.id).map((c) => c.body);
    expect(bodies.some((b) => b.includes("past the gate") && b.includes("the gate's own bug blocks its fix"))).toBe(true);
    const event = app.db.query<{ payload: string }, []>("SELECT payload FROM event WHERE kind = 'pull.bypassed'").get();
    expect(JSON.parse(event!.payload).reason).toBe("the gate's own bug blocks its fix");

    // The next pull needs its green and lands by the usual road.
    app.db.query("DELETE FROM gate_result").run();
    const next = await pullOf("next-change");
    expect((await mergePull(app, owner, repo, next, "squash")).ok).toBe(false);
    await green(next);
    expect((await mergePull(app, owner, repo, next, "squash")).ok).toBe(true);
  });

  test("core: only the forge's own repository has a break-glass", async () => {
    stop();
    const p = await pullIn(other, "elsewhere-change");
    expect(await landPastGate(app, owner, other, p, "a fine reason here")).toEqual({ ok: false, error: { kind: "not_stopped" } });
  });

  test("core: review and conflicts still hold, and the intent is on the trail even when the merge is refused", async () => {
    stop();
    repo = updateRepoSettings(app.db, repo, { requireReview: true });
    const unreviewed = await pullOf("needs-review");
    const held = await landPastGate(app, owner, repo, unreviewed, "a fine reason here");
    expect(held).toEqual({ ok: false, error: { kind: "merge", error: "review_required" } });
    expect(isMerged(unreviewed)).toBe(false);
    const bodies = listComments(app.db, unreviewed.id).map((c) => c.body);
    expect(bodies.some((b) => b.startsWith("Landing past the gate"))).toBe(true);
    expect(app.db.query("SELECT 1 FROM event WHERE kind = 'pull.bypassed' AND payload LIKE ?1").get(`%"number":${unreviewed.number},%`)).toBeNull();

    repo = updateRepoSettings(app.db, repo, { requireReview: false });
    const clash = await pullIn(repo, "clash", "clash.txt", "theirs\n");
    const moved = await commitToBranch(app, owner, repo, { branch: "main", message: "mine", files: [{ path: "clash.txt", content: "mine\n" }] });
    if (!moved.ok) throw new Error(JSON.stringify(moved.error));
    const conflicted = await landPastGate(app, owner, repo, getPull(app.db, repo.id, clash.number)!, "a fine reason here");
    expect(conflicted.ok).toBe(false);
    if (!conflicted.ok) expect(conflicted.error.kind).toBe("merge");
    expect(isMerged(clash)).toBe(false);
  });

  test("web: the form shows only while landing has stopped, and works with a plain post", async () => {
    const p = await pullOf("web-form");
    expect(await page(p, ownerCookie)).not.toContain("Land past the gate");
    stop();
    const html = await page(p, ownerCookie);
    expect(html).toContain("Land past the gate");
    expect(html).toContain(`action="/trevato/forge/pulls/${p.number}/land-past"`);
    expect(html).toContain('data-variant="danger"');
    expect(html).not.toContain("row-fields");
    const guest = await fetch(`${servers.url}/trevato/forge/pulls/${p.number}/files`).then((r) => r.text());
    expect(guest).not.toContain("Land past the gate");
  });

  test("web: 403 for a guest, a non-admin and an agent; cross-origin refused; a short reason flashes", async () => {
    stop();
    const p = await pullOf("web-route");
    const reason = "the gate's own bug blocks it";
    expect((await post(p, null, reason)).status).toBe(403);
    const mallory = `forge_session=${createSession(app.db, outsider.id).token}`;
    expect((await post(p, mallory, reason)).status).toBe(403);
    const token = createToken(app.db, agent.id, "rw", "rw").token;
    expect((await post(p, null, reason, {}, token)).status).toBe(403);
    expect((await post(p, ownerCookie, reason, { origin: "https://evil.example" })).status).toBe(403);
    const short = await post(p, ownerCookie, "no");
    expect(short.status).toBe(303);
    expect(short.headers.get("set-cookie") ?? "").toContain("8%20to%20500");
    expect(isMerged(p)).toBe(false);
    const done = await post(p, ownerCookie, reason);
    expect(done.status).toBe(303);
    expect(isMerged(p)).toBe(true);
  });

  test("web: refused while landing has not stopped", async () => {
    const p = await pullOf("web-not-stopped");
    const res = await post(p, ownerCookie, "a fine reason here");
    expect(res.status).toBe(303);
    expect(isMerged(p)).toBe(false);
  });

  test("mcp: an agent is refused; a dry run changes nothing and checks the reason; dryRun false lands; an unseen pull is not found", async () => {
    const p = await pullOf("mcp-door");
    const ownerRw = createToken(app.db, owner.id, "rw", "rw").token;
    const agentRw = createToken(app.db, agent.id, "rw", "rw").token;
    const args = { repo: "trevato/forge", number: p.number, reason: "the gate's own bug blocks it" };
    expect((await mcp(agentRw, { ...args, dryRun: false })).error).toContain("owner");
    expect((await mcp(ownerRw, args)).error).toContain("not stopped");
    stop();
    const plan = await mcp(ownerRw, args);
    expect(plan.value.dryRun).toBe(true);
    expect(isMerged(p)).toBe(false);
    expect((await mcp(ownerRw, { ...args, reason: "no" })).error).toContain("8 to 500");
    expect((await mcp(ownerRw, { ...args, reason: "no", dryRun: false })).error).toContain("8 to 500");
    expect((await mcp(ownerRw, { ...args, number: 9999, dryRun: false })).error).toContain("no pull");
    const landed = await mcp(ownerRw, { ...args, dryRun: false });
    expect(landed.value.landed).toBe(true);
    expect(isMerged(p)).toBe(true);
    const mallory = createToken(app.db, outsider.id, "rw", "rw").token;
    const q = await pullOf("mcp-outsider");
    expect((await mcp(mallory, { ...args, number: q.number, dryRun: false })).error).toBeDefined();
    expect(isMerged(q)).toBe(false);
  });

  test("terminal: L asks a reason, then a confirm, then lands; it is not offered when landing runs", async () => {
    const p = await pullOf("tty-door");
    const drive = async (who: User, keys: string[]) => {
      const terminal = headlessTerminal(160, 44);
      const { app: tui, session } = createForgeApp(
        app,
        { sshUsername: who.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: who },
        { terminal, exitHooks: false },
      );
      tui.start();
      await settleApp(tui);
      tui.push(pullScreen(session, tui.ctx, local(session, repo), p.number));
      await settleApp(tui);
      const frames = [tui.screen.toText()];
      for (const k of keys) {
        terminal.feed(k);
        await settleApp(tui);
        frames.push(tui.screen.toText());
      }
      tui.stop();
      return frames;
    };
    expect((await drive(owner, ["L"])).at(-1)).not.toContain("past the gate");
    stop();
    const [first] = await drive(owner, []);
    expect(first).toContain("land past the gate");
    expect((await drive(outsider, []))[0]).not.toContain("land past the gate");
    const short = await drive(owner, ["L", "no", "\r"]);
    expect(short.at(-1)).toContain("8 to 500");
    expect(isMerged(p)).toBe(false);
    const planned = await drive(owner, ["L", "the gate's own bug blocks it", "\r"]);
    expect(planned.at(-1)).toContain("Reason: the gate's own bug blocks it");
    expect(isMerged(p)).toBe(false);
    await drive(owner, ["L", "the gate's own bug blocks it", "\r", "\x1b[C", "\r"]);
    expect(isMerged(p)).toBe(true);
  }, 60_000);
});
