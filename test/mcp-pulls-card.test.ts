/**
 * MCP `pulls` draws the `ui://forge/pulls` card: `N open`, one row per pull
 * with its check word, each label linked to its pull page on this forge.
 * The text answer is unchanged and a title with markup arrives as text.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { cardFor } from "../src/web/studio/cards.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const EVIL = `<img src=x onerror=alert(1)>`;

describe("MCP pulls card", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let token = "";
  let id = 1;
  const numbers: number[] = [];

  const rpc = async (method: string, params: unknown = {}) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
    });
    return (await res.json()) as any;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-pulls-card-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error("users");
    token = createToken(app.db, a.value.id, "ro", "ro").token;
    const made = await createRepo(app, a.value, { name: "game", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    const seeded = await commitToBranch(app, a.value, made.value, {
      branch: "main", message: "seed", files: [{ path: "README.md", content: "# game\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    for (const [branch, title] of [["one", "First"], ["two", EVIL]] as const) {
      const c = await commitToBranch(app, a.value, made.value, {
        branch, message: branch, files: [{ path: `${branch}.txt`, content: "x\n" }],
      });
      if (!c.ok) throw new Error(JSON.stringify(c.error));
      const p = await openPull(app, a.value, made.value, { title, baseBranch: "main", headBranch: branch });
      if (!p.ok) throw new Error(String(p.error));
      numbers.push(p.value.number);
    }
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("resources/list offers ui://forge/pulls", async () => {
    const uris = (await rpc("resources/list")).result.resources.map((r: any) => r.uri);
    expect(uris).toContain("ui://forge/pulls");
  });

  test("tools/call pulls carries the card beside an unchanged text answer", async () => {
    const body = await rpc("tools/call", { name: "pulls", arguments: { repo: "alice/game" } });
    const card = body.result.structuredContent.card;
    expect(card.kind).toBe("pulls");
    expect(card.title).toBe("Pulls");
    expect(card.status).toBe("2 open");
    const [two, one] = [numbers[1]!, numbers[0]!];
    expect(card.rows).toEqual([
      { label: `#${two} ${EVIL}`, value: "none", link: `${servers.url}/alice/game/pulls/${two}` },
      { label: `#${one} First`, value: "none", link: `${servers.url}/alice/game/pulls/${one}` },
    ]);
    const text = JSON.parse(body.result.content[0].text);
    expect(text.pulls.map((p: any) => p.number)).toEqual([two, one]);
    expect("card" in text).toBe(false);

    const closed = await rpc("tools/call", { name: "pulls", arguments: { repo: "alice/game", state: "closed" } });
    expect(closed.result.structuredContent.card.status).toBe("0 closed");
    expect(closed.result.structuredContent.card.rows).toEqual([]);

    // More open than `limit`: the status says the list was cut, not "1 open".
    const cut = await rpc("tools/call", { name: "pulls", arguments: { repo: "alice/game", limit: 1 } });
    expect(cut.result.structuredContent.card.status).toBe("1+ open");
    expect(cut.result.structuredContent.card.rows.length).toBe(1);
  });

  test("the check word, the cut-off status, the 20-row ceiling, and links only on this forge", () => {
    const pulls = ["ok", "failed", "running", "queued", "none", "cancelled"].map((check, i) => ({
      number: i + 1, title: `P${i + 1}`, check,
    }));
    const card = cardFor("pulls", { pulls }, "https://forge.test", { repo: "alice/game", state: "open" })!;
    expect(card.rows.map((r) => r.value)).toEqual(["green", "red", "running", "running", "none", "cancelled"]);
    expect(card.rows[0]!.link).toBe("https://forge.test/alice/game/pulls/1");

    const many = Array.from({ length: 30 }, (_, i) => ({ number: i + 1, title: "t", check: "ok" }));
    const big = cardFor("pulls", { pulls: many }, "https://forge.test", { repo: "alice/game" })!;
    expect(big.status).toBe("30 open");
    const capped = cardFor("pulls", { pulls: many.slice(0, 20) }, "https://forge.test", { repo: "alice/game", limit: 20 })!;
    expect(capped.status).toBe("20+ open");
    expect(big.rows.length).toBe(20);

    // No origin, a repo that is not `owner/name`, or a number that is not one: no link.
    expect(cardFor("pulls", { pulls }, "", { repo: "alice/game" })!.rows[0]!.link).toBeUndefined();
    expect(cardFor("pulls", { pulls }, "https://forge.test", { repo: "/evil.example/x" })!.rows[0]!.link).toBeUndefined();
    const odd = cardFor("pulls", { pulls: [{ number: "//evil", title: "x", check: "ok" }] }, "https://forge.test", { repo: "alice/game" })!;
    expect(odd.rows[0]!.link).toBeUndefined();
  });
});
