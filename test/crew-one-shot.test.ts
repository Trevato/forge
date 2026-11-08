/** oneShot (#9569): the refusals, the budget clamp and the cost booking, against a fake binary. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { dailyLeft, setAccountCeiling } from "../src/core/account_ceiling.ts";
import { createUser } from "../src/core/users.ts";
import { configureConversation } from "../src/crew/conversation.ts";
import { ONE_SHOT_USD, oneShot } from "../src/crew/one_shot.ts";

let dir = "", app: ReturnType<typeof createApp>, admin = "", member = "";
const args = () => readFileSync(join(dir, "args.txt"), "utf8");

describe("oneShot", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-one-shot-"));
    app = createApp({ dataDir: dir, port: 0 });
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@forge.local", password: "a-good-passphrase" });
    if (!a.ok || !b.ok) throw new Error("users");
    admin = a.value.id;
    member = b.value.id;
    const bin = join(dir, "claude");
    writeFileSync(bin, `#!/bin/sh\necho "$@" > "${dir}/args.txt"\nIFS= read -r first\necho '{"type":"system","subtype":"init","session_id":"s1","model":"fake"}'\necho '{"type":"result","subtype":"success","is_error":false,"result":"{}","total_cost_usd":0.02,"num_turns":1,"session_id":"s1","terminal_reason":"completed","usage":{"input_tokens":1,"output_tokens":1}}'\n`);
    chmodSync(bin, 0o755);
  });
  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const on = (budgetUsd = 1) => configureConversation(app, { binary: join(dir, "claude"), localUrl: "http://127.0.0.1:1", budgetUsd, timeoutMs: 30_000, signal: new AbortController().signal });
  const spent = () => app.db.query<{ n: number }, []>("SELECT spent_usd AS n FROM subscription WHERE id = 'platform'").get()?.n ?? 0;

  test("with no crew configured it is off", async () => {
    expect(await oneShot(app, admin, "s", "p")).toEqual({ ok: false, error: "off" });
  });
  test("a member with no granted account has none", async () => {
    on();
    expect(await oneShot(app, member, "s", "p")).toEqual({ ok: false, error: "no_account" });
  });
  test("the answer comes back, the budget is the smallest cap, and the cost is booked", async () => {
    on(0.03);
    const before = spent();
    const r = await oneShot(app, admin, "s", "p");
    expect(r).toEqual({ ok: true, value: "{}" });
    expect(args()).toContain("--max-budget-usd 0.03");
    expect(args()).not.toContain(String(ONE_SHOT_USD));
    expect(spent() - before).toBeCloseTo(0.02, 5);
  });
  test("the configured budget above the one-shot cap is clamped to it", async () => {
    on(5);
    await oneShot(app, admin, "s", "p");
    expect(args()).toContain(`--max-budget-usd ${ONE_SHOT_USD}`);
  });
  test("a one-shot counts toward the asker's daily ceiling", async () => {
    on();
    setAccountCeiling(app.db, admin, 1, 1, admin, new Date());
    const before = dailyLeft(app.db, admin, new Date())!;
    expect(await oneShot(app, admin, "s", "p")).toEqual({ ok: true, value: "{}" });
    expect(before - dailyLeft(app.db, admin, new Date())!).toBeCloseTo(0.02, 5);
  });
  test("a spent daily ceiling rests it without starting the model", async () => {
    on();
    setAccountCeiling(app.db, admin, 0.01, 0.01, admin, new Date());
    app.db.exec("PRAGMA foreign_keys = OFF");
    app.db.query("INSERT INTO conversation_run (id, conversation_id, user_id, prompt, cost_usd, started_at) VALUES ('r1', 'c1', ?1, 'x', 0.5, ?2)").run(admin, new Date().toISOString());
    writeFileSync(join(dir, "args.txt"), "untouched");
    expect(await oneShot(app, admin, "s", "p")).toEqual({ ok: false, error: "resting" });
    expect(args()).toBe("untouched");
  });
});
