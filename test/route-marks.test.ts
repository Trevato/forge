/**
 * Every admin-only action refuses the everyday account (#11818). Both routers
 * are walked: each route must be marked `admin` or `open` in
 * `src/http/route_marks.ts`, so a new route has to choose. Each route marked
 * `admin` is called with an everyday (member) account and with the admin:
 * the first is refused with a 403 and the one sentence that says to sign in
 * as admin, the second is let through to its handler. Each MCP tool marked
 * `adminOnly` is called by the everyday account and refused with the same
 * sentence, and is listed to the admin.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { SIGN_IN_AS_ADMIN, setMember } from "../src/core/roles.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { TOOLS } from "../src/http/mcp/tools.ts";
import { mintViaToken } from "../src/core/via_token.ts";
import { readFenced, waitingFor } from "../src/core/fence.ts";
import { HEADS, ROUTES, headOf, isAdminRoute, markOf } from "../src/http/route_marks.ts";
import { buildApiRouter, buildRouter, forgeHttp, type ForgeHttp } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const FILL: Record<string, string> = {
  owner: "alice", username: "alice", name: "notes", number: "1", org: "alice",
  id: "1", team: "core", scope: "alice", job: "1", oid: "0", env: "prod", sha: "a".repeat(40),
};
const fill = (pattern: string): string =>
  pattern.replace(/:([a-z_]+)/g, (_, k: string) => FILL[k] ?? "x").replace(/\*[a-z_]+/, "x");

/** Admin pages with nothing in the path to fill that still answer 4xx on a bare forge, each with what it waits for. */
const ADMIN_GET_WANTS: Record<string, string> = {
  "GET /settings/traffic/scrapes/export": "a running capture and its ?group, else not found",
  "GET /settings/backups/live": "a snapshot store, which a bare forge has not started",
  "GET /api/v1/admin/profile": "a query naming what to profile, else 422",
};

const routes = () => [
  ...buildRouter().routes().map((r) => ({ ...r, api: false })),
  ...buildApiRouter().routes().map((r) => ({ ...r, api: true })),
];

describe("the route marks", () => {
  test("every registered route is marked admin or open", () => {
    const unmarked = routes().filter((r) => markOf(r.pattern) === undefined).map((r) => `${r.method} ${r.pattern}`);
    expect(unmarked).toEqual([]);
  });

  test("a route marked neither fails: an unknown head, or a new route under a mixed head", () => {
    expect(markOf("/brand-new-page")).toBeUndefined();
    expect(markOf("/api/v1/brand-new")).toBeUndefined();
    expect(HEADS["/settings"]).toBe("mixed");
    expect(markOf("/settings/brand-new")).toBeUndefined();
  });

  test("the marks name only registered routes and heads, so neither list goes stale", () => {
    const patterns = new Set(routes().map((r) => r.pattern));
    expect(Object.keys(ROUTES).filter((p) => !patterns.has(p))).toEqual([]);
    const heads = new Set([...patterns].map((p) => (p.startsWith("/api/") ? p.split("/").slice(0, 4).join("/") : `/${p.split("/")[1]}`)));
    expect(Object.keys(HEADS).filter((h) => !heads.has(h))).toEqual([]);
  });

  test("each route whose admin side is not called is a registered admin route", () => {
    const admin = new Set(routes().filter((r) => markOf(r.pattern) === "admin").map((r) => `${r.method} ${r.pattern}`));
    expect(Object.keys(ADMIN_GET_WANTS).filter((k) => !admin.has(k))).toEqual([]);
  });

  test("a head holding both admin and open routes is mixed, so each of its routes chooses", () => {
    const exceptions = Object.entries(ROUTES).filter(([p, m]) => {
      const head = HEADS[headOf(p)];
      return head !== "mixed" && head !== m;
    });
    expect(exceptions.map(([p]) => p)).toEqual([]);
  });

  test("an unlisted path under a mixed head is admin: a forgotten mark fails closed", () => {
    expect(isAdminRoute("/settings/brand-new")).toBe(true);
    expect(isAdminRoute("/admin/brand-new")).toBe(true);
    expect(isAdminRoute("/boards/a/b/c/d")).toBe(true);
  });

  test("a path falls on its pattern's mark, literal before parameter", () => {
    expect(isAdminRoute("/packs/new")).toBe(true);
    expect(isAdminRoute("/packs/someone")).toBe(false);
    expect(isAdminRoute("/settings/billing")).toBe(true);
    expect(isAdminRoute("/settings/tokens")).toBe(false);
    expect(isAdminRoute("/admin/flows")).toBe(false);
    expect(isAdminRoute("/api/v1/admin/capacity")).toBe(true);
    expect(isAdminRoute("/alice/notes")).toBe(false);
  });

  test("the refusal is one sentence that says to sign in as admin", () => {
    expect(SIGN_IN_AS_ADMIN).toContain("sign in as admin");
    expect(SIGN_IN_AS_ADMIN.match(/[.!?]/g)?.length).toBe(1);
    expect(SIGN_IN_AS_ADMIN.endsWith(".")).toBe(true);
  });
});

describe("every admin-only action refuses the everyday account", () => {
  let dataDir = "";
  let app: App;
  let http: ForgeHttp;
  let alice: User; // admin
  let carol: User; // everyday: a member, no `administer`
  const cells = process.env["FORGE_CELLS"];

  beforeAll(async () => {
    process.env["FORGE_CELLS"] = "off";
    dataDir = await mkdtemp(join(tmpdir(), "forge-route-marks-"));
    app = createApp({ dataDir, port: 0 });
    const mk = async (username: string, isAdmin: boolean) => {
      const r = await createUser(app.db, {
        origin: "seed", trusted: true, isAdmin, username, email: `${username}@forge.local`, password: "a-good-passphrase",
      });
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    alice = await mk("alice", true);
    carol = await mk("carol", false);
    setMember(app.db, carol.id, true, alice.id, new Date(0));
    http = forgeHttp(app);
  }, 60_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
    if (cells === undefined) delete process.env["FORGE_CELLS"];
    else process.env["FORGE_CELLS"] = cells;
  });

  const creds = new Map<string, { bearer: string; cookie: string }>();
  const credsOf = (u: User) => {
    const known = creds.get(u.id);
    if (known !== undefined) return known;
    const made = {
      bearer: `Bearer ${createToken(app.db, u.id, "t", "admin").token}`,
      cookie: `forge_session=${createSession(app.db, u.id).token}`,
    };
    creds.set(u.id, made);
    return made;
  };
  /** A refusal's status and words; a stream the gate let through is not read, only its status. */
  const send = async (u: User, method: string, pattern: string, api: boolean) => {
    const { bearer, cookie } = credsOf(u);
    const headers: Record<string, string> = api
      ? { authorization: bearer, "content-type": "application/json" }
      : { cookie, accept: "text/html", "content-type": "application/json" };
    if (method !== "GET") headers["origin"] = "http://forge.test";
    const res = await http.handle(
      new Request(`http://forge.test${fill(pattern)}`, { method, headers, ...(method === "GET" ? {} : { body: "{}" }) }),
    );
    if (res.status !== 403) {
      await res.body?.cancel();
      return { status: res.status, text: "" };
    }
    return { status: res.status, text: await res.text() };
  };
  const refusedKindly = (r: { status: number; text: string }, api: boolean): boolean =>
    r.status === 403 &&
    (api ? JSON.parse(r.text).message === SIGN_IN_AS_ADMIN : r.text.includes(SIGN_IN_AS_ADMIN.replace("'", "&#39;")));

  test("each admin route refuses the everyday account with the sentence, and lets the admin through", async () => {
    const admin = routes().filter((r) => markOf(r.pattern) === "admin");
    expect(admin.length).toBeGreaterThan(150);
    const wrong: string[] = [];
    for (const r of admin) {
      const everyday = await send(carol, r.method, r.pattern, r.api);
      if (!refusedKindly(everyday, r.api)) wrong.push(`${r.method} ${r.pattern}: everyday got ${everyday.status}`);
      const own = await send(alice, r.method, r.pattern, r.api);
      if (refusedKindly(own, r.api) || own.status >= 500) wrong.push(`${r.method} ${r.pattern}: admin got ${own.status}`);
      // A page with nothing to fill in answers the admin outright.
      if (r.method === "GET" && !r.pattern.includes(":") && own.status >= 400 && !(`GET ${r.pattern}` in ADMIN_GET_WANTS))
        wrong.push(`${r.method} ${r.pattern}: admin got ${own.status}`);
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  const mcp = async (u: User, method: string, params: Record<string, unknown>, token?: string) => {
    const res = await http.handle(
      new Request("http://forge.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token ?? createToken(app.db, u.id, "t", "admin").token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      }),
    );
    return (await res.json()) as {
      result?: { tools?: { name: string }[]; isError?: boolean; content?: { text: string }[] };
      error?: { message: string };
    };
  };

  test("each admin MCP tool refuses the everyday account with the sentence, and is listed to the admin", async () => {
    const adminTools = TOOLS.filter((t) => t.adminOnly === true);
    expect(adminTools.length).toBeGreaterThan(5);
    const listed = async (u: User) => {
      const names = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = (await mcp(u, "tools/list", cursor === undefined ? {} : { cursor })) as {
          result?: { tools?: { name: string }[]; nextCursor?: string };
        };
        for (const t of page.result?.tools ?? []) names.add(t.name);
        cursor = page.result?.nextCursor;
      } while (cursor !== undefined);
      return names;
    };
    const forAdmin = await listed(alice);
    const forEveryday = await listed(carol);
    const wrong: string[] = [];
    for (const t of adminTools) {
      const called = await mcp(carol, "tools/call", { name: t.name, arguments: {} });
      if (!called.error?.message.endsWith(SIGN_IN_AS_ADMIN)) wrong.push(`${t.name}: everyday got ${JSON.stringify(called)}`);
      if (forEveryday.has(t.name)) wrong.push(`${t.name}: listed to the everyday account`);
      if (!forAdmin.has(t.name)) wrong.push(`${t.name}: not listed to the admin`);
    }
    expect(wrong).toEqual([]);
  });

  test("the gate marks by the route the router matched: a git path under an owner named like a mixed head is open", async () => {
    const res = await send(carol, "GET", "/settings/demo.git/info/refs", false);
    expect(res.status).not.toBe(403);
    expect((await send(carol, "GET", "/settings/no-such-page", false)).status).toBe(404);
  });

  test("the admin calls each read-only admin MCP tool and it answers; the write ones stay listed only", async () => {
    const reads = TOOLS.filter((t) => t.adminOnly === true && !t.writes);
    expect(reads.length).toBeGreaterThan(3);
    const wrong: string[] = [];
    for (const t of reads) {
      const called = await mcp(alice, "tools/call", { name: t.name, arguments: {} });
      if (called.error !== undefined || called.result?.isError === true)
        wrong.push(`${t.name}: ${JSON.stringify(called).slice(0, 200)}`);
    }
    expect(wrong).toEqual([]);
  });

  test("an everyday account's agent calling an admin MCP tool is refused before anything is held or asked", async () => {
    const via = "conversation:routemarks";
    const minted = mintViaToken(app.db, carol.id, via, "", new Date(Date.now() + 10 * 60_000).toISOString());
    if (!minted.ok) throw new Error(minted.error);
    // The agent has read fenced text, so a write it was not asked for would be held, were the call let that far.
    readFenced(app.db, via);
    const wrong: string[] = [];
    for (const t of TOOLS.filter((t) => t.adminOnly === true)) {
      const called = await mcp(carol, "tools/call", { name: t.name, arguments: {} }, minted.value.token);
      if (!called.error?.message.endsWith(SIGN_IN_AS_ADMIN)) wrong.push(`${t.name}: ${JSON.stringify(called).slice(0, 200)}`);
    }
    expect(wrong).toEqual([]);
    expect(waitingFor(app.db, carol.id)).toEqual([]);
  });
});
