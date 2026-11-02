/**
 * A resumed turn does not repeat a write that finished unreported (#8254):
 * the write is recorded before it runs; the turn is cut, resumed, and the
 * same call sent again is answered with what was done, once.
 */
import { heard } from "../src/core/fence.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { argsHash, carryWrites, completeWrite, KEEP_MS, recordWrite, unended } from "../src/core/conversation_writes.ts";
import { createIssue, getIssue } from "../src/core/issues.ts";
import { createUser, type User } from "../src/core/users.ts";
import { mintViaToken } from "../src/core/via_token.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let rpcId = 1;
let worlds = 0;

async function call(token: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
  });
  const body: any = await res.json();
  return { text: body.result?.content?.[0]?.text as string, isError: body.result?.isError === true };
}

async function world() {
  const n = ++worlds;
  const made = await createRepo(app, alice, { name: `r${n}`, visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const issue = createIssue(app.db, { repoId: made.value.id, authorId: alice.id, title: "Ship it", body: "now" });
  if (!issue.ok) throw new Error(issue.error);
  const via = `conversation:r${n}`;
  const mint = () => {
    const m = mintViaToken(app.db, alice.id, via, `close ${issue.value.number} in alice/r${n}`, new Date(Date.now() + 600_000).toISOString());
    if (!m.ok) throw new Error(m.error);
    return m.value.token;
  };
  return { repo: `alice/r${n}`, repoId: made.value.id, number: issue.value.number, via, mint };
}

const state = (w: { repoId: string; number: number }) => {
  const i = getIssue(app.db, w.repoId, w.number);
  return i?.state;
};
const reopen = (w: { repoId: string; number: number }) =>
  app.db.query("UPDATE issue SET state = 'open' WHERE repo_id = ?1 AND number = ?2").run(w.repoId, w.number);

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-conversation-resume-writes-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  promote(app.db, u.value);
  alice = u.value;
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("a resumed turn", () => {
  test("a write recorded, the turn resumed, the same call sent: done once", async () => {
    const w = await world();
    const args = { repo: w.repo, number: w.number };
    const first = await call(w.mint(), "close", args);
    expect(first.isError).toBe(false);
    expect(state(w)).toBe("closed");
    // Its answer never reached the session; something reopened it meanwhile.
    reopen(w);
    carryWrites(app.db, w.via);
    const again = await call(w.mint(), "close", args);
    expect(JSON.parse(again.text)).toMatchObject({ already_done: true, tool: "close" });
    expect(JSON.parse(again.text).was).toContain("closed");
    expect(state(w)).toBe("open"); // not done twice
    // Once: a deliberate repeat after that goes ahead.
    const third = await call(w.mint(), "close", args);
    expect(JSON.parse(third.text).already_done).toBeUndefined();
    expect(state(w)).toBe("closed");
  });

  test("a write that began and never ended is not repeated either, and says so", async () => {
    const w = await world();
    const args = { repo: w.repo, number: w.number };
    app.db
      .query("INSERT INTO conversation_write (id, via, tool, args_hash, created_at) VALUES ('cut1', ?1, 'close', ?2, ?3)")
      .run(w.via, argsHash(args), new Date().toISOString());
    carryWrites(app.db, w.via);
    const again = await call(w.mint(), "close", args);
    expect(JSON.parse(again.text)).toMatchObject({ already_done: true });
    expect(JSON.parse(again.text).was).toBeUndefined();
    expect(state(w)).toBe("open");
  });

  test("a write the cut turn began and never ended is answered once, then the identical call runs", async () => {
    const w = await world();
    const args = { repo: w.repo, number: w.number };
    recordWrite(app.db, w.via, "close", args);
    carryWrites(app.db, w.via);
    expect(JSON.parse((await call(w.mint(), "close", args)).text).already_done).toBe(true);
    expect(state(w)).toBe("open");
    // The record is claimed by the first answer: the same call now goes ahead.
    const repeat = await call(w.mint(), "close", args);
    expect(JSON.parse(repeat.text).already_done).toBeUndefined();
    expect(state(w)).toBe("closed");
  });

  test("unended: only rows with no result, for that via, in id order", () => {
    const via = "conversation:unended-a";
    const insert = (rid: string, v: string, tool: string, result: string | null) =>
      app.db.query("INSERT INTO conversation_write (id, via, tool, args_hash, result, created_at) VALUES (?1,?2,?3,'h',?4,?5)").run(rid, v, tool, result, new Date().toISOString());
    insert("u3", via, "merge", null);
    insert("u1", via, "close", null);
    insert("u2", via, "comment", "done");
    insert("u4", "conversation:unended-b", "reopen", null);
    expect(unended(app.db, via)).toEqual(["close", "merge"]);
    completeWrite(app.db, "u1", "closed");
    expect(unended(app.db, via)).toEqual(["merge"]);
    expect(unended(app.db, "conversation:unended-none")).toEqual([]);
  });

  test("a different call, or a turn that was not cut, is done as asked", async () => {
    const w = await world();
    const args = { repo: w.repo, number: w.number };
    await call(w.mint(), "close", args);
    reopen(w);
    // Not resumed: the same write again in an ordinary turn goes ahead.
    const same = await call(w.mint(), "close", args);
    expect(JSON.parse(same.text).already_done).toBeUndefined();
    expect(state(w)).toBe("closed");
    // Resumed, but another argument: not the same write.
    reopen(w);
    carryWrites(app.db, w.via);
    // The first answer was fenced text, so the person must have named the write.
    const token = w.mint();
    heard(app.db, w.via, `close ${w.repo} ${w.number} dropped`);
    const other = await call(token, "close", { ...args, reason: "dropped" });
    expect(JSON.parse(other.text).already_done).toBeUndefined();
    expect(state(w)).toBe("closed");
  });

  test("a write that failed is not answered as done when the cut turn is resumed", async () => {
    const w = await world();
    const args = { repo: w.repo, number: w.number + 99 };
    const failed = await call(w.mint(), "close", args);
    expect(failed.isError).toBe(true);
    carryWrites(app.db, w.via);
    const again = await call(w.mint(), "close", args);
    expect(again.text).not.toContain("already_done");
  });

  test("records older than a day go when the next write is recorded", () => {
    const via = "conversation:old";
    const old = recordWrite(app.db, via, "close", { a: 1 }, Date.now() - KEEP_MS - 1000);
    recordWrite(app.db, via, "close", { a: 2 });
    const left = app.db.query("SELECT id FROM conversation_write WHERE via = ?1").all(via);
    expect(left.length).toBe(1);
    expect(left.some((r: any) => r.id === old)).toBe(false);
  });

  test("argument order does not change the hash", () => {
    expect(argsHash({ a: 1, b: { c: [1, 2], d: "x" } })).toBe(argsHash({ b: { d: "x", c: [1, 2] }, a: 1 }));
    expect(argsHash({ a: 1 })).not.toBe(argsHash({ a: 2 }));
  });
});
