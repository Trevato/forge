/** MCP `apps` answers `previews` and `crew`, and its card draws each app in one line. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { createRun } from "../src/core/runs.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { cardFor } from "../src/web/studio/cards.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { tokenFor } from "./helpers/tokens.ts";

describe("MCP apps previews, crew and card", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let token: string;

  const call = async (args: unknown): Promise<any> => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "apps", arguments: args } }),
    });
    return (await res.json()) as any;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-apps-card-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const runtime = new AppsRuntime(app, { domain: "apps.test", scheme: "http", publicPort: servers.port, forgeUrl: servers.url, concurrency: 1 });
    await seedAdmin(app, { username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
    const alice = getUserByName(app.db, "alice")!;
    const bot = await createUser(app.db, { origin: "seed", trusted: true, username: "smith", email: "smith@forge.local", password: "a-good-passphrase" });
    if (!bot.ok) throw new Error(bot.error);
    for (const name of ["game", "quiet"]) {
      const made = await newApp(app, alice, { name, visibility: "public" } as never);
      if (!made.ok) throw new Error(String(made.error));
    }
    const game = getRepo(app.db, "alice", "game")!;
    const quiet = getRepo(app.db, "alice", "quiet")!;
    createRun(app.db, { repoId: game.id, kind: "agent", actorId: bot.value.id, reason: "work" });
    // The runtime's own view of environments, fixed: a running preview of `game`, a stopped one of `quiet`.
    runtime.status = (record) =>
      record.repoId === game.id
        ? [{ env: "pull-7", state: "running", commitOid: "a", url: "http://game--7.apps.test" }]
        : record.repoId === quiet.id
          ? [{ env: "pull-3", state: "stopped", commitOid: "b", url: "http://quiet--3.apps.test" }]
          : [];
    token = tokenFor(app, "alice", "rw");
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the tool answers a running preview and the agent with a run going, each on its own app only", async () => {
    const items: any[] = JSON.parse((await call({})).result.content[0].text);
    const by = (n: string) => items.find((a) => a.app === `alice/${n}`);
    expect(by("game").previews).toEqual([{ pull: 7, url: "http://game--7.apps.test" }]);
    expect(by("game").crew).toEqual(["smith"]);
    expect(by("game").working).toBe(1);
    expect(by("quiet").previews).toEqual([]);
    expect(by("quiet").crew).toEqual([]);
  });

  test("the card keeps one line per app, with previews and crew in it; hostile preview urls are left out", () => {
    const card = cardFor("apps", [
      { app: "alice/game", live: "running", working: 1, crew: ["smith", "juniper"],
        previews: [{ pull: 7, url: "https://game--7.example" }, { pull: 8, url: "javascript:alert(1)" }] },
      { app: "alice/quiet", live: "stopped", crew: [], previews: [] },
    ], "https://forge.example")!;
    expect(card.rows).toEqual([
      { label: "alice/game", value: "running · 1 working · smith, juniper · pull #7 https://game--7.example", link: "https://forge.example/alice/game" },
      { label: "alice/quiet", value: "stopped", link: "https://forge.example/alice/quiet" },
    ]);
  });
});
