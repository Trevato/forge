/** MCP `egress_grants` (list): an admin-scope token only, the same answer as GET …/egress-grants; a repository the caller cannot read is not found. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { grantAppEgress } from "../src/actions/egress_grants.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const ARM = "100.89.95.68:8101";
const CAMERA = "100.89.95.68:8102";

let dataDir: string;
let app: App;
let servers: Servers;
const tok: Record<string, string> = {};

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

async function call(token: string, args: unknown): Promise<{ error?: string; value?: any }> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "egress_grants", arguments: args },
    }),
  });
  const body = (await res.json()) as any;
  const text: string = body.result.content[0].text;
  return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-egress-grants-mcp-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
  const make = (username: string, adminIfFirst = false) =>
    createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst,
    });
  const ada = ok(await make("ada", true));
  const rita = ok(await make("rita"));
  const repo = ok(await createRepo(app, ada, { name: "arm", visibility: "private", description: "" }));
  ok(
    await commitToBranch(app, ada, repo, {
      message: "Ask for the arm",
      files: [
        {
          path: "forge.json",
          content: JSON.stringify({ app: { run: "bun run src/server.ts" }, egress: [ARM, CAMERA, "api.example.com"] }),
        },
      ],
    }),
  );
  ok(insertApp(app.db, { repoId: repo.id, slug: "arm", access: "public" }));
  ok(await grantAppEgress(app, ada, repo, ARM));
  tok["admin"] = createToken(app.db, ada.id, "a", "admin").token;
  tok["rw"] = createToken(app.db, ada.id, "w", "rw").token;
  tok["ro"] = createToken(app.db, ada.id, "r", "ro").token;
  tok["stranger"] = createToken(app.db, rita.id, "s", "admin").token;
}, 60_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test("an admin-scope token lists both destinations, one granted, as the API does", async () => {
  const mcp = (await call(tok["admin"]!, { repo: "ada/arm" })).value;
  expect(mcp.items.map((i: any) => [i.destination, i.granted])).toEqual([
    [ARM, true],
    [CAMERA, false],
  ]);
  const res = await fetch(`${servers.url}/api/v1/repos/ada/arm/egress-grants`, {
    headers: { authorization: `Bearer ${tok["admin"]}` },
  });
  expect(res.status).toBe(200);
  const api = (await res.json()) as any;
  expect(mcp.items).toEqual(api.items);
  expect(mcp.changes).toEqual(api.changes);
});

test("a read-only or read-write token is forbidden", async () => {
  for (const scope of ["ro", "rw"]) {
    const r = await call(tok[scope]!, { repo: "ada/arm" });
    expect(r.error).toContain("egress grants need an admin-scope token");
  }
});

test("a repository the caller cannot read is not found", async () => {
  expect((await call(tok["stranger"]!, { repo: "ada/arm" })).error).toContain("not_found");
  expect((await call(tok["admin"]!, { repo: "ada/missing" })).error).toContain("not_found");
});
