/**
 * Every MCP tool answers hostile arguments with a named refusal, never a
 * 500, a throw or a hang (#11021). One forge boots; `tools/list` is read as
 * a signed-in non-admin; each listed tool is then called with seeded
 * hostile arguments built from its own inputSchema: no arguments, the
 * arguments not an object, wrong types, unknown keys (`__proto__` among
 * them), 10 kB strings, negative and huge numbers, `../` paths and deeply
 * nested objects. Every answer must be a JSON-RPC result (`isError` or not)
 * or a JSON-RPC error with a message, inside a second.
 *
 * Anonymous callers send every name the forge has (`toolNames()`): each is
 * the 401 that names `report`, except exactly the token-free tools, `report`
 * and `start` (the keys of `TOKEN_FREE_HANDLERS`, so the next one is fuzzed
 * without an edit here). Those are fuzzed anonymously from their own
 * schemas, the only caller that reaches their real path; a refused call
 * must leave no account and no repository behind, and `start` with a
 * hostile name must be refused.
 *
 * Exclusions, named rather than skipped silently: the admin-only tools are
 * not listed to the member, so they are fuzzed only as the "no tool named"
 * refusal a member gets for them (the last test); their argument checks run
 * behind the admin scope. Nothing here can reach outside the test forge:
 * the forge has no runner, no cloud account and no egress configured.
 *
 * Rerun one failure with `FUZZ_SEED=<n> bun test test/fuzz-mcp.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { TOKEN_FREE_HANDLERS, toolNames } from "../src/http/mcp.ts";
import { TOOLS } from "../src/http/mcp/tools.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { int, pick, rng, SEED, type Rand } from "./helpers/fuzz.ts";
import { listAt } from "./mcp-list.ts";

/** How long one call may take before it counts as a hang (ms). */
const CALL_MS = 1000;
/** Random cases per tool, on top of the fixed ones. */
const RANDOM_CASES = 4;

type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: unknown[] };

const BIG = "x".repeat(8 * 1024);
const nested = (depth: number): unknown => (depth === 0 ? { a: "../" } : { a: nested(depth - 1), b: [nested(0)] });

/** Hostile values in no particular type, for any field. */
const ANY: unknown[] = [
  null,
  true,
  0,
  -1,
  -2_147_483_649,
  1e308,
  Number.MAX_SAFE_INTEGER + 2,
  0.5,
  "",
  " ",
  BIG,
  "../../../etc/passwd",
  "..",
  "/",
  "bob/../alice/secret",
  "alice/open/../../x",
  // Real names, so a case gets past "not found" to the argument checks behind it.
  "alice/open",
  "alice/secret",
  "bob",
  "main",
  "%2e%2e%2f%2e%2e%2f",
  "a\u0000b",
  "<script>alert(1)</script>",
  "'; drop table users; --",
  "‮\ud800",
  [],
  ["../", 1, null],
  {},
  { __proto__: null, toString: 1 },
  nested(40),
];

/** Wrong for the declared type: a string where a number is wanted, and so on. */
function wrongFor(schema: Schema): unknown[] {
  const types = [schema.type].flat();
  const out: unknown[] = [];
  if (types.includes("string")) out.push(42, ["a"], { s: "a" }, BIG, "../../..", "");
  if (types.includes("integer") || types.includes("number"))
    out.push("12", -1, -1e308, 1e308, 0.25, Number.MAX_SAFE_INTEGER * 4, { n: 1 });
  if (types.includes("boolean")) out.push("true", 1, null);
  if (types.includes("array")) out.push("a,b", { 0: "a" }, Array.from({ length: 2000 }, () => "../"), [nested(20)]);
  if (types.includes("object")) out.push("{}", [], nested(40));
  if (out.length === 0) out.push(...ANY.slice(0, 6));
  return out;
}

/** The fixed cases for a schema, then seeded random ones. */
function cases(name: string, schema: Schema, r: Rand): unknown[] {
  const props = Object.entries(schema.properties ?? {});
  const all: unknown[] = [undefined, {}, "not-an-object", [1, 2], null];
  // Every field at once: each wrong type, an 8 kB string, a `../` path.
  // All fields at once must stay under the 64 KiB anonymous body cap.
  for (const pickAt of [0, 3, 4]) {
    const args: Record<string, unknown> = {};
    for (const [k, s] of props) args[k] = wrongFor(s)[pickAt % wrongFor(s).length];
    all.push(args);
  }
  // Unknown keys, `__proto__` set as an own key (JSON.parse makes it one).
  all.push(JSON.parse(`{"__proto__":{"admin":true,"scope":"admin"},"constructor":{"prototype":{}},"zz${name}":1}`));
  // Huge and negative numbers in every numeric field, required present.
  const numeric: Record<string, unknown> = {};
  for (const [k, s] of props) numeric[k] = [s.type].flat().some((t) => t === "integer" || t === "number") ? -1e308 : "../";
  all.push(numeric);
  // Seeded: each field drawn from its wrong values or the general pool, some left out.
  for (let i = 0; i < RANDOM_CASES; i++) {
    const args: Record<string, unknown> = {};
    for (const [k, s] of props) {
      if (r() < 0.25) continue;
      args[k] = r() < 0.5 ? pick(r, wrongFor(s)) : pick(r, ANY);
    }
    if (r() < 0.3) args[`extra${int(r, 100)}`] = pick(r, ANY);
    all.push(args);
  }
  return all;
}

const seedFor = (name: string): number => {
  let h = SEED >>> 0;
  for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return h;
};

describe("MCP fuzz: hostile arguments get a named refusal", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let member: string;
  let bobId: string;
  let id = 1;
  let spent = 0;

  /**
   * The member's token, a fresh one every 400 calls: the forge holds each
   * token to 600 requests a minute (and fewer proposals), and the fuzz is
   * about argument checks, not that limiter, which has its own tests.
   */
  const memberToken = (): string => {
    if (++spent % 400 === 0) member = createToken(app.db, bobId, `rw${spent}`, "rw").token;
    return member;
  };

  /** One tools/call, raw: the HTTP status, the parsed body, and how long it took. */
  const call = async (token: string | undefined, name: string, args: unknown) => {
    const started = performance.now();
    const params = args === undefined ? { name } : { name, arguments: args };
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params }),
      signal: AbortSignal.timeout(CALL_MS * 5),
    });
    const text = await res.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      body = { unparsed: text.slice(0, 200) };
    }
    return { status: res.status, body, ms: performance.now() - started };
  };

  /** Why an answer is not a named refusal or a result, or undefined when it is. */
  const flaw = (a: { status: number; body: any; ms: number }): string | undefined => {
    if (a.ms > CALL_MS) return `took ${Math.round(a.ms)} ms`;
    if (a.status !== 200) return `HTTP ${a.status}: ${JSON.stringify(a.body).slice(0, 200)}`;
    const b = a.body;
    if (b?.jsonrpc !== "2.0") return `not JSON-RPC: ${JSON.stringify(b).slice(0, 200)}`;
    if (b.error !== undefined)
      return typeof b.error.message === "string" && b.error.message.length > 0 ? undefined : "an error without a message";
    const content = b.result?.content;
    if (!Array.isArray(content) || typeof content[0]?.text !== "string") return "a result without text content";
    if (b.result.isError === true && content[0].text.trim().length === 0) return "isError without a message";
    return undefined;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-fuzz-mcp-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const alice = await mk("alice", true);
    const bob = await mk("bob");
    bobId = bob.id;
    member = createToken(app.db, bob.id, "rw", "rw").token;
    for (const [owner, name, visibility] of [[alice, "secret", "private"], [alice, "open", "public"]] as const) {
      const made = await createRepo(app, owner, { name, visibility });
      if (!made.ok) throw new Error(String(made.error));
    }
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("as a signed-in member, every listed tool answers every case with a result or a named error", async () => {
    const listed: { name: string; inputSchema: Schema }[] = (await listAt(servers.url, member)).result.tools;
    expect(listed.length).toBeGreaterThan(50);
    expect(listed.map((t) => t.name)).toContain("report");
    const flaws: string[] = [];
    for (const tool of listed) {
      const r = rng(seedFor(tool.name));
      for (const args of cases(tool.name, tool.inputSchema, r)) {
        let problem: string | undefined;
        try {
          problem = flaw(await call(memberToken(), tool.name, args));
        } catch (error) {
          problem = `threw: ${String(error)}`;
        }
        if (problem !== undefined)
          flaws.push(`${tool.name} ${JSON.stringify(args)?.slice(0, 160)}: ${problem}`);
      }
    }
    expect(flaws).toEqual([]);
  }, 60_000);

  test("anonymous reaches exactly the token-free tools, and each refuses hostile arguments by name, leaving nothing behind", async () => {
    const free = Object.keys(TOKEN_FREE_HANDLERS).sort();
    expect(free).toEqual(["report", "start"]);
    const reached: string[] = [];
    for (const name of toolNames()) {
      const a = await call(undefined, name, { repo: "../../etc", title: BIG, __proto__: { admin: true } });
      if (a.status === 401) {
        expect(typeof a.body.message).toBe("string");
        expect(a.body.message).toContain("report");
        continue;
      }
      expect([name, flaw(a)]).toEqual([name, undefined]);
      reached.push(name);
    }
    expect(reached.sort()).toEqual(free);

    // Each token-free tool's schema as the forge lists it, so none is fuzzed from a copy.
    const listed: { name: string; inputSchema: Schema }[] = (await listAt(servers.url, member)).result.tools;
    const counts = () =>
      app.db.query<{ users: number; repos: number }, []>("SELECT (SELECT count(*) FROM user) AS users, (SELECT count(*) FROM repo) AS repos").get();
    for (const name of free) {
      const schema = listed.find((t) => t.name === name)?.inputSchema;
      expect([name, schema === undefined]).toEqual([name, false]);
      const r = rng(seedFor(name));
      for (const args of cases(name, schema as Schema, r)) {
        const label = `${name} ${JSON.stringify(args)?.slice(0, 160)}`;
        const before = counts();
        const a = await call(undefined, name, args);
        expect([label, flaw(a)]).toEqual([label, undefined]);
        const refused = a.body.error !== undefined || a.body.result?.isError === true;
        if (refused) expect([label, counts()]).toEqual([label, before]);
        const given = typeof args === "object" && args !== null ? (args as Record<string, unknown>)["name"] : undefined;
        const badName = typeof given !== "string" || given.trim() === "" || given.trim().length > 40 || !/[a-z0-9]/i.test(given);
        if (name === "start" && badName) expect([label, refused]).toEqual([label, true]);
      }
    }
  }, 30_000);

  test("an admin-only tool, named by a member, is the same refusal as a tool that does not exist", async () => {
    const listed = new Set((await listAt(servers.url, member)).result.tools.map((t: { name: string }) => t.name));
    const hidden = TOOLS.filter((t) => !listed.has(t.name));
    expect(hidden.length).toBeGreaterThan(0);
    for (const t of hidden) {
      const a = await call(memberToken(), t.name, { "../": BIG });
      expect([t.name, flaw(a)]).toEqual([t.name, undefined]);
    }
  });
});
