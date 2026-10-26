/** MCP `vision`: docs/VISION.md parsed; none is no error; the direction only for who may read settings. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { createRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
const tok: Record<string, string> = {};

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

async function vision(token: string, repo: string): Promise<any> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vision", arguments: { repo } } }),
  });
  const body = (await res.json()) as any;
  return JSON.parse(body.result.content[0].text);
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-vision-mcp-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const make = (username: string) =>
    createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase" });
  const owner = ok(await make("ada"));
  const reader = ok(await make("rita"));
  const text = await readFile(join(import.meta.dir, "..", "docs", "VISION.md"), "utf8");
  const withDoc = ok(await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "with", visibility: "public" }));
  ok(await commitToBranch(app, owner, withDoc, { message: "vision", files: [{ path: "docs/VISION.md", content: text }] }));
  const without = ok(await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "without", visibility: "public" }));
  ok(await commitToBranch(app, owner, without, { message: "seed", files: [{ path: "a.txt", content: "a\n" }] }));
  app.db.query("UPDATE repo SET autonomy_direction = 'ship the feed' WHERE id = ?1").run(withDoc.id);
  tok["owner"] = createToken(app.db, owner.id, "rw", "rw").token;
  tok["reader"] = createToken(app.db, reader.id, "rw", "rw").token;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("this repository's VISION.md is parsed", async () => {
  const v = await vision(tok["owner"]!, "ada/with");
  expect(v.purpose).toStartWith("The forge is a social place");
  expect(v.order.map((o: any) => o.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(v.order[0].name).toBe("Trust, always first");
  expect(v.order[0].text).toStartWith("Agents are contained.");
  expect(v.order[1].name).toBe("One front door: the feed");
  expect(v.rules.length).toBe(4);
  expect(v.rules[2]).toStartWith("Done means reachable");
  expect(v.direction).toBe("ship the feed");
  expect(v.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
});

test("a repository without the document answers empty, not an error", async () => {
  const v = await vision(tok["owner"]!, "ada/without");
  expect(v).toMatchObject({ purpose: null, order: [], rules: [], updatedAt: null });
});

test("a reader who may not see settings gets no direction", async () => {
  const v = await vision(tok["reader"]!, "ada/with");
  expect(v.direction).toBeNull();
  expect(v.order.length).toBe(8);
});
