/**
 * An outsider's report reads back the same sentence from every door, because
 * every door reads it from src/actions/report_words.ts. A door that retypes
 * the words fails here even while they still match.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPORT_RECEIVED } from "../src/actions/report_words.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("the words a report reads back", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let source = 0;
  const from = () => ({ "x-forwarded-for": `198.51.100.${++source}` });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-report-words-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const alice = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!alice.ok) throw new Error(alice.error);
    const made = await createRepo(app, alice.value, {
      name: "game",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("POST …/reports answers the module's sentence", async () => {
    const res = await fetch(`${base}/api/v1/repos/alice/game/reports`, {
      method: "POST",
      headers: { "content-type": "application/json", ...from() },
      body: JSON.stringify({ title: "Stuck on loading", body: "b" }),
    });
    expect(res.status).toBe(202);
    expect(((await res.json()) as { message: string }).message).toBe(
      REPORT_RECEIVED,
    );
  });

  test("the MCP `report` tool answers the module's sentence", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", ...from() },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "report",
          arguments: { repo: "alice/game", title: "Stuck on loading" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const answer = (await res.json()) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    expect(answer.result.isError).toBeUndefined();
    expect(JSON.parse(answer.result.content[0]!.text).message).toBe(
      REPORT_RECEIVED,
    );
  });

  test("no file under src/ but the module types the sentence out", async () => {
    const root = join(import.meta.dir, "..", "src");
    const typed: string[] = [];
    for (const entry of await readdir(root, { recursive: true })) {
      if (!entry.endsWith(".ts")) continue;
      const text = await readFile(join(root, entry), "utf8");
      if (text.includes(REPORT_RECEIVED)) typed.push(entry);
    }
    expect(typed).toEqual([join("actions", "report_words.ts")]);
    for (const door of ["http/api.ts", "http/mcp.ts"]) {
      const text = await readFile(join(root, door), "utf8");
      expect(text).toContain('from "../actions/report_words.ts"');
    }
  });
});
