/** MCP `waves`: list order, one wave and its card, an unknown version refused, a private repository hidden. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { createRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { writeWave } from "../src/story/wave.ts";
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

async function mcp(token: string, args: unknown): Promise<{ error?: string; value?: any; card?: any }> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "waves", arguments: args } }),
  });
  const body = (await res.json()) as any;
  const text: string = body.result.content[0].text;
  return body.result.isError === true
    ? { error: text }
    : { value: JSON.parse(text), card: body.result.structuredContent?.card };
}

const wave = (version: string, date: string) => ({
  version,
  date,
  headline: `Headline ${version}`,
  highlights: [1, 2, 3].map((i) => ({ title: `Thing ${i}`, why: `Because ${i}` })),
  pulls: [{ title: "#99 follow-up", url: "https://forge.example/ada/svc/pulls/12" }],
});

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-waves-mcp-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const make = (username: string) =>
    createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase" });
  const owner = ok(await make("ada"));
  const stranger = ok(await make("rita"));
  for (const [name, visibility] of [["svc", "public"], ["secret", "private"]] as const) {
    const repo = ok(await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name, visibility }));
    const files = [["0.9.0", "2026-10-01"], ["0.10.0", "2026-10-10"], ["0.9.1", "2026-10-05"]].map(([v, d]) => ({
      path: `waves/${v}.md`,
      content: ok(writeWave(wave(v!, d!)) as { ok: true; value: string }),
    }));
    if (name === "svc") files.push({ path: "waves/broken.md", content: "nope" });
    ok(await commitToBranch(app, owner, repo, { message: "waves", files }));
  }
  tok["owner"] = createToken(app.db, owner.id, "ro", "ro").token;
  tok["stranger"] = createToken(app.db, stranger.id, "ro", "ro").token;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("lists waves newest first by version, not by name", async () => {
  const r = await mcp(tok["stranger"]!, { repo: "ada/svc" });
  expect(r.value.waves.map((w: any) => w.version)).toEqual(["0.10.0", "0.9.1", "0.9.0", "broken"]);
  expect(r.value.waves[0]).toEqual({ version: "0.10.0", date: "2026-10-10", headline: "Headline 0.10.0" });
  expect(r.card).toBeUndefined();
});

test("a wave file that does not parse is listed last with its reason", async () => {
  const r = await mcp(tok["owner"]!, { repo: "ada/svc" });
  const last = r.value.waves[3];
  expect(Object.keys(last).sort()).toEqual(["error", "version"]);
  expect(last.version).toBe("broken");
  expect(last.error).toContain("waves/broken.md");
});

test("one wave carries headline, highlights, pull numbers and the wave card", async () => {
  const r = await mcp(tok["owner"]!, { repo: "ada/svc", version: "0.9.1" });
  expect(r.value.wave.headline).toBe("Headline 0.9.1");
  expect(r.value.wave.highlights[0]).toEqual({ title: "Thing 1", why: "Because 1" });
  expect(r.value.wave.pulls).toEqual([12]);
  expect(r.card.kind).toBe("wave");
  expect(r.card.title).toBe("Wave 0.9.1");
});

test("an unknown or malformed version is refused", async () => {
  expect((await mcp(tok["owner"]!, { repo: "ada/svc", version: "9.9.9" })).error).toContain("not_found");
  expect((await mcp(tok["owner"]!, { repo: "ada/svc", version: "../x" })).error).toContain("invalid");
  expect((await mcp(tok["owner"]!, { repo: "ada/svc", version: 3 })).error).toContain("invalid");
});

test("a private repository is not found to someone who cannot read it", async () => {
  expect((await mcp(tok["owner"]!, { repo: "ada/secret" })).value.waves.length).toBe(3);
  const r = await mcp(tok["stranger"]!, { repo: "ada/secret" });
  expect(r.error).toContain("not_found");
  expect((await mcp(tok["stranger"]!, { repo: "ada/secret", version: "0.9.0" })).error).toContain("not_found");
});
