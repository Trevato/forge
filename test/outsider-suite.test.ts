/**
 * The outsider suite (#663) against a running forge: a fresh account signs
 * up over HTTP and every forbidden thing is refused. The suite itself is
 * proven here — green on this forge, red when a door is left open.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import type { Repo } from "../src/core/repos.ts";
import { grantLeft } from "../src/core/model_grant.ts";
import { listRuns } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { getUserByName } from "../src/core/users.ts";
import { setLimit } from "../src/settings/limits.ts";
import { setSignup } from "../src/settings/signup.ts";
import { outsider } from "../src/release/outsider.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("outsider suite", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let ownerToken = "";
  let vault: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-outsider-suite-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const seeded = await seedAdmin(app, { username: "rowan", email: "rowan@example.com", password: "a-long-owner-passphrase" });
    if (!seeded.ok) throw new Error(String(seeded.error));
    const owner = seeded.value;
    // Each case signs one account up from this one source.
    setLimit(app.db, "signup.per_source", 50, owner.id);
    ownerToken = createToken(app.db, owner.id, "t", "rw").token;
    const agent = await createAgent(app, owner, { username: "helper" });
    if (!agent.ok) throw new Error(String(agent.error));
    for (const [name, visibility] of [["vault", "private"], ["lawn", "public"]] as const) {
      const made = await createRepo(app, owner, { name, visibility });
      if (!made.ok) throw new Error(String(made.error));
      if (name === "vault") vault = made.value;
      const opened = openIssue(app, owner, made.value, { title: "weed", body: "" });
      if (!opened.ok) throw new Error(String(opened.error));
      const crewed = addToCrew(app, owner, made.value, "helper");
      if (!crewed.ok) throw new Error(String(crewed.error));
    }
  });

  afterAll(async () => {
    await servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a fresh account is refused every forbidden thing, and spends nothing", async () => {
    expect(await outsider(servers.url, { ownerToken, username: "stranger" })).toEqual([]);
    const stranger = getUserByName(app.db, "stranger")!;
    expect(stranger.isAdmin).toBe(false);
    expect(grantLeft(app.db, stranger.id, new Date())).toBeUndefined();
    expect(listRuns(app.db, vault.id, { kind: "agent", limit: 10 }).length).toBe(0);
  });

  test("it reports a door left open", async () => {
    const open = (async (input: Request | string | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/api/v1/repos" && init?.method === "POST")
        return new Response("{}", { status: 201 });
      return fetch(input, init);
    }) as typeof fetch;
    const got = await outsider(servers.url, { ownerToken, fetch: open, username: "stranger2" });
    expect(got.map((r) => r.check)).toEqual(["no repository of its own"]);
  });

  test("it reports a crew assignment the stranger can make, through the API door or the form door", async () => {
    const asOwner = (init?: RequestInit): RequestInit => ({
      ...init,
      headers: { ...(init?.headers as Record<string, string>), cookie: "", authorization: `Bearer ${ownerToken}` },
    });
    for (const [door, method] of [["/api/v1/repos/rowan/lawn/issues/1/assignee", "PUT"], ["/rowan/lawn/issues/1/assignee", "POST"]] as const) {
      const open = (async (input: Request | string | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const body = String(init?.body ?? "");
        return fetch(input, url.pathname === door && init?.method === method && body.includes("helper") ? asOwner(init) : init);
      }) as typeof fetch;
      const got = await outsider(servers.url, { ownerToken, fetch: open, username: `stranger-${method.toLowerCase()}` });
      expect(got.map((r) => r.check)).toContain("no steering of rowan/lawn");
      app.db.query("UPDATE issue SET assignee_id = NULL").run();
    }
  });

  test("it reports an MCP door left open, tell or make_it_yours", async () => {
    for (const tool of ["tell", "make_it_yours"]) {
      const open = (async (input: Request | string | URL, init?: RequestInit) => {
        if (new URL(input instanceof Request ? input.url : String(input)).pathname === "/mcp" && String(init?.body).includes(`"name":"${tool}"`))
          return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "{}" }] } });
        return fetch(input, init);
      }) as typeof fetch;
      const got = await outsider(servers.url, { ownerToken, fetch: open, username: `stranger-mcp-${tool}` });
      expect(got.some((r) => r.check.includes(`MCP ${tool}`))).toBe(true);
    }
  });

  test("a form that answers 200 and does nothing is not a refusal", async () => {
    const quiet = (async (input: Request | string | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.pathname === "/rowan/lawn/issues/1/assignee" && init?.method === "POST" ? new Response("ok", { status: 200 }) : fetch(input, init);
    }) as typeof fetch;
    const got = await outsider(servers.url, { ownerToken, fetch: quiet, username: "stranger-quiet" });
    expect(got.map((r) => r.check)).toEqual(["no steering of rowan/lawn (form)"]);
  });

  test("it is red when a route has moved, not green", async () => {
    const moved = (async (input: Request | string | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.pathname.endsWith("/assignee") && init?.method === "PUT" ? new Response("{}", { status: 404 }) : fetch(input, init);
    }) as typeof fetch;
    const got = await outsider(servers.url, { ownerToken, fetch: moved, username: "stranger5" });
    expect(got.map((r) => r.check)).toContain("assignee route");
  });

  test("it reports a private repository the stranger can read", async () => {
    const leak = (async (input: Request | string | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/api/v1/repos/rowan/vault") return new Response("{}", { status: 200 });
      return fetch(input, init);
    }) as typeof fetch;
    const got = await outsider(servers.url, { ownerToken, fetch: leak, username: "stranger4" });
    expect(got.map((r) => r.check)).toEqual(["no read of private rowan/vault"]);
  });

  test("without an owner token it reports the checks it could not try", async () => {
    const got = await outsider(servers.url, { username: "stranger-notoken" });
    expect(got.map((r) => r.check)).toContain("owner token");
  });

  test("an MCP error that is not a refusal is not counted as one", async () => {
    const said = (text: string) =>
      (async (input: Request | string | URL, init?: RequestInit) => {
        if (new URL(input instanceof Request ? input.url : String(input)).pathname === "/mcp" && String(init?.body).includes('"name":"tell"') && String(init?.body).includes("rowan/lawn"))
          return Response.json({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text }] } });
        return fetch(input, init);
      }) as typeof fetch;
    for (const text of ["unauthorized: x", "not_found: nothing"]) {
      const got = await outsider(servers.url, { ownerToken, fetch: said(text), username: `stranger-err-${text.slice(0, 4)}` });
      expect(got.map((r) => r.check)).toEqual(["no steering of rowan/lawn (MCP tell)"]);
    }
  });

  test("a tool that has vanished is a moved door, not a refusal", async () => {
    const gone = (async (input: Request | string | URL, init?: RequestInit) => {
      if (new URL(input instanceof Request ? input.url : String(input)).pathname === "/mcp" && String(init?.body).includes('"name":"make_it_yours"'))
        return Response.json({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "not_found: no such tool here" }] } });
      return fetch(input, init);
    }) as typeof fetch;
    const got = await outsider(servers.url, { ownerToken, fetch: gone, username: "stranger-gone" });
    expect(got.map((r) => r.check)).toEqual(["no copy of rowan/lawn (MCP make_it_yours)", "no copy of rowan/vault (MCP make_it_yours)"]);
  });

  test("a hiding door that answers not_found still counts as refused", async () => {
    const hides = (async (input: Request | string | URL, init?: RequestInit) => {
      if (new URL(input instanceof Request ? input.url : String(input)).pathname === "/mcp" && String(init?.body).includes('"name":"repo"'))
        return Response.json({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "not_found: no such app or repository (owner/name)" }] } });
      return fetch(input, init);
    }) as typeof fetch;
    expect(await outsider(servers.url, { ownerToken, fetch: hides, username: "stranger-hides" })).toEqual([]);
  });

  test("it says so when no account can be made", async () => {
    setSignup(app.db, "closed", "test");
    const got = await outsider(servers.url, { username: "stranger3" });
    expect(got[0]?.check).toBe("sign up");
  });
});
