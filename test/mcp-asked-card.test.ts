/** MCP `asked` draws the `ui://forge/asked` card: flagged first, a state per ask, linked to the closing pull or the issue. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { cardFor } from "../src/web/studio/cards.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DAY = 24 * 60 * 60 * 1000;

describe("MCP asked card", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let token = "";
  const numbers: Record<string, number> = {};

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-asked-card-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error("users");
    token = createToken(app.db, a.value.id, "ro", "ro").token;
    const made = await createRepo(app, a.value, { name: "game", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    // The older ask is stale with nothing built, so it is flagged and oldest-first leads with it.
    for (const [title, days] of [["stale and unbuilt", 9], ["fresh", 1]] as const) {
      const i = createIssue(app.db, { repoId: made.value.id, authorId: a.value.id, title });
      if (!i.ok) throw new Error(i.error);
      app.db.query("UPDATE issue SET created_at = ?1 WHERE id = ?2")
        .run(new Date(Date.now() - days * DAY).toISOString(), i.value.id);
      numbers[title] = i.value.number;
    }
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("tools/call asked carries the card, flagged first, beside an unchanged text answer", async () => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "asked", arguments: {} } }),
    });
    const body: any = await res.json();
    const text = JSON.parse(body.result.content[0].text);
    expect(text.asked.map((x: any) => x.title)).toEqual(["stale and unbuilt", "fresh"]);
    expect(text.asked[0].flagged).toBe(true);
    const card = body.result.structuredContent.card;
    expect(card.kind).toBe("asked");
    expect(card.status).toBe("2 waiting · 1 flagged");
    // Put "fresh" first in the answer's order: the card still leads with the flagged ask.
    const flipped = cardFor("asked", { asked: [...text.asked].reverse() }, servers.url)!;
    expect(flipped.rows.map((r) => r.label)).toEqual(["stale and unbuilt", "fresh"]);
    expect(card.rows).toEqual([
      { label: "stale and unbuilt", value: "waiting", link: `${servers.url}/alice/game/issues/${numbers["stale and unbuilt"]}` },
      { label: "fresh", value: "waiting", link: `${servers.url}/alice/game/issues/${numbers["fresh"]}` },
    ]);
  });

  test("the closing pull, the 80-character cut, the 20-row ceiling, links only on this forge", () => {
    const ask = (over: Record<string, unknown>) => ({ repo: "alice/game", number: 1, title: "t", state: "waiting", flagged: false, pulls: [], ...over });
    const card = cardFor("asked", { asked: [
      ask({ number: 1, title: "x".repeat(200), state: "shipped", pulls: [{ number: 7, state: "closed" }, { number: 9, state: "merged" }] }),
      ask({ number: 2, state: "building", pulls: [{ number: 8, state: "open" }] }),
      ask({ number: 3, state: "closed" }),
    ] }, "https://forge.test")!;
    expect(card.status).toBe("0 waiting · 0 flagged");
    expect(card.rows[0]!.label.length).toBe(80);
    expect(card.rows.map((r) => r.link)).toEqual([
      "https://forge.test/alice/game/pulls/9",
      "https://forge.test/alice/game/pulls/8",
      "https://forge.test/alice/game/issues/3",
    ]);
    const many = Array.from({ length: 30 }, (_, i) => ask({ number: i + 1 }));
    expect(cardFor("asked", { asked: many }, "https://forge.test")!.rows.length).toBe(20);
    expect(cardFor("asked", { asked: many }, "")!.rows[0]!.link).toBeUndefined();
    expect(cardFor("asked", { asked: [ask({ repo: "/evil.example/x" })] }, "https://forge.test")!.rows[0]!.link).toBeUndefined();
  });
});
