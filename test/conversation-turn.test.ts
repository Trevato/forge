/**
 * A person's message starts one agent turn (#7651): `runClaude` resumed from
 * the stored session, MCP alone, a via token of that person; the answer and
 * the calls are stored as turns; a message sent mid-turn is steered; a turn
 * a restart cut short is resumed once from the same session.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { clearAccountCeiling, daySpent, setAccountCeiling } from "../src/core/account_ceiling.ts";
import { listTurns, openConversation } from "../src/core/conversations.ts";
import { monthSpent } from "../src/core/model_grant.ts";
import { PLATFORM } from "../src/core/subscriptions.ts";
import { verifyToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { TOOLS } from "../src/crew/claude.ts";
import { MCP_SERVER, mcpConfig, RESUMED_LINE, resumeInterrupted, say, TURNS_LIVE_MAX, type ConversationOptions } from "../src/crew/conversation.ts";

let dir: string;
let app: App;
let alice: User;

const options = (binary: string, signal = new AbortController().signal): ConversationOptions => ({
  binary,
  localUrl: "http://127.0.0.1:9",
  budgetUsd: 1,
  timeoutMs: 30_000,
  signal,
});

/** A stand-in `claude`: records what it was given, answers, and holds while told to. */
function stub(name: string, sid: string, mode: "answer" | "hang" | "steer" | "fail"): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
printf '%s\\n' "$@" > "${dir}/${name}.argv"
printf '%s' "$FORGE_MCP_TOKEN" > "${dir}/${name}.token"
printf '%s' "$first" > "${dir}/${name}.first"
echo '{"type":"system","subtype":"init","session_id":"${sid}","model":"fake"}'
${mode === "fail" ? "exit 1" : ""}
echo '{"type":"assistant","session_id":"${sid}","message":{"id":"m1","content":[{"type":"tool_use","name":"mcp__forge__now","input":{}}],"usage":{"input_tokens":10,"output_tokens":5}}}'
${mode === "hang" ? "sleep 30" : ""}
${mode === "steer" ? `IFS= read -r second; printf '%s' "$second" > "${dir}/${name}.second"` : ""}
echo '{"type":"assistant","session_id":"${sid}","message":{"id":"m2","content":[{"type":"text","text":"All quiet."}],"usage":{"input_tokens":20,"output_tokens":9}}}'
RESULT='{"type":"result","subtype":"success","is_error":false,"result":"All quiet.","total_cost_usd":0.5,"num_turns":2,"session_id":"${sid}","terminal_reason":"completed","usage":{"input_tokens":20,"output_tokens":9}}'
echo "$RESULT"
${mode === "steer" ? 'echo "$RESULT"' : ""}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

const lines = (name: string): string[] => readFileSync(join(dir, `${name}.argv`), "utf8").trim().split("\n");
const turns = (u: User) => {
  const r = listTurns(app.db, u.id, openConversation(app.db, u.id).id);
  return r.ok ? r.value.map((t) => `${t.role}:${t.text}`) : [];
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-conv-turn-"));
  app = createApp({ dataDir: dir, port: 0 });
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!a.ok) throw new Error("user");
  alice = a.value;
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("a conversation turn", () => {
  test("MCP config and via token reach the model; answer and tool call are stored; spend is the person's", async () => {
    const bin = stub("first", "sess-a", "answer");
    const said = say(app, options(bin), alice.id, "what is going on?");
    expect(said.ok && said.value.how).toBe("started");
    if (said.ok) await said.value.done;
    const args = lines("first");
    // MCP only: no tools, strict config naming this forge's /mcp, token from the environment.
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    // The settings allow the forge's MCP and deny every file and shell tool by name.
    expect(JSON.parse(args[args.indexOf("--settings") + 1]!)).toEqual({ permissions: { allow: ["mcp__forge"], deny: [...TOOLS] } });
    const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]!);
    expect(config).toEqual(JSON.parse(mcpConfig("http://127.0.0.1:9")));
    expect(config.mcpServers[MCP_SERVER].url).toBe("http://127.0.0.1:9/mcp");
    expect(args.join(" ")).not.toContain(readFileSync(join(dir, "first.token"), "utf8"));
    expect(args).not.toContain("--resume");
    const token = readFileSync(join(dir, "first.token"), "utf8");
    expect(token.length).toBeGreaterThan(10);
    expect(JSON.parse(readFileSync(join(dir, "first.first"), "utf8")).message.content[0].text).toBe("what is going on?");
    // Stored: the person, the call, the answer (once).
    expect(turns(alice)).toEqual([
      "person:what is going on?",
      expect.stringMatching(/^tool:mcp__forge__now/) as unknown as string,
      "agent:All quiet.",
    ]);
    // The token was the person's and is gone with the turn.
    expect(verifyToken(app.db, token).ok).toBe(false);
    // Spend: on the person and the account that served it.
    expect(daySpent(app.db, alice.id, new Date())).toBeCloseTo(0.5, 5);
    const spent = app.db.query<{ n: number }, [string]>("SELECT spent_usd AS n FROM subscription WHERE id = ?1").get(PLATFORM);
    expect(spent?.n).toBeCloseTo(0.5, 5);
  });

  test("the next message resumes the stored session", async () => {
    const said = say(app, options(stub("second", "sess-a", "answer")), alice.id, "and now?");
    if (said.ok) await said.value.done;
    const args = lines("second");
    expect(args[args.indexOf("--resume") + 1]).toBe("sess-a");
  });

  test("a message while a turn runs is steered into it, not started beside it", async () => {
    const bin = stub("steered", "sess-a", "steer");
    const a = say(app, options(bin), alice.id, "one");
    const b = say(app, options(bin), alice.id, "two");
    expect(b.ok && b.value.how).toBe("steered");
    if (a.ok) await a.value.done;
    expect(JSON.parse(readFileSync(join(dir, "steered.second"), "utf8")).message.content[0].text).toBe("two");
  });

  test("a restart mid-turn: found at boot and resumed once from the same session", async () => {
    const stop = new AbortController();
    const hang = stub("cut", "sess-cut", "hang");
    const cut = say(app, options(hang, stop.signal), alice.id, "look at the pulls");
    while (!existsSync(join(dir, "cut.first"))) await Bun.sleep(20);
    // The session is stored the moment it is named.
    for (let i = 0; i < 100 && openConversation(app.db, alice.id).claudeSessionId !== "sess-cut"; i++) await Bun.sleep(20);
    expect(openConversation(app.db, alice.id).claudeSessionId).toBe("sess-cut");
    // Mid-turn the token is alice's own.
    const live = verifyToken(app.db, readFileSync(join(dir, "cut.token"), "utf8"));
    expect(live.ok && live.value.user.id).toBe(alice.id);
    stop.abort(); // the forge stops: the row stays running
    if (cut.ok) await cut.value.done;
    expect(app.db.query("SELECT state FROM conversation_run WHERE state = 'running'").all()).toHaveLength(1);

    const again = resumeInterrupted(app, options(stub("resumed", "sess-cut", "answer")));
    expect(again).toHaveLength(1);
    await Promise.all(again);
    const args = lines("resumed");
    expect(args[args.indexOf("--resume") + 1]).toBe("sess-cut");
    expect(turns(alice).filter((t) => t === `agent:${RESUMED_LINE}`)).toHaveLength(1);
    // Once: a second boot finds nothing to resume.
    expect(resumeInterrupted(app, options(stub("never", "sess-cut", "answer")))).toHaveLength(0);
    expect(existsSync(join(dir, "never.argv"))).toBe(false);
  });

  test("a person with no account and no admin is refused, and nothing is stored as a run", async () => {
    const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
    if (!b.ok) throw new Error("user");
    const said = say(app, options(stub("bobs", "s", "answer")), b.value.id, "hi");
    expect(!said.ok && said.error).toBe("no_account");
    expect(existsSync(join(dir, "bobs.argv"))).toBe(false);
    // The words nobody will answer are not kept.
    expect(turns(b.value)).toEqual([]);
    expect(app.db.query("SELECT 1 FROM conversation_run WHERE user_id = ?1").all(b.value.id)).toHaveLength(0);
  });

  test("a person at their daily ceiling rests, and the message is not kept", async () => {
    const before = turns(alice);
    // Alice spent $0.50 a turn on the forge's own credential: her month counts each one.
    const runs = app.db.query<{ n: number }, [string]>("SELECT SUM(cost_usd) AS n FROM conversation_run WHERE user_id = ?1").get(alice.id)?.n ?? 0;
    expect(runs).toBeGreaterThan(0);
    expect(monthSpent(app.db, alice.id, new Date())).toBeCloseTo(runs, 5);
    expect(setAccountCeiling(app.db, alice.id, 0.5, 0.5, alice.id, new Date())).toBe(true);
    const said = say(app, options(stub("ceiling", "s", "answer")), alice.id, "over the day");
    clearAccountCeiling(app.db, alice.id);
    expect(!said.ok && said.error).toBe("resting");
    expect(existsSync(join(dir, "ceiling.argv"))).toBe(false);
    expect(turns(alice)).toEqual(before);
  });

  test("past the live-turn cap a new turn is busy; a steer into a running one is not counted", async () => {
    expect(TURNS_LIVE_MAX).toBe(4);
    const before = turns(alice);
    const none = say(app, { ...options(stub("capped", "sess-a", "answer")), liveMax: 0 }, alice.id, "too many");
    expect(!none.ok && none.error).toBe("busy");
    expect(existsSync(join(dir, "capped.argv"))).toBe(false);
    expect(turns(alice)).toEqual(before);
    const bin = stub("one-live", "sess-a", "steer");
    const a = say(app, { ...options(bin), liveMax: 1 }, alice.id, "first");
    expect(a.ok && a.value.how).toBe("started");
    while (!existsSync(join(dir, "one-live.first"))) await Bun.sleep(20);
    const b = say(app, { ...options(bin), liveMax: 1 }, alice.id, "second");
    expect(b.ok && b.value.how).toBe("steered");
    if (a.ok) await a.value.done;
  });

  const viaTokens = (): number =>
    app.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM via_token WHERE via = ?1")
      .get(`conversation:${openConversation(app.db, alice.id).id}`)?.n ?? 0;

  test("a turn that fails takes its token with it", async () => {
    const said = say(app, options(stub("failed", "sess-a", "fail")), alice.id, "this will fail");
    if (said.ok) await said.value.done;
    expect(said.ok).toBe(true);
    const token = readFileSync(join(dir, "failed.token"), "utf8");
    expect(token.length).toBeGreaterThan(10);
    expect(verifyToken(app.db, token).ok).toBe(false);
    expect(viaTokens()).toBe(0);
    expect(turns(alice).at(-1)).toBe("agent:I could not answer that just now.");
  });

  test("a binary that is not there fails the turn and revokes its token", async () => {
    const said = say(app, options(join(dir, "no-such-claude")), alice.id, "anyone?");
    expect(said.ok).toBe(true);
    if (said.ok) await said.value.done;
    expect(viaTokens()).toBe(0);
    const last = app.db.query<{ state: string }, [string]>("SELECT state FROM conversation_run WHERE user_id = ?1 ORDER BY rowid DESC LIMIT 1").get(alice.id);
    expect(last?.state).toBe("failed");
  });
});
