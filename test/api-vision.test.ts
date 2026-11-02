/** `GET /api/v1/repos/:owner/:name/vision` answers what MCP `vision` answers, for the same reader. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { openPull } from "../src/actions/pulls.ts";
import { savePlacement } from "../src/core/placements.ts";
import { nextDirection } from "../src/crew/vision.ts";
import { createRepo, getRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
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

const rest = (token: string | null, path: string) =>
  fetch(`${servers.url}/api/v1/repos/ada/${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

async function mcp(token: string, repo: string): Promise<any> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vision", arguments: { repo } } }),
  });
  return JSON.parse(((await res.json()) as any).result.content[0].text);
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-vision-api-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const make = (username: string) =>
    createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase" });
  const owner = ok(await make("ada"));
  const reader = ok(await make("rita"));
  const text = await readFile(join(import.meta.dir, "..", "docs", "VISION.md"), "utf8");
  const pub = ok(await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "with", visibility: "public" }));
  ok(await commitToBranch(app, owner, pub, { message: "vision", files: [{ path: "docs/VISION.md", content: text }] }));
  ok(await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "secret", visibility: "private" }));
  app.db.query("UPDATE repo SET autonomy_direction = 'ship the feed, quietly' WHERE id = ?1").run(pub.id);
  tok["owner"] = createToken(app.db, owner.id, "rw", "rw").token;
  tok["reader"] = createToken(app.db, reader.id, "rw", "rw").token;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("an admin gets the same JSON over REST as over MCP", async () => {
  const res = await rest(tok["owner"]!, "with/vision");
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  expect(body).toEqual(await mcp(tok["owner"]!, "ada/with"));
  expect(body.direction).toBe("ship the feed, quietly");
  expect(body.directionParts).toEqual([{ kind: "owner", text: "ship the feed, quietly" }]);
  expect(body.order.length).toBe(8);
});

test("a reader gets the same JSON, the gated fields null, the direction text nowhere", async () => {
  const res = await rest(tok["reader"]!, "with/vision");
  const text = await res.text();
  expect(JSON.parse(text)).toEqual(await mcp(tok["reader"]!, "ada/with"));
  const body = JSON.parse(text);
  expect(body).toMatchObject({ direction: null, directionStall: null, directionParts: null, preview: null });
  expect(body.purpose).toStartWith("The forge is a social place");
  expect(text).not.toContain("quietly");
  expect(((await (await rest(null, "with/vision")).json()) as any).direction).toBeNull();
});

test("a repository the reader cannot see is a 404", async () => {
  expect((await rest(tok["reader"]!, "secret/vision")).status).toBe(404);
  expect((await rest(null, "secret/vision")).status).toBe(404);
  expect((await rest(tok["owner"]!, "nope/vision")).status).toBe(404);
});

test("a bad number is a 422; a number with no vision pull previews nothing", async () => {
  for (const bad of ["0", "-1", "x", "1.5", ""]) expect((await rest(tok["owner"]!, `with/vision?number=${bad}`)).status).toBe(422);
  const res = await rest(tok["owner"]!, "with/vision?number=99");
  expect(res.status).toBe(200);
  expect(((await res.json()) as any).preview).toBeNull();
});

test("number: an admin previews an open vision pull over REST as over MCP; a reader gets none", async () => {
  const owner = getUserByName(app.db, "ada")!;
  const repo = getRepo(app.db, "ada", "with")!;
  const md = (await readFile(join(import.meta.dir, "..", "docs", "VISION.md"), "utf8")).replace("Done means reachable", "Done means shown");
  ok(await commitToBranch(app, owner, repo, { branch: "vision-r", message: "v", files: [{ path: "docs/VISION.md", content: md }] }));
  const pull = ok(await openPull(app, owner, repo, { title: "Note", body: "", baseBranch: "main", headBranch: "vision-r" }));
  const path = `with/vision?number=${pull.number}`;
  expect(((await (await rest(tok["owner"]!, path)).json()) as any).preview).toBeNull();
  savePlacement(app.db, {
    thoughtId: "thapi", kind: "vision", reply: "", asked: false, decidedBy: "t", placedAt: new Date().toISOString(),
    placed: [{ action: "proposed", repo: "ada/with", number: pull.number, pull: pull.number }],
  });
  const expected = nextDirection("ship the feed, quietly", md);
  if (!expected.ok) throw new Error(expected.why);
  const admin = (await (await rest(tok["owner"]!, path)).json()) as any;
  expect(admin.preview).toEqual({ today: "ship the feed, quietly", after: expected.text });
  const other = (await (await rest(tok["reader"]!, path)).json()) as any;
  expect(other.preview).toBeNull();
  expect(other.directionParts).toBeNull();
  expect(((await (await rest(null, path)).json()) as any).preview).toBeNull();
});
