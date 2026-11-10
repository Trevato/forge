/**
 * The `limits` tool (#7149): a forge admin lists every limit, plans a change
 * first and applies it only with an admin-scope token; `""` restores the
 * default; an unknown key and a value out of bounds are refused with the limit
 * unchanged; a non-admin and an agent are told there is no such tool.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { LIMIT_KEYS, limitValue } from "../src/settings/limits.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const KEY = "front.pinned_max";

describe("MCP limits", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let adaAdmin = "";
  let adaRw = "";
  let cyToken = "";
  let botToken = "";
  let id = 1;

  const call = async (token: string, args: Record<string, unknown>) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: id++,
        method: "tools/call",
        params: { name: "limits", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    if (body.error) return { text: body.error.message as string, error: true };
    return { text: body.result.content[0].text as string, error: body.result.isError === true };
  };
  const now = () => limitValue(app.db, KEY);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-limits-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    const make = async (username: string, adminIfFirst = false) => {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    const ada = await make("ada", true);
    const cy = await make("cy");
    const bot = await createAgent(app, ada, { username: "botty", brief: "b", model: "m" });
    if (!bot.ok) throw new Error(String(bot.error));
    app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(bot.value.user.id);
    adaAdmin = createToken(app.db, ada.id, "admin", "admin").token;
    adaRw = createToken(app.db, ada.id, "rw", "rw").token;
    cyToken = createToken(app.db, cy.id, "admin", "admin").token;
    botToken = createToken(app.db, bot.value.user.id, "admin", "admin").token;
  }, 60_000);

  afterAll(async () => {
    servers?.stop();
    app?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  test("a forge admin lists every limit with value, default and bounds", async () => {
    const res = await call(adaAdmin, {});
    expect(res.error).toBe(false);
    const { limits } = JSON.parse(res.text);
    expect(limits.map((l: any) => l.key)).toEqual([...LIMIT_KEYS]);
    const row = limits.find((l: any) => l.key === KEY);
    expect(row.value).toBe(row.defaultValue);
    expect(row.min).toBe(1);
    expect(row.max).toBe(100);
  });

  test("setting plans first; dryRun false applies; an empty value restores the default", async () => {
    const before = now();
    const planned = await call(adaAdmin, { key: KEY, value: "7" });
    expect(planned.error).toBe(false);
    expect(JSON.parse(planned.text).says).toContain("Would set");
    expect(now()).toBe(before);

    const applied = await call(adaAdmin, { key: KEY, value: "7", dryRun: false });
    expect(applied.error).toBe(false);
    expect(JSON.parse(applied.text).to).toBe(7);
    expect(now()).toBe(7);

    const restored = await call(adaAdmin, { key: KEY, value: "", dryRun: false });
    expect(restored.error).toBe(false);
    expect(now()).toBe(before);
  });

  test("a token below admin scope plans but cannot apply", async () => {
    const before = now();
    const refused = await call(adaRw, { key: KEY, value: "7", dryRun: false });
    expect(refused.error).toBe(true);
    expect(refused.text).toContain("admin-scope");
    expect(now()).toBe(before);
  });

  test("an unknown key is no_such_limit and names the key", async () => {
    for (const dryRun of [true, false]) {
      const res = await call(adaAdmin, { key: "no_such_thing", value: "5", dryRun });
      expect(res.error).toBe(true);
      expect(res.text).toContain("no_such_limit");
      expect(res.text).toContain("no_such_thing");
    }
  });

  test("a value outside the bounds is refused and the limit unchanged", async () => {
    const before = now();
    for (const value of ["0", "101", "-1", "abc", "1.5"]) {
      const res = await call(adaAdmin, { key: KEY, value, dryRun: false });
      expect(res.error).toBe(true);
      expect(now()).toBe(before);
    }
  });

  test("a non-admin and an agent are refused, the limit unchanged", async () => {
    const before = now();
    for (const token of [cyToken, botToken]) {
      for (const args of [{}, { key: KEY, value: "9" }, { key: KEY, value: "9", dryRun: false }]) {
        expect((await call(token, args)).error).toBe(true);
      }
    }
    expect(now()).toBe(before);
  });

  const PLANS = [
    { key: "free", name: "Free", says: "to try it", size: "small", priceUsd: 0, creditUsd: 0, forges: 1 },
    { key: "pro", name: "Pro", says: "for work", size: "medium", priceUsd: 9, creditUsd: 3, forges: 2 },
  ];

  test("plans: a dry run validates, applying needs admin scope, a non-admin has no tool", async () => {
    const dry = await call(adaAdmin, { plans: PLANS });
    expect(dry.error).toBe(false);
    expect(JSON.parse(dry.text).plans.map((p: any) => p.key)).toEqual(["free", "pro"]);
    expect(JSON.parse((await call(adaAdmin, {})).text).plans.map((p: any) => p.key)).toEqual(["free", "small", "medium", "large"]);
    // A dry run tells the truth: a bad list is refused as the real change would refuse it.
    const bad = await call(adaAdmin, { plans: PLANS.slice(1) });
    expect(bad.error).toBe(true);
    expect(bad.text).toContain("the free plan cannot be removed");
    expect((await call(adaAdmin, { plans: [{ ...PLANS[0], size: "huge" }] })).error).toBe(true);
    expect((await call(adaAdmin, { plans: [] })).error).toBe(true);
    // Below admin scope may plan but not apply.
    const ro = await call(adaRw, { plans: PLANS, dryRun: false });
    expect(ro.error).toBe(true);
    expect(ro.text).toContain("admin-scope");
    expect(JSON.parse((await call(adaAdmin, {})).text).plans).toHaveLength(4);
    // A non-admin and an agent are told there is no such tool.
    expect((await call(cyToken, { plans: PLANS, dryRun: false })).error).toBe(true);
    expect((await call(botToken, { plans: PLANS, dryRun: false })).error).toBe(true);
    expect(JSON.parse((await call(adaAdmin, {})).text).plans).toHaveLength(4);
    const applied = await call(adaAdmin, { plans: PLANS, dryRun: false });
    expect(applied.error).toBe(false);
    expect(JSON.parse((await call(adaAdmin, {})).text).plans.map((p: any) => p.key)).toEqual(["free", "pro"]);
  });
});
