/**
 * A person's message starts one agent turn (#7651): `runClaude` resumed from
 * the stored session, MCP alone, a via token of that person; the answer and
 * the calls are stored as turns; a message sent mid-turn is steered; a turn
 * a restart cut short is resumed once from the same session.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { clearAccountCeiling, daySpent, setAccountCeiling } from "../src/core/account_ceiling.ts";
import { claimDone, completeWrite, recordWrite } from "../src/core/conversation_writes.ts";
import { listTurns, newConversation, openConversation } from "../src/core/conversations.ts";
import { monthSpent } from "../src/core/model_grant.ts";
import { addSubscription, getSubscription, PLATFORM, setGrants, wakeSubscription } from "../src/core/subscriptions.ts";
import { verifyToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { serve } from "../src/http/server.ts";
import { TOOLS } from "../src/crew/claude.ts";
import { answerHeld, hold, waitingFor } from "../src/core/fence.ts";
import { flowFor } from "../src/system/telemetry.ts";
import { readTalkTurns, talkTurnsWords } from "../src/flow/talk_turns.ts";
import { MCP_SERVER, mcpConfig, RESUMED_LINE, resumeInterrupted, say, STOPPED_LINE, stopTurn, turnRunning, unendedLine, TURNS_LIVE_MAX, type ConversationOptions } from "../src/crew/conversation.ts";

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
function stub(name: string, sid: string, mode: "answer" | "hang" | "steer" | "fail" | "gate", gone = false): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
printf '%s\\n' "$@" > "${dir}/${name}.argv"
pwd > "${dir}/${name}.cwd"
case " $* " in *" --resume "*) ${gone ? "exit 1" : ":"} ;; esac
printf '%s' "$FORGE_MCP_TOKEN" > "${dir}/${name}.token"
printf '%s' "$first" > "${dir}/${name}.first"
echo '{"type":"system","subtype":"init","session_id":"${sid}","model":"fake"}'
${mode === "fail" ? "exit 1" : ""}
echo '{"type":"assistant","session_id":"${sid}","message":{"id":"m1","content":[{"type":"tool_use","name":"mcp__forge__now","input":{}}],"usage":{"input_tokens":10,"output_tokens":5}}}'
${mode === "hang" ? "sleep 30" : ""}
${mode === "gate" ? `while [ ! -f "${dir}/${name}.gate" ]; do sleep 0.05; done` : ""}
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

  test("the turn runs in an empty directory of its own, not the data dir", () => {
    const cwd = readFileSync(join(dir, "first.cwd"), "utf8").trim();
    expect(cwd).toBe(realpathSync(join(dir, "conversation-cwd")));
    expect(readdirSync(cwd)).toEqual([]);
  });

  test("a stored session that cannot be resumed starts that message fresh, once", async () => {
    const bin = stub("gone", "sess-new", "answer", true);
    const said = say(app, options(bin), alice.id, "still there?");
    if (said.ok) await said.value.done;
    expect(turns(alice).at(-1)).toBe("agent:All quiet.");
    expect(lines("gone")).not.toContain("--resume");
    expect(openConversation(app.db, alice.id).claudeSessionId).toBe("sess-new");
  });

  test("a lost session is never shown: named first, refused after, the turn starts fresh with the stored turns (#8751)", async () => {
    const path = join(dir, "lost");
    writeFileSync(
      path,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
printf '%s' "$first" >> "${dir}/lost.first"
printf '%s\\n' "$CLAUDE_CONFIG_DIR" > "${dir}/lost.config"
echo '{"type":"system","subtype":"init","session_id":"sess-lost","model":"fake"}'
case " $* " in *" --resume "*)
  echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"","errors":["No conversation found with session ID: sess-lost"],"total_cost_usd":0,"num_turns":0,"session_id":"sess-lost"}'
  exit 1 ;; esac
echo '{"type":"assistant","session_id":"sess-lost","message":{"id":"m2","content":[{"type":"text","text":"Back."}],"usage":{"input_tokens":1,"output_tokens":1}}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Back.","total_cost_usd":0.1,"num_turns":1,"session_id":"sess-lost","terminal_reason":"completed","usage":{"input_tokens":1,"output_tokens":1}}'
`,
    );
    chmodSync(path, 0o755);
    const before = turns(alice).length;
    const said = say(app, options(path), alice.id, "do you remember me?");
    if (said.ok) await said.value.done;
    const added = turns(alice).slice(before);
    expect(added).toEqual(["person:do you remember me?", "agent:Back."]);
    expect(added.join()).not.toContain("No conversation found");
    const sent = readFileSync(join(dir, "lost.first"), "utf8");
    // The fresh attempt carries what was said before, and the message.
    expect(sent).toContain("still there?");
    expect(sent).toContain("do you remember me?");
    expect(readFileSync(join(dir, "lost.config"), "utf8").trim()).toBe(join(dir, "claude-config"));
    expect(statSync(join(dir, "claude-config")).mode & 0o077).toBe(0);
  });

  test("a message while a turn runs is steered into it, not started beside it", async () => {
    const bin = stub("steered", "sess-a", "steer");
    const a = say(app, options(bin), alice.id, "one");
    const b = say(app, options(bin), alice.id, "two");
    expect(b.ok && b.value.how).toBe("steered");
    if (a.ok) await a.value.done;
    expect(JSON.parse(readFileSync(join(dir, "steered.second"), "utf8")).message.content[0].text).toBe("two");
  });

  test("a reply in progress is read from the stream, dropped halfway, and resumed from the last event id (#8815)", async () => {
    const bin = stub("gated", "sess-g", "gate");
    const servers = await serve(app);
    const cookie = `forge_session=${createSession(app.db, alice.id).token}`;
    const conversation = openConversation(app.db, alice.id);
    const base = listTurns(app.db, alice.id, conversation.id, { limit: 1 });
    const from = base.ok && base.value.length > 0 ? base.value.at(-1)!.id : "";
    const parse = (text: string) =>
      text.split("\n\n").flatMap((f) => {
        const event = /^event: (.*)$/m.exec(f)?.[1];
        return event === undefined ? [] : [{ event, id: /^id: (.*)$/m.exec(f)?.[1] }];
      });
    const turnIds = (text: string) => parse(text).filter((f) => f.event === "turn").map((f) => f.id);
    let started: Promise<void> | undefined;
    try {
      const a = say(app, options(bin), alice.id, "stream me");
      if (!a.ok || a.value.how !== "started") throw new Error("not started");
      started = a.value.done;
      // First connection: read until the tool call has streamed (the person's message, then the call), then drop.
      const drop = new AbortController();
      const first = await fetch(`${servers.url}/talk/stream?after=${from}`, { headers: { cookie }, signal: drop.signal });
      const reader = first.body!.getReader();
      let seen = "";
      while (turnIds(seen).length < 2) {
        const chunk = await reader.read();
        if (chunk.done) break;
        seen += new TextDecoder().decode(chunk.value);
      }
      drop.abort();
      const before = turnIds(seen);
      expect(before.length).toBe(2);
      // Another device opening mid-turn sees the same so far.
      const second = new AbortController();
      const other = await fetch(`${servers.url}/talk/stream`, { headers: { cookie, "last-event-id": from }, signal: second.signal });
      const otherReader = other.body!.getReader();
      let otherSeen = "";
      while (turnIds(otherSeen).length < 2) {
        const chunk = await otherReader.read();
        if (chunk.done) break;
        otherSeen += new TextDecoder().decode(chunk.value);
      }
      second.abort();
      expect(turnIds(otherSeen)).toEqual(before);
      writeFileSync(join(dir, "gated.gate"), "");
      await started;
      const rest = parse(await (await fetch(`${servers.url}/talk/stream`, { headers: { cookie, "last-event-id": before[1]! } })).text());
      const all = turnIds(await (await fetch(`${servers.url}/talk/stream?after=${from}`, { headers: { cookie } })).text());
      expect(all.slice(0, 2)).toEqual(before);
      expect(rest.filter((f) => f.event === "turn").map((f) => f.id)).toEqual(all.slice(2));
      expect(all.length).toBe(3);
      expect(rest.at(-1)!.event).toBe("done");
    } finally {
      writeFileSync(join(dir, "gated.gate"), "");
      await started;
      servers.stop();
    }
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
    // A write the cut turn sent, recorded as it began.
    const via = `conversation:${openConversation(app.db, alice.id).id}`;
    app.db.query("INSERT INTO conversation_write (id, via, tool, args_hash, created_at) VALUES ('w1', ?1, 'close', 'h', '')").run(via);
    stop.abort(); // the forge stops: the row stays running
    if (cut.ok) await cut.value.done;
    expect(app.db.query("SELECT state FROM conversation_run WHERE state = 'running'").all()).toHaveLength(1);

    const again = resumeInterrupted(app, options(stub("resumed", "sess-cut", "answer")));
    expect(again).toHaveLength(1);
    // The resumed turn keeps the cut turn's writes, marked so a repeat is answered from them.
    expect(app.db.query<{ resumed: number }, []>("SELECT resumed FROM conversation_write WHERE id = 'w1'").get()?.resumed).toBe(1);
    await Promise.all(again);
    const args = lines("resumed");
    expect(args[args.indexOf("--resume") + 1]).toBe("sess-cut");
    expect(turns(alice).filter((t) => t === `agent:${RESUMED_LINE}`)).toHaveLength(1);
    // The write with no outcome is shown to the person, once.
    expect(turns(alice).filter((t) => t === `agent:${unendedLine(["close"])}`)).toHaveLength(1);
    // Once: a second boot finds nothing to resume.
    expect(resumeInterrupted(app, options(stub("never", "sess-cut", "answer")))).toHaveLength(0);
    expect(existsSync(join(dir, "never.argv"))).toBe(false);
  });

  test("a resume carries what the cut turn finished; a fresh message clears it (#8321)", async () => {
    const stop = new AbortController();
    const cut = say(app, options(stub("cut2", "sess-cut2", "hang"), stop.signal), alice.id, "close issue 2");
    while (!existsSync(join(dir, "cut2.first"))) await Bun.sleep(20);
    const via = `conversation:${openConversation(app.db, alice.id).id}`;
    const args = { repo: "alice/x", number: 2 };
    const carried = (v: string): boolean => app.db.query("SELECT 1 FROM conversation_write WHERE via = ?1 AND resumed = 1").get(v) !== null;
    recordWrite(app.db, via, "close", args);
    // Not carried yet: the turn is still its own.
    expect(carried(via)).toBe(false);
    stop.abort();
    if (cut.ok) await cut.value.done;
    await Promise.all(resumeInterrupted(app, options(stub("resumed2", "sess-cut2", "answer"))));
    expect(carried(via)).toBe(true);
    const fresh = say(app, options(stub("fresh2", "sess-cut2", "answer")), alice.id, "and again");
    if (fresh.ok) await fresh.value.done;
    expect(carried(via)).toBe(false);
  });

  /** Cut a turn after `record` ran, resume it with a turn that sends nothing, and return the turns the resume added. */
  async function cutAndResume(name: string, record: (via: string) => void): Promise<{ via: string; added: string[] }> {
    const stop = new AbortController();
    const cut = say(app, options(stub(`${name}-cut`, `sess-${name}`, "hang"), stop.signal), alice.id, `do ${name}`);
    while (!existsSync(join(dir, `${name}-cut.first`))) await Bun.sleep(20);
    const via = `conversation:${openConversation(app.db, alice.id).id}`;
    record(via);
    stop.abort();
    if (cut.ok) await cut.value.done;
    const before = turns(alice).length;
    await Promise.all(resumeInterrupted(app, options(stub(`${name}-resumed`, `sess-${name}`, "answer"))));
    return { via, added: turns(alice).slice(before) };
  }
  const resumedTurns = (unknown?: string) => [
    `agent:${RESUMED_LINE}`,
    ...(unknown === undefined ? [] : [`agent:${unknown}`]),
    expect.stringMatching(/^tool:mcp__forge__now/) as unknown as string,
    "agent:All quiet.",
  ];

  test("a resume where every write ended appends no unended line", async () => {
    const { added } = await cutAndResume("ended", (via) => completeWrite(app.db, recordWrite(app.db, via, "close", { number: 3 }), "closed"));
    expect(added).toEqual(resumedTurns());
  });

  test("one write ended and one did not: the line names only the one that did not", async () => {
    const { added } = await cutAndResume("mixed", (via) => {
      completeWrite(app.db, recordWrite(app.db, via, "close", { number: 4 }), "closed");
      recordWrite(app.db, via, "merge", { number: 5 });
    });
    expect(added).toEqual(resumedTurns(unendedLine(["merge"])));
  });

  test("the resumed turn sends nothing; the person asks after it, and the same write runs at once (#8410)", async () => {
    const args = { repo: "alice/x", number: 6 };
    const { via, added } = await cutAndResume("asked", (v) => recordWrite(app.db, v, "close", args));
    expect(added).toEqual(resumedTurns(unendedLine(["close"])));
    // The record still stands after the resumed answer: an identical call now would be answered already_done.
    expect(app.db.query("SELECT 1 FROM conversation_write WHERE via = ?1 AND resumed = 1").get(via)).not.toBeNull();
    const asked = say(app, options(stub("asked-again", "sess-asked", "answer")), alice.id, "close issue 6 again");
    expect(asked.ok && asked.value.how).toBe("started");
    if (asked.ok) await asked.value.done;
    // The person's turn is fresh: the door (`http/mcp.ts`, `claimDone`) finds no record, so the first identical call runs.
    expect(claimDone(app.db, via, "close", args)).toBeUndefined();
  });

  test("the unended line is worded for one write and for several", () => {
    const one = unendedLine(["close"]);
    expect(one).toContain("this write was running");
    expect(one).toContain("whether it finished: close.");
    expect(one).toContain("ask me after this answer and I will do it then.");
    const many = unendedLine(["close", "merge", "close"]);
    expect(many).toContain("these writes were running");
    expect(many).toContain("whether they finished: close, merge.");
    expect(many).toContain("ask me after this answer and I will do them then.");
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

  /** A `claude` the provider turns away: it answers a session limit and nothing else. */
  function limitedStub(name: string): string {
    const path = join(dir, name);
    writeFileSync(
      path,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
echo '{"type":"system","subtype":"init","session_id":"s-limit","model":"fake"}'
echo '{"type":"assistant","session_id":"s-limit","message":{"id":"m1","content":[{"type":"text","text":"You have hit your session limit · resets 7:20am (UTC)"}],"usage":{"input_tokens":1,"output_tokens":1}}}'
echo '{"type":"result","subtype":"success","is_error":true,"result":"You have hit your session limit · resets 7:20am (UTC)","total_cost_usd":0,"num_turns":1,"session_id":"s-limit","terminal_reason":"api_error","usage":{"input_tokens":1,"output_tokens":1}}'
`,
    );
    chmodSync(path, 0o755);
    return path;
  }

  test("a turn the provider rate-limits rests the account, says so once, and the next message is refused while it rests", async () => {
    const account = addSubscription(app.db, dir, { name: "home", token: "sk-ant-api-test-home" });
    if (!account.ok) throw new Error("account");
    setGrants(app.db, alice.id, "", [account.value.id]);
    try {
      const said = say(app, options(limitedStub("limited")), alice.id, "hello?");
      expect(said.ok).toBe(true);
      if (said.ok) await said.value.done;
      const line = turns(alice).at(-1)!;
      expect(line).toMatch(/^agent:home is resting until \d\d:\d\d UTC\.$/);
      expect(turns(alice).filter((t) => t.includes("session limit"))).toEqual([]);
      const rested = getSubscription(app.db, account.value.id)!;
      expect(rested.restingUntil).not.toBeNull();
      const noted = app.db.query<{ span: string }, [string]>("SELECT span FROM subscription_limit WHERE subscription_id = ?1").all(account.value.id);
      expect(noted.map((r) => r.span)).toEqual(["5h"]);

      const before = turns(alice).length;
      const refused = say(app, options(stub("while-resting", "s", "answer")), alice.id, "again?");
      expect(refused.ok ? "started" : refused.error).toBe("resting");
      expect(turns(alice)).toHaveLength(before);

      wakeSubscription(app.db, account.value.id);
      const woke = say(app, options(stub("after-wake", "s", "answer")), alice.id, "now?");
      expect(woke.ok).toBe(true);
      if (woke.ok) await woke.value.done;
      expect(turns(alice).at(-1)).toBe("agent:All quiet.");
    } finally {
      setGrants(app.db, alice.id, "", []);
    }
  });

  test("a turn on the forge's own token says its window is full, rests nothing, and notes the window", async () => {
    const said = say(app, options(limitedStub("platform-limited")), alice.id, "on the platform?");
    expect(said.ok).toBe(true);
    if (said.ok) await said.value.done;
    expect(turns(alice).at(-1)).toMatch(/^agent:The forge's own model window is full until \d\d:\d\d UTC; try again then\.$/);
    expect(turns(alice).filter((t) => t.includes("session limit"))).toEqual([]);
    const noted = app.db.query<{ span: string }, [string]>("SELECT span FROM subscription_limit WHERE subscription_id = ?1").all(PLATFORM);
    expect(noted.map((r) => r.span)).toEqual(["5h"]);
    // Nothing rests, so the next message is accepted.
    const next = say(app, options(stub("platform-next", "s", "answer")), alice.id, "again?");
    expect(next.ok).toBe(true);
    if (next.ok) await next.value.done;
  });
});

describe("stopping a turn (#8818)", () => {
  test("a stopped turn leaves no process, keeps what was said, marked stopped, and cancels a pending confirm", async () => {
    const u = { value: alice };
    const pidFile = join(dir, "stop.pid");
    const path = join(dir, "stop-claude");
    writeFileSync(
      path,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
sleep 300 &
echo $! > "${pidFile}"
echo '{"type":"system","subtype":"init","session_id":"sess-stop","model":"fake"}'
echo '{"type":"assistant","session_id":"sess-stop","message":{"id":"m1","content":[{"type":"text","text":"Looking into it."}],"usage":{"input_tokens":1,"output_tokens":1}}}'
sleep 300
`,
    );
    chmodSync(path, 0o755);
    const said = say(app, options(path), u.value.id, "do a slow thing");
    if (!said.ok || said.value.done === undefined) throw new Error("not started");
    for (let i = 0; i < 100 && !turns(u.value).some((t) => t === "agent:Looking into it."); i++) await Bun.sleep(50);
    expect(turns(u.value)).toContain("agent:Looking into it.");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    const via = `conversation:${openConversation(app.db, u.value.id).id}`;
    const held = hold(app.db, via, u.value.id, "create_issue", { title: "x" });
    expect(held).not.toBeNull();
    const failedBefore = readTalkTurns(app.db).failed;
    expect(stopTurn(app, u.value.id)).toBe(true);
    await said.value.done;
    expect(turnRunning(app, u.value.id)).toBe(false);
    expect(turns(u.value).slice(-3)).toEqual(["person:do a slow thing", "agent:Looking into it.", `agent:${STOPPED_LINE}`]);
    expect(waitingFor(app.db, u.value.id)).toEqual([]);
    expect(answerHeld(app.db, held!, u.value.id).ok).toBe(false);
    // Stored as stopped, and not a failure (#8860).
    expect(app.db.query("SELECT state FROM conversation_run WHERE user_id = ?1 ORDER BY started_at DESC LIMIT 1").get(u.value.id)).toEqual({ state: "stopped" });
    expect(app.db.query("SELECT stopped FROM conversation_run WHERE user_id = ?1 ORDER BY started_at DESC LIMIT 1").get(u.value.id)).toEqual({ stopped: 1 });
    const turnsNow = readTalkTurns(app.db);
    expect(turnsNow.stopped).toBeGreaterThanOrEqual(1);
    expect(turnsNow.failed).toBe(failedBefore);
    let alive = true;
    for (let i = 0; i < 60 && alive; i++) {
      try { process.kill(pid, 0); await Bun.sleep(50); } catch { alive = false; }
    }
    expect(alive).toBe(false);
    expect(stopTurn(app, u.value.id)).toBe(false);
  }, 20_000);

  test("Stop ends the replies running in two conversations, the older one included", async () => {
    const older = newConversation(app.db, alice.id);
    const newer = newConversation(app.db, alice.id);
    const one = say(app, options(stub("two-a", "sess-two-a", "hang")), alice.id, "first", [], "inject", older.id);
    const two = say(app, options(stub("two-b", "sess-two-b", "hang")), alice.id, "second", [], "inject", newer.id);
    if (!one.ok || !two.ok || one.value.done === undefined || two.value.done === undefined) throw new Error("not started");
    expect(turnRunning(app, alice.id, older.id)).toBe(true);
    expect(turnRunning(app, alice.id, newer.id)).toBe(true);
    expect(stopTurn(app, alice.id)).toBe(true);
    await Promise.all([one.value.done, two.value.done]);
    expect(turnRunning(app, alice.id, older.id)).toBe(false);
    expect(turnRunning(app, alice.id, newer.id)).toBe(false);
    expect(stopTurn(app, alice.id)).toBe(false);
  }, 20_000);
});

describe("talk turn counts (#8860)", () => {
  test("stopped turns are counted apart and leave the failure rate alone", () => {
    const base = readTalkTurns(app.db);
    const c = openConversation(app.db, alice.id);
    for (const [state, stopped] of [["ok", 0], ["failed", 0], ["stopped", 1], ["stopped", 1]] as const)
      app.db.query("INSERT INTO conversation_run (id, conversation_id, user_id, state, stopped, prompt, started_at) VALUES (?1,?2,?3,?4,?5,'x','2026-11-03')").run(crypto.randomUUID(), c.id, alice.id, state, stopped);
    const now = readTalkTurns(app.db);
    expect([now.ok - base.ok, now.failed - base.failed, now.stopped - base.stopped]).toEqual([1, 1, 2]);
    expect(talkTurnsWords({ ok: 0, failed: 0, stopped: 0, failureRate: 0 })).toBe("");
    expect(talkTurnsWords({ ok: 1, failed: 1, stopped: 2, failureRate: 0.5 })).toBe("Talk: 1 turn failed, 2 stopped by the person");
    expect(flowFor(app, { kind: "owner" }).vitals.says).toContain(`Talk: ${now.failed} ${now.failed === 1 ? "turn" : "turns"} failed, ${now.stopped} stopped by the person`);
  });
});
