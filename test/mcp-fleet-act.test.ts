/** `flow` with `q` and `action` (#450): the fleet operation the API runs, a plan unless `apply: true`, applying with an admin token only. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dir: string;
let app: App;
let servers: Servers;
let repos: Repo[] = [];
const tok: Record<string, string> = {};
let id = 1;

const call = async (token: string, args: unknown) => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "flow", arguments: args } }),
  });
  const body: any = await res.json();
  const text: string = body.result.content[0].text;
  return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
};

const api = async (token: string, input: unknown) =>
  (await fetch(`${servers.url}/api/v1/fleet/ops`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
  }).then((r) => r.json())) as any;

const ceilings = () => repos.map((r) => getRepoById(app.db, r.id)!.autonomyCeilingUsd);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-mcp-fleet-act-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first = false) => {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
    if (!u.ok) throw new Error(u.error);
    return u.value;
  };
  const alice = await mk("alice", true);
  const carol = await mk("carol");
  for (const name of ["one", "two"]) {
    const r = await createRepo(app, alice, { name, visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    repos.push(r.value);
  }
  for (const scope of ["ro", "rw", "admin"] as const) tok[scope] = createToken(app.db, alice.id, scope, scope).token;
  tok["carol"] = createToken(app.db, carol.id, "admin", "admin").token;
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const query = "repo owner:alice";
const action = { verb: "ceiling", value: 7.5 };

test("an action plans by default, even with a read token, and the plan is the API's", async () => {
  const before = ceilings();
  for (const args of [{ q: query, action }, { q: query, action, apply: false }]) {
    const plan = await call(tok["ro"]!, args);
    expect(plan.error).toBeUndefined();
    expect(plan.value).toEqual(await api(tok["ro"]!, { query, action }));
    expect(plan.value.dryRun).toBe(true);
    expect(plan.value.rows.map((r: any) => r.outcome)).toEqual(["change", "change"]);
  }
  expect(ceilings()).toEqual(before);
});

test("applying needs `apply: true` and an admin token; then it writes and returns a receipt `limb` undoes", async () => {
  const before = ceilings();
  for (const scope of ["ro", "rw"]) {
    expect((await call(tok[scope]!, { q: query, action, apply: true })).error).toContain("forbidden");
    expect(ceilings()).toEqual(before);
  }
  const done = await call(tok["admin"]!, { q: query, action, apply: true });
  expect(done.value.dryRun).toBe(false);
  expect(typeof done.value.id).toBe("string");
  expect(done.value.rows.map((r: any) => r.outcome)).toEqual(["ok", "ok"]);
  expect(ceilings()).toEqual([7.5, 7.5]);

  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok["admin"]}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "limb", arguments: { app: "alice/one", action: "undo", operation: done.value.id, dryRun: false } } }),
  });
  expect(((await res.json()) as any).result.isError).not.toBe(true);
  expect(ceilings()).toEqual(before);
});

test("someone who administers none of the rows is refused each row; bad input answers its reason", async () => {
  const before = ceilings();
  const tried = await call(tok["carol"]!, { q: query, action, apply: true });
  expect(tried.value.rows.every((r: any) => r.outcome === "refused")).toBe(true);
  expect(ceilings()).toEqual(before);
  expect((await call(tok["admin"]!, { q: query, action: { verb: "nope" } })).error).toContain("bad_action");
  expect((await call(tok["admin"]!, { q: query, action, apply: "yes" })).error).toContain("apply is true or false");
  expect((await call(tok["admin"]!, { action })).error).toContain("needs q");
  expect((await call(tok["admin"]!, { q: query, apply: true })).error).toContain("needs an action");
  expect(ceilings()).toEqual(before);
});
