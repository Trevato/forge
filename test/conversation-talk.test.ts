/**
 * The doors to a conversation turn (#7651): `POST /api/v1/conversation/messages`,
 * the MCP `say` with no repo, and `ssh <forge> talk <words>` each reach
 * `say()` as the verified person; the forge's own agent cannot wake itself.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { configureConversation } from "../src/crew/conversation.ts";
import { addKey, fingerprint, parseAuthorizedKey } from "../src/core/keys.ts";
import { WORDS_MAX } from "../src/core/fence.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { mintViaToken } from "../src/core/via_token.ts";
import { TALK_PER_MINUTE, talk, talkAgain } from "../src/actions/talk.ts";
import { turnsLimit } from "../src/http/api/conversation_talk.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { appendTurn, newConversation, openConversation } from "../src/core/conversations.ts";
import { forgeSshSession } from "../src/tui/ssh.ts";
import { isStop, parseTalkAgain, parseTalkCommand } from "../src/tui/ssh-talk.ts";
import { listTurns } from "../src/core/conversations.ts";
import { createSession } from "../src/core/sessions.ts";
import { conversationOptions, redo, withHistory } from "../src/crew/conversation.ts";
import { exchangeActs, turnHtml } from "../src/web/pages/talk.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2S7bF0R4NmuTUvVJXPPjdI1AF8XHXeYSNfr8DJ5eDo alice";

describe("talking to the forge's agent", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  let token: string;
  let via: string;
  const headers = (t: string) => ({ "content-type": "application/json", authorization: `Bearer ${t}` });

  const turns = async (): Promise<{ running: boolean; turns: { id: string; role: string; text: string; replaced: boolean; failed: boolean }[] }> =>
    (await fetch(`${servers.url}/api/v1/conversation/turns`, { headers: headers(token) })).json() as never;
  const settle = async () => {
    for (let i = 0; i < 200; i++) {
      if (!(await turns()).running) return;
      await Bun.sleep(25);
    }
    throw new Error("the turn never finished");
  };
  const persons = async () => (await turns()).turns.filter((t) => t.role === "person").map((t) => t.text);

  const mcp = async (t: string, args: Record<string, unknown>) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { ...headers(t), accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "say", arguments: args } }),
    });
    const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    return { error: body.result.isError === true, text: body.result.content[0]!.text };
  };

  const exec = async (command: string) => {
    const parsed = parseAuthorizedKey(KEY);
    if (!parsed.ok) throw new Error("key");
    let out = "";
    let err = "";
    let code: number | undefined;
    await new Promise<void>((resolve) => {
      const session = {
        key: { fingerprint: fingerprint(parsed.value.blob), line: KEY },
        username: "whoever",
        remoteAddress: "203.0.113.9",
        kind: "exec" as const,
        command,
        term: undefined,
        env: {},
        cols: 0,
        rows: 0,
        widthPx: 0,
        heightPx: 0,
        ended: false,
        pending: 0,
        write: (d: Uint8Array | string) => void (out += typeof d === "string" ? d : Buffer.from(d).toString()),
        writeStderr: (d: string) => void (err += d),
        onData() {},
        onResize() {},
        onEof() {},
        onClose() {},
        exit(c: number) {
          if (code !== undefined) return;
          code = c;
          resolve();
        },
        drained: async () => {},
      };
      forgeSshSession(app)(session as never);
    });
    return { out, err, code };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-conv-talk-"));
    app = createApp({ dataDir: dir, port: 0, host: "forge.test" });
    servers = await serve(app);
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!made.ok) throw new Error(made.error);
    const parsed = parseAuthorizedKey(KEY);
    if (!parsed.ok) throw new Error("key");
    addKey(app.db, made.value.id, "laptop", parsed.value);
    token = createToken(app.db, made.value.id, "personal", "rw").token;
    const minted = mintViaToken(app.db, made.value.id, "conversation:c1", "", new Date(Date.now() + 600_000).toISOString());
    if (!minted.ok) throw new Error("mint");
    via = minted.value.token;
    const bin = join(dir, "claude");
    writeFileSync(
      bin,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
printf '%s' "$first" > "${dir}/first.json"
echo '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Heard.","total_cost_usd":0.01,"num_turns":1,"session_id":"s1","terminal_reason":"completed","usage":{"input_tokens":1,"output_tokens":1}}'
`,
    );
    chmodSync(bin, 0o755);
    configureConversation(app, { binary: bin, localUrl: servers.url, budgetUsd: 1, timeoutMs: 30_000, signal: new AbortController().signal });
  });
  afterAll(async () => {
    await servers.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("the API takes a message, answers 202, and the turns hold the question and the answer", async () => {
    const res = await fetch(`${servers.url}/api/v1/conversation/messages`, { method: "POST", headers: headers(token), body: JSON.stringify({ text: "by api" }) });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { how: string }).how).toBe("started");
    await settle();
    const now = await turns();
    expect(now.turns.map((t) => `${t.role}:${t.text}`)).toEqual(["person:by api", "agent:Heard."]);
  });

  test("the API refuses no sign-in, bad words and a cross-origin browser", async () => {
    const post = (h: Record<string, string>, body: unknown) =>
      fetch(`${servers.url}/api/v1/conversation/messages`, { method: "POST", headers: h, body: JSON.stringify(body) });
    expect((await post({ "content-type": "application/json" }, { text: "x" })).status).toBe(401);
    expect((await post(headers(token), { text: "  " })).status).toBe(422);
    expect((await post(headers(token), { text: 5 })).status).toBe(422);
    expect((await post(headers(token), { text: "x".repeat(WORDS_MAX + 1) })).status).toBe(422);
    expect((await post({ ...headers(token), origin: "https://elsewhere.example" }, { text: "from afar" })).status).toBe(403);
    const huge = await fetch(`${servers.url}/api/v1/conversation/messages`, {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ text: "x".repeat(200_000) }),
    });
    expect(huge.status).toBe(413);
    expect(await persons()).toEqual(["by api"]);
  });

  test("a person past the per-minute cap is told to wait a minute", async () => {
    // No account and no admin: each message is refused before a turn starts, but each one counts.
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "dana", email: "dana@forge.local", password: "a-good-passphrase" });
    if (!made.ok) throw new Error(made.error);
    const dana = createToken(app.db, made.value.id, "personal", "rw").token;
    const send = () =>
      fetch(`${servers.url}/api/v1/conversation/messages`, { method: "POST", headers: headers(dana), body: JSON.stringify({ text: "hi" }) });
    for (let i = 0; i < TALK_PER_MINUTE; i++) {
      const res = await send();
      expect(res.status).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("no_account");
    }
    const over = await send();
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).toBe("60");
    expect(((await over.json()) as { error: string }).error).toBe("rate_limited");
    // Nothing dana said was kept: no turn could answer it.
    const read = await fetch(`${servers.url}/api/v1/conversation/turns`, { headers: headers(dana) });
    expect(((await read.json()) as { turns: unknown[] }).turns).toEqual([]);
  });

  test("the turns page size is clamped, and junk is the default", async () => {
    expect(turnsLimit(null)).toBe(50);
    expect(turnsLimit("")).toBe(50);
    expect(turnsLimit("ten")).toBe(50);
    expect(turnsLimit("0")).toBe(1);
    expect(turnsLimit("-3")).toBe(1);
    expect(turnsLimit("2.7")).toBe(2);
    expect(turnsLimit("100000")).toBe(200);
    const one = await fetch(`${servers.url}/api/v1/conversation/turns?limit=1`, { headers: headers(token) });
    expect(((await one.json()) as { turns: { text: string }[] }).turns.map((t) => t.text)).toEqual(["Heard."]);
    const junk = await fetch(`${servers.url}/api/v1/conversation/turns?limit=`, { headers: headers(token) });
    expect(((await junk.json()) as { turns: unknown[] }).turns).toHaveLength(2);
  });

  test("a token that may only read cannot start a turn that acts with rw (#8230)", async () => {
    const id = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'alice'").get()!.id;
    const ro = createToken(app.db, id, "reader", "ro").token;
    const res = await fetch(`${servers.url}/api/v1/conversation/messages`, { method: "POST", headers: headers(ro), body: JSON.stringify({ text: "by ro" }) });
    expect(res.status).toBe(403);
    const said = await mcp(ro, { text: "by ro" });
    expect(said.error).toBe(true);
    await settle();
    expect(await persons()).not.toContain("by ro");
  });

  test("a conversation's own token cannot reach the API door", async () => {
    const res = await fetch(`${servers.url}/api/v1/conversation/messages`, { method: "POST", headers: headers(via), body: JSON.stringify({ text: "loop" }) });
    expect(res.status).toBe(403);
  });

  test("stop answers 409 when no answer runs, in the API and the MCP; a read-only token and the agent's own token are refused (#8818)", async () => {
    await settle();
    const stop = (t: string) => fetch(`${servers.url}/api/v1/conversation/stop`, { method: "POST", headers: headers(t), body: "{}" });
    expect((await stop(token)).status).toBe(409);
    const id = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'alice'").get()!.id;
    expect((await stop(createToken(app.db, id, "reader2", "ro").token)).status).toBe(403);
    expect((await stop(via)).status).toBe(403);
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { ...headers(token), accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stop", arguments: {} } }),
    });
    const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain("no answer is running");
  });

  test("the MCP say with no repo speaks to the agent; the agent's own token is refused", async () => {
    const said = await mcp(token, { text: "by mcp" });
    expect(said.error).toBe(false);
    await settle();
    expect(await persons()).toEqual(["by api", "by mcp"]);
    const loop = await mcp(via, { text: "loop" });
    expect(loop.error).toBe(true);
    await settle();
    expect(await persons()).toEqual(["by api", "by mcp"]);
  });

  test("ssh talk reaches the same turn as the person; control characters are refused", async () => {
    expect(parseTalkCommand("talk hello there")).toBe("hello there");
    expect(parseTalkCommand("talking")).toBeUndefined();
    const r = await exec("talk by ssh $HOME");
    expect(r.code).toBe(0);
    await settle();
    expect(await persons()).toEqual(["by api", "by mcp", "by ssh $HOME"]);
    const refused = await exec("talk bad\u0007words");
    expect(refused.code).toBe(1);
    expect((await exec("talk   ")).code).toBe(1);
    expect(await persons()).toEqual(["by api", "by mcp", "by ssh $HOME"]);
  });
  test("ssh talk prints the last turn's cost and the context share from the run's own record", async () => {
    const id = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'alice'").get()!.id;
    const conversation = openConversation(app.db, id);
    const reply = appendTurn(app.db, id, conversation.id, { role: "agent", text: "answered" });
    if (!reply.ok) throw new Error(reply.error);
    const at = new Date(Date.now() - 1000).toISOString();
    app.db
      .query("INSERT INTO conversation_run (id, conversation_id, user_id, prompt, state, cost_usd, context_tokens, context_window, started_at, finished_at) VALUES ('rc1',?1,?2,'x','ok',0.5,500000,1000000,?3,?4)")
      .run(conversation.id, id, at, new Date(Date.now() + 1000).toISOString());
    const r = await exec("talk and the figures");
    expect(r.out).toContain("last turn $0.50");
    expect(r.out).toContain("Context 50% full (500k of 1M tokens)");
    app.db.query("DELETE FROM conversation_run WHERE id = 'rc1'").run();
    await settle();
    app.db.query("DELETE FROM conversation_turn WHERE id IN (SELECT id FROM conversation_turn WHERE conversation_id = ?1 AND id >= ?2)").run(conversation.id, reply.value.id);
  });

  const alice = () => app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'alice'").get()!.id;
  const again = (how: "edit" | "regenerate" | "retry", text = "") => redo(app, conversationOptions(app)!, alice(), how, text);
  const as = () => ({ id: alice() }) as never;
  const settled = async (r: ReturnType<typeof redo>) => {
    if (!r.ok) throw new Error(r.error);
    await r.value.done;
  };
  const withBinary = (script: string) => {
    const bin = join(dir, `bin-${Math.random().toString(36).slice(2)}`);
    writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi\nIFS= read -r first\n${script}\n`);
    chmodSync(bin, 0o755);
    configureConversation(app, { binary: bin, localUrl: servers.url, budgetUsd: 1, timeoutMs: 30_000, signal: new AbortController().signal });
  };
  const answers = (words: string) =>
    `echo '{"type":"system","subtype":"init","session_id":"s2","model":"fake"}'\necho '{"type":"result","subtype":"success","is_error":false,"result":"${words}","total_cost_usd":0.01,"num_turns":1,"session_id":"s2","terminal_reason":"completed","usage":{"input_tokens":1,"output_tokens":1}}'`;
  const standing = async () => (await turns()).turns.filter((t) => !t.replaced).map((t) => `${t.role}:${t.text}`);

  test("editing the last message resends it; the old message and its reply stay, marked replaced", async () => {
    withBinary(answers("Second answer."));
    const before = (await turns()).turns.length;
    const last = (await persons()).at(-1)!;
    await settled(again("edit", "edited words"));
    await settle();
    const now = await turns();
    expect(now.turns.length).toBe(before + 2);
    const old = now.turns.find((t) => t.text === last)!;
    expect(old.replaced).toBe(true);
    expect((await standing()).slice(-2)).toEqual(["person:edited words", "agent:Second answer."]);
    expect(now.turns.filter((t) => t.replaced).every((t) => t.role === "person" || t.role === "agent")).toBe(true);
    const drawn = turnHtml({ ...old, conversationId: "c", createdAt: "2026-01-01T00:00:00Z" } as never, new Set()).text;
    expect(drawn).toContain("talk-replaced");
    expect(drawn).toContain("replaced");
  });

  test("regenerate asks the last message again and replaces only the reply", async () => {
    withBinary(answers("A new reply."));
    await settled(again("regenerate"));
    await settle();
    const tail = (await standing()).slice(-2);
    expect(tail).toEqual(["person:edited words", "agent:A new reply."]);
    expect((await turns()).turns.some((t) => t.text === "Second answer." && t.replaced)).toBe(true);
  });

  test("a failed run says so in plain words with Retry, and never the raw error", async () => {
    withBinary(`echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"RAW stack: ECONNRESET at 0xdead","total_cost_usd":0,"num_turns":0,"session_id":"s3"}'\nexit 1`);
    await settled(again("regenerate"));
    await settle();
    const all = (await turns()).turns;
    const failed = all.at(-1)!;
    expect(failed.failed).toBe(true);
    expect(all.some((t) => t.text.includes("RAW stack") || t.text.includes("ECONNRESET"))).toBe(false);
    const conv = openConversation(app.db, alice());
    const drawn = turnHtml(failed as never, new Set(), undefined, exchangeActs(app.db, alice(), conv.id, false).get(failed.id)).text;
    expect(drawn).toContain("Retry");
    expect(drawn).toContain("/talk/again/retry");
    expect(drawn).not.toContain("RAW");
    expect(exchangeActs(app.db, alice(), conv.id, true).size).toBe(0);
    // Retry on a good answer, or regenerate on a failure, has nothing to act on.
    withBinary(answers("Fine now."));
    const bad = again("regenerate");
    expect(!bad.ok && bad.error).toBe("nothing");
    await settled(again("retry"));
    await settle();
    expect((await standing()).slice(-2)).toEqual(["person:edited words", "agent:Fine now."]);
    expect((await turns()).turns.find((t) => t.id === failed.id)!.replaced).toBe(true);
    const retried = again("retry");
    expect(!retried.ok && retried.error).toBe("nothing");
  });

  test("a refused redo puts the turns back as they were", async () => {
    const plain = await standing();
    const refused = talkAgain(app, { id: alice() } as never, "edit", "   ");
    expect(!refused.ok && refused.error).toBe("empty");
    expect(await standing()).toEqual(plain);
    expect(talkAgain(app, undefined, "retry").ok).toBe(false);
  });
  test("regenerate acts on the conversation it names, not the latest", async () => {
    const older = newConversation(app.db, alice());
    appendTurn(app.db, alice(), older.id, { role: "person", text: "older question" });
    appendTurn(app.db, alice(), older.id, { role: "agent", text: "older answer" });
    const newer = newConversation(app.db, alice());
    appendTurn(app.db, alice(), newer.id, { role: "person", text: "newer question" });
    appendTurn(app.db, alice(), newer.id, { role: "agent", text: "newer answer" });
    withBinary(answers("Fresh older answer."));
    await settled(redo(app, conversationOptions(app)!, alice(), "regenerate", "", older.id));
    await settle();
    const text = (id: string) => (listTurns(app.db, alice(), id, { limit: 50 }) as { ok: true; value: { text: string; replaced: boolean }[] }).value;
    expect(text(older.id).filter((t) => !t.replaced).map((t) => t.text)).toEqual(["older question", "Fresh older answer."]);
    expect(text(newer.id).map((t) => t.text)).toEqual(["newer question", "newer answer"]);
    const stranger = redo(app, conversationOptions(app)!, alice(), "regenerate", "", "01zzzzzzzzzzzzzzzzzzzzzzzz");
    expect(!stranger.ok && stranger.error).toBe("not_found");
    expect(exchangeActs(app.db, alice(), older.id, false, `/talk/${older.id}`).size).toBe(2);
  });

  const post = (path: string, h: Record<string, string>, body = "") =>
    fetch(`${servers.url}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...h }, body, redirect: "manual" });
  const cookie = () => ({ cookie: `forge_session=${createSession(app.db, alice()).token}` });

  test("POST /talk/again/:how takes only the signed-in person's own browser", async () => {
    withBinary(answers("Again."));
    expect((await post("/talk/again/regenerate", { ...cookie(), origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await post("/talk/again/regenerate", { authorization: `Bearer ${token}` })).status).toBe(403);
    expect((await post("/talk/again/sideways", cookie())).status).toBe(404);
    for (const body of ["text=", `text=${"x".repeat(WORDS_MAX + 1)}`, ""]) {
      const res = await post("/talk/again/edit", { ...cookie(), accept: "application/json" }, body);
      expect(res.status).toBe(422);
      expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    }
    const plain = await post("/talk/again/regenerate", cookie());
    expect(plain.status).toBe(303);
    await settle();
    const json = await post("/talk/again/regenerate", { ...cookie(), accept: "application/json" });
    expect(json.status).toBe(202);
    await settle();
    const edit = await post("/talk/again/edit", { ...cookie(), accept: "application/json" }, "text=via+the+form");
    expect(edit.status).toBe(202);
    await settle();
    expect((await standing()).slice(-2)).toEqual(["person:via the form", "agent:Again."]);
    const nothing = await post("/talk/again/retry", { ...cookie(), accept: "application/json" });
    expect(nothing.status).toBe(409);
  });

  test("a redo is refused with running while a turn is live", async () => {
    withBinary(`sleep 1\n${answers("Slow.")}`);
    const sent = talk(app, as(), "slow one");
    expect(sent.ok).toBe(true);
    const refused = again("regenerate");
    expect(!refused.ok && refused.error).toBe("running");
    const edit = again("edit", "meanwhile");
    expect(!edit.ok && edit.error).toBe("running");
    await settle();
  });

  test("the agent's history leaves out replaced and failed turns", async () => {
    const conv = openConversation(app.db, alice());
    const stored = listTurns(app.db, alice(), conv.id, { limit: 200 });
    if (!stored.ok) throw new Error("turns");
    const out = withHistory(app, conv, "next question");
    for (const t of stored.value.filter((t) => t.replaced || t.failed)) {
      if (!stored.value.some((o) => !o.replaced && !o.failed && o.text === t.text)) expect(out).not.toContain(t.text);
    }
    expect(out).not.toContain("Second answer.");
    expect(stored.value.some((t) => t.replaced)).toBe(true);
    expect(out).toContain("via the form");
  });

  test("a turn the account was too resting to answer shows its own words with Retry", async () => {
    withBinary(
      `echo '{"type":"system","subtype":"init","session_id":"s-limit","model":"fake"}'\necho '{"type":"result","subtype":"success","is_error":true,"result":"You have hit your session limit · resets 7:20am (UTC)","total_cost_usd":0,"num_turns":1,"session_id":"s-limit","terminal_reason":"api_error","usage":{"input_tokens":1,"output_tokens":1}}'`,
    );
    await settled(again("regenerate"));
    await settle();
    const last = (await turns()).turns.at(-1)!;
    expect(last.failed).toBe(true);
    expect(last.text).not.toContain("session limit");
    expect(last.text).toMatch(/window is full|resting/);
    const conv = openConversation(app.db, alice());
    expect(turnHtml(last as never, new Set(), undefined, exchangeActs(app.db, alice(), conv.id, false).get(last.id)).text).toContain("Retry");
  });

  test("ssh talk-again reaches the same three actions", async () => {
    expect(parseTalkAgain("talk-again retry")).toEqual({ how: "retry", words: "" });
    expect(parseTalkAgain("talk-again edit  new words")).toEqual({ how: "edit", words: "new words" });
    expect(parseTalkAgain("talk-again sideways")).toBeUndefined();
    expect(parseTalkAgain("talk retry")).toBeUndefined();
    withBinary(answers("By ssh again."));
    expect((await exec("talk-again edit by terminal")).code).toBe(0);
    await settle();
    expect((await standing()).slice(-2)).toEqual(["person:by terminal", "agent:By ssh again."]);
    expect((await exec("talk-again retry")).code).toBe(1);
    expect((await exec("talk-again edit bad\u0007words")).code).toBe(1);
  });

  test("ssh talk /stop stops instead of speaking; with nothing running it says so (#8818)", async () => {
    expect(isStop("/stop")).toBe(true);
    expect(isStop(" --stop ")).toBe(true);
    expect(isStop("please /stop")).toBe(false);
    await settle();
    const before = await persons();
    const r = await exec("talk /stop");
    expect(r.code).toBe(1);
    expect(await persons()).toEqual(before);
  });

  test("the MCP stop with a run and no repo, or a repo and no run, is an error", async () => {
    for (const args of [{ run: "x" }, { repo: "alice/x" }]) {
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: { ...headers(token), accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "stop", arguments: args } }),
      });
      const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0]!.text).toContain("give both");
    }
  });

  describe("attachments (#8820)", () => {
    const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const upload = (t: string, name: string, body: Uint8Array | string, extra: Record<string, string> = {}) =>
      fetch(`${servers.url}/api/v1/conversation/files`, { method: "POST", headers: { authorization: `Bearer ${t}`, "x-file-name": encodeURIComponent(name), ...extra }, body });
    const send = (t: string, body: unknown) =>
      fetch(`${servers.url}/api/v1/conversation/messages`, { method: "POST", headers: headers(t), body: JSON.stringify(body) });
    let bob: string;
    beforeAll(async () => {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
      if (!made.ok) throw new Error(made.error);
      bob = createToken(app.db, made.value.id, "personal", "rw").token;
      app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(made.value.id);
    });
    // Bob's own turn (alice's minute of messages is spent by the tests above).
    let seen = "";
    beforeAll(() => {
      // Earlier tests swap in their own stand-ins; this one records the first message it is started with.
      const mine = join(dir, "claude-records");
      writeFileSync(mine, readFileSync(join(dir, "claude"), "utf8"));
      chmodSync(mine, 0o755);
      configureConversation(app, { binary: mine, localUrl: servers.url, budgetUsd: 1, timeoutMs: 30_000, signal: new AbortController().signal });
      seen = existsSync(join(dir, "first.json")) ? readFileSync(join(dir, "first.json"), "utf8") : "";
    });
    const settleBob = async () => {
      // The stand-in records the message it was started with; wait for a new one, then for the end.
      for (let i = 0; i < 80 && readFileSync(join(dir, "first.json"), "utf8") === seen; i++) await Bun.sleep(25);
      if (readFileSync(join(dir, "first.json"), "utf8") === seen) throw new Error(`never came: still waiting while readFileSync(join(dir, "first.json"), "utf8") === seen`);
      seen = readFileSync(join(dir, "first.json"), "utf8");
      for (let i = 0; i < 200; i++) {
        const r = (await (await fetch(`${servers.url}/api/v1/conversation/turns`, { headers: headers(bob) })).json()) as { running: boolean };
        if (!r.running) return;
        await Bun.sleep(25);
      }
    };

    test("an image reaches the run as an image, and a text file as quoted data, for that turn alone", async () => {
      const up = await upload(bob, "shot.png", PNG, { "content-type": "text/html" });
      expect(up.status).toBe(201);
      const png = (await up.json()) as { id: string; type: string; size: number };
      expect(png.type).toBe("image/png");
      const note = (await (await upload(bob, "notes.md", "remember the milk")).json()) as { id: string };
      expect((await send(bob, { text: "look at these", files: [png.id, note.id] })).status).toBe(202);
      await settleBob();
      const first = JSON.parse(readFileSync(join(dir, "first.json"), "utf8")) as { message: { content: { type: string; text?: string; source?: { media_type: string; data: string } }[] } };
      const image = first.message.content.find((c) => c.type === "image")!;
      expect(image.source!.media_type).toBe("image/png");
      expect(Buffer.from(image.source!.data, "base64")).toEqual(Buffer.from(PNG));
      expect(first.message.content.find((c) => c.type === "text")!.text).toContain("remember the milk");
      // Stored beside the conversation under the data dir, not in the repository.
      expect(readdirSync(join(dir, "conversation-files")).length).toBe(1);
      // The next message is not handed it again, and the files cannot be attached twice.
      expect((await send(bob, { text: "again", files: [png.id] })).status).toBe(404);
      expect((await send(bob, { text: "plain" })).status).toBe(202);
      await settleBob();
      expect(readFileSync(join(dir, "first.json"), "utf8")).not.toContain("image");
      // The owner can read it back as a download with a fixed type.
      const got = await fetch(`${servers.url}/api/v1/conversation/files/${png.id}`, { headers: headers(bob) });
      expect(got.status).toBe(200);
      expect(got.headers.get("content-type")).toBe("image/png");
      expect(got.headers.get("content-disposition")).toStartWith("attachment");
      expect(got.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
    });

    test("an oversized file, an empty one and a disguised one are refused in plain words", async () => {
      expect((await upload(token, "empty.txt", "")).status).toBe(422);
      const html = await upload(token, "page.png", "<script>alert(1)</script>", { "content-type": "image/png" });
      expect(html.status).toBe(415);
      expect((await upload(token, "run.exe", "MZ text")).status).toBe(415);
      expect((await upload(token, "long.txt", "x".repeat(100 * 1024 + 1))).status).toBe(413);
      // Last: the forge closes the connection after a body past the limit.
      const big = await upload(token, "big.png", new Uint8Array(5 * 1024 * 1024 + 1).fill(1), { connection: "close" });
      expect(big.status).toBe(413);
      expect(((await big.json()) as { message: string }).message).toContain("5 MB");
    });

    test("another person cannot fetch, remove or send it", async () => {
      const mine = (await (await upload(token, "private.txt", "mine")).json()) as { id: string };
      const url = `${servers.url}/api/v1/conversation/files/${mine.id}`;
      expect((await fetch(url, { headers: headers(bob) })).status).toBe(404);
      expect((await fetch(url, { method: "DELETE", headers: headers(bob) })).status).toBe(404);
      expect((await send(bob, { text: "stolen", files: [mine.id] })).status).toBe(404);
      expect((await fetch(url)).status).toBe(401);
      expect((await upload(bob, "x.txt", "x", { origin: "https://elsewhere.example" })).status).toBe(403);
    });

    test("a chosen file can be removed before it is sent", async () => {
      const f = (await (await upload(token, "gone.txt", "bye")).json()) as { id: string };
      const url = `${servers.url}/api/v1/conversation/files/${f.id}`;
      expect((await fetch(url, { method: "DELETE", headers: headers(token) })).status).toBe(200);
      expect((await fetch(url, { headers: headers(token) })).status).toBe(404);
      expect(existsSync(join(dir, "conversation-files"))).toBe(true);
    });
  });
});
