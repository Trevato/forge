// @tree-scan: lists the repository through a walk it hands a rooted path.
/**
 * Every 429 and 503 the HTTP layer answers says for how long (#10762).
 * Part one reads src/http per site: a status literal must sit in a `tryAgain`
 * call, or in a call that spells its own retry-after, or be named below with
 * the reason it is safe. Part two drives the real limits through a running
 * forge and asserts the integer header and an equal `retryAfter` in the body.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript-api";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { readOnlyRefusal } from "../src/http/read_only.ts";
import { json, tryAgain } from "../src/http/respond.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setStrangerLimits, strangerLimits } from "../src/http/strangers.ts";

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });

const PERF_LINE = `src/http/server.ts: ${readFileSync("src/http/server.ts", "utf8").split("\n").find((l) => l.includes("refused: response.status === 429"))!.trim()}`;

/** Sites that are not a response of their own, each with why it is safe. `file: trimmed line`. */
const EXEMPT: Record<string, string> = {
  [PERF_LINE]: "a comparison, not a response",
  "src/http/respond.ts: if (status === 429 || status === 503) {": "json()'s floor itself",
  "src/http/respond.ts: status: 429 | 503,": "tryAgain's own signature",
  "src/http/api/print.ts: rate_limited: 429,": "status table; printRefusal answers through tryAgain",
  "src/http/api/print.ts: daily_cap: 429,": "status table; printRefusal answers through tryAgain",
  "src/http/api/conversation_talk.ts: return status === 429 || status === 503 ? tryAgain(said.error, status, words, talkWait(said.error)) : json({ error: said.error, message: words }, status);":
    "the 429/503 branch is the tryAgain",
  "src/http/api/following.ts: ? 429": "the ceiling outcome is answered through tryAgain just below",
  "src/http/feed.ts: error.code === \"forbidden\" ? 403 : error.code === \"too_many\" ? 429 : error.code === \"already_undone\" || error.code === \"expired\" ? 409 : 422,":
    "a cap on one request's size, not a wait; json()'s 60 s floor answers it",
  "src/http/api/timers.ts: const STATUS: Record<TimerError, number> = { unauthorized: 401, invalid: 422, too_many: 429, not_found: 404 };":
    "a cap on timers per app, not a wait; json()'s 60 s floor answers it",
  "src/http/rp.ts: const slow = failure(ctx, `Too many attempts. Try again in ${retryAfterOf(wait)}s.`, 429);": "an HTML page; the header is set on the next line",
  "src/http/read_only.ts: status: 503,": "plain text; its headers are MAINTENANCE_HEADERS, which carry retry-after (the JSON answer above names it in the body too)",
  "src/http/server.ts: may.refusal === \"not_found\" ? [404, \"not found\"] : may.refusal === \"busy\" ? [429, \"too many shells\"] : [403, \"forbidden\"];":
    "plain text; the Response below carries retry-after",
};

/** Every 429/503 numeric literal in src/http that no allowed shape covers, as `file: line`. */
function unnamedWaits(): string[] {
  const out: string[] = [];
  for (const f of files("src/http")) {
    const text = readFileSync(f, "utf8");
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
    const visit = (n: ts.Node) => {
      if (ts.isNumericLiteral(n) && (n.text === "429" || n.text === "503")) {
        let c: ts.Node | undefined = n.parent;
        while (c && !ts.isCallExpression(c) && !ts.isNewExpression(c) && !ts.isStatement(c)) c = c.parent;
        const call = c && (ts.isCallExpression(c) || ts.isNewExpression(c)) ? c : undefined;
        const callee = call?.expression.getText() ?? "";
        const line = text.split("\n")[sf.getLineAndCharacterOfPosition(n.getStart()).line]!.trim();
        const key = `${f}: ${line}`;
        const covered = callee === "tryAgain" || (call !== undefined && /retry-?after/i.test(call.getText()));
        if (!covered && EXEMPT[key] === undefined) out.push(key);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return out;
}

describe("every 429 and 503 site in src/http", () => {
  test("is a tryAgain, spells its own retry-after, or is named with its reason", () => {
    expect(unnamedWaits()).toEqual([]);
  });
  test("the scan catches a bare Response beside a helper call", () => {
    // The shape the old window scan let through: a helper nearby, a bare 429 of its own.
    const src = `json({}); return new Response("slow", { status: 429 });`;
    const sf = ts.createSourceFile("x.ts", src, ts.ScriptTarget.Latest, true);
    let bare = 0;
    const visit = (n: ts.Node) => {
      if (ts.isNumericLiteral(n) && n.text === "429") {
        let c: ts.Node = n.parent;
        while (!ts.isNewExpression(c)) c = c.parent;
        if (!/retry-?after/i.test(c.getText())) bare++;
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(bare).toBe(1);
  });
});

/** The integer header and the body's `retryAfter` say the same seconds. */
async function told(res: Response, status: 429 | 503 = 429): Promise<number> {
  expect(res.status).toBe(status);
  const header = res.headers.get("retry-after");
  expect(header).toMatch(/^[1-9]\d*$/);
  const body = (await res.json()) as { retryAfter?: unknown };
  expect(body.retryAfter).toBe(Number(header));
  return Number(header);
}

describe("the limits, driven through a running forge", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let n = 0;
  const tokens: string[] = [];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-retry-after-"));
    process.env["FORGE_RATE_LIMIT"] = "3";
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    delete process.env["FORGE_RATE_LIMIT"];
    base = servers.url.replace("localhost", "127.0.0.1");
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "rae", email: "rae@forge.local", password: "a-good-passphrase", isAdmin: true });
    if (!made.ok) throw new Error(made.error);
    for (let i = 0; i < 4; i++) tokens.push(createToken(app.db, made.value.id, `t${i}`, "rw").token);
  });
  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Repeat `go` until it answers 429 (at most `max` tries); the refusal. */
  async function until(go: () => Promise<Response>, max: number): Promise<Response> {
    for (let i = 0; i < max; i++) {
      const res = await go();
      if (res.status === 429 || res.status === 503) return res;
    }
    throw new Error("never limited");
  }

  test("the per-token minute limit on the API", async () => {
    const res = await until(() => fetch(`${base}/api/v1/user`, { headers: { authorization: `Bearer ${tokens[0]}` } }), 10);
    expect(await told(res)).toBeLessThanOrEqual(60);
  });

  test("the same limit on /mcp", async () => {
    const res = await until(
      () =>
        fetch(`${base}/mcp`, {
          method: "POST",
          headers: { authorization: `Bearer ${tokens[1]}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        }),
      10,
    );
    expect(await told(res)).toBeLessThanOrEqual(60);
  });

  test("a stranger's per-address limit on the API", async () => {
    setStrangerLimits(app, { perAddress: { ...strangerLimits(app).perAddress, api: 2 } });
    const res = await until(() => fetch(`${base}/api/v1/repos`), 10);
    expect(await told(res)).toBeLessThanOrEqual(60);
  });

  test("a stranger's code search", async () => {
    setStrangerLimits(app, { perAddress: { ...strangerLimits(app).perAddress, code: 1 } });
    const res = await until(() => fetch(`${base}/api/v1/search?kind=code&q=needle`), 10);
    expect(await told(res)).toBeLessThanOrEqual(60);
  });

  test("sign-up", async () => {
    const res = await until(
      () =>
        fetch(`${base}/api/v1/users`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: `person${++n}`, email: `p${n}@outsider.test`, password: "a-good-passphrase" }),
        }),
      12,
    );
    expect(await told(res)).toBeLessThanOrEqual(60);
  });

  test("oauth register", async () => {
    const res = await until(
      () =>
        fetch(`${base}/oauth/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ client_name: "x", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
        }),
      15,
    );
    expect(await told(res)).toBeLessThanOrEqual(60);
  });

  test("oauth revoke", async () => {
    const res = await until(
      () =>
        fetch(`${base}/oauth/revoke`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "token=forge_unknown",
        }),
      70,
    );
    expect(await told(res)).toBeLessThanOrEqual(60);
  });

  test("standby: a write on a read-only forge", async () => {
    const post = new Request("http://x/api/v1/things", { method: "POST" });
    expect(await told(readOnlyRefusal(post)!, 503)).toBe(300);
  });

  test("the shared responses: a site's own wait wins, a silent one gets the floor", async () => {
    expect(await told(json({ error: "x" }, 429, { "Retry-After": "7" }))).toBe(7);
    expect(await told(json({ error: "x" }, 503), 503)).toBe(60);
    expect(await told(tryAgain("x", 429, "slow", 0.2))).toBe(1);
    expect(json({ error: "x" }, 404).headers.get("retry-after")).toBeNull();
  });
});
