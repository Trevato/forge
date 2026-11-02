/**
 * The doors to a conversation turn (#7651): `POST /api/v1/conversation/messages`,
 * the MCP `say` with no repo, and `ssh <forge> talk <words>` each reach
 * `say()` as the verified person; the forge's own agent cannot wake itself.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
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
import { TALK_PER_MINUTE } from "../src/actions/talk.ts";
import { turnsLimit } from "../src/http/api/conversation_talk.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { forgeSshSession } from "../src/tui/ssh.ts";
import { isStop, parseTalkCommand } from "../src/tui/ssh-talk.ts";
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

  const turns = async (): Promise<{ running: boolean; turns: { role: string; text: string }[] }> =>
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
});
