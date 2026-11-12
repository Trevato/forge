/**
 * The forge family's refusals (#5562): the API and MCP answer the sentence
 * src/actions/family_words.ts holds, and no other file under src/ types it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAMILY_WORDS } from "../src/actions/family_words.ts";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { mcpTool } from "./helpers/mcp.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let token = "";

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const api = (method: string, path: string, body?: unknown) =>
  fetch(`${servers.url}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      origin: servers.url,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-family-words-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const ada = ok(
    await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "ada",
      email: "ada@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    }),
  );
  ok(await createRepo(app.db, app.reposRoot, { ownerId: ada.id, name: "lib", visibility: "public" }));
  token = createToken(app.db, ada.id, "t", "admin").token;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("severing a repository that follows nothing answers the module's sentence at both doors", async () => {
  const res = await api("POST", "/repos/ada/lib/following/sever");
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ error: "not_following", message: FAMILY_WORDS.not_following });
  const mcp = await mcpTool(servers.url, token, "sever", { repo: "ada/lib" });
  expect(mcp.error).toBe(`not_following: ${FAMILY_WORDS.not_following}`);
});

test("showing a trail on a repository never migrated answers the module's sentence at both doors", async () => {
  const res = await api("PATCH", "/repos/ada/lib", { showProvenance: true });
  expect(res.status).toBe(422);
  expect(await res.json()).toMatchObject({ error: "no_provenance", message: FAMILY_WORDS.no_provenance });
  const mcp = await mcpTool(servers.url, token, "trail", { repo: "ada/lib", shown: true, dryRun: false });
  expect(mcp.error).toBe(`no_provenance: ${FAMILY_WORDS.no_provenance}`);
});

test("no file under src/ but the module types a family sentence", async () => {
  const root = join(import.meta.dir, "..", "src");
  const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith(".ts"));
  for (const sentence of Object.values(FAMILY_WORDS)) {
    const typed: string[] = [];
    for (const f of files) if ((await readFile(join(root, f), "utf8")).includes(sentence)) typed.push(f);
    expect(typed).toEqual([join("actions", "family_words.ts")]);
  }
});
