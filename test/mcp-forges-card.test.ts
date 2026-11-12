/** MCP `forges` draws the `ui://forge/forges` card: a row per forge sent, resend first, text kept as plain data. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { CARD_OF_TOOL, SHELL_JS, cardFor } from "../src/web/studio/cards.ts";
import { useChildFetch } from "../src/spawn/clients.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const row = (name: string, url: string, who: string | null, stage: { words: string; resend: boolean } | null) => ({ name, url, for: who, stage });

describe("MCP forges card", () => {
  test("forges maps to a card titled Forges you sent", () => {
    expect(CARD_OF_TOOL["forges"]).toBe("forges");
    expect(cardFor("forges", { forges: [] })?.title).toBe("Forges you sent");
  });

  test("one row per forge, resend first, stage in words, name linked", () => {
    const card = cardFor("forges", {
      forges: [
        row("alpha", "https://alpha.example", "Ann", { words: "Last tell", resend: false }),
        row("beta", "https://beta.example", "Bob", { words: "Not opened in 3 days", resend: true }),
        row("gamma", "https://gamma.example", null, { words: "Signed in", resend: false }),
        row("delta", "https://delta.example", "Dee", null),
      ],
    })!;
    expect(card.status).toBe("4 forges sent");
    expect(card.rows.map((r) => r.label)).toEqual(["beta", "alpha", "gamma", "delta"]);
    expect(card.rows[0]).toEqual({ label: "beta", value: "for Bob · resend", link: "https://beta.example" });
    expect(card.rows[1]!.value).toBe("for Ann · last tell");
    expect(card.rows[2]!.value).toBe("no one named · signed in");
    expect(card.rows[3]!.value).toBe("for Dee · being made");
    expect(cardFor("forges", { forges: [row("a", "https://a.example", "x", null)] })!.status).toBe("1 forge sent");
  });

  test("text stays plain data and only http(s) addresses link", () => {
    const card = cardFor("forges", { forges: [row("<img src=x onerror=1>", "javascript:alert(1)", "<b>me</b>", { words: "Sent", resend: false })] })!;
    expect(card.rows[0]!.label).toBe("<img src=x onerror=1>");
    expect(card.rows[0]!.link).toBeUndefined();
    expect(SHELL_JS).not.toContain("innerHTML");
  });

  test("a plan or code answer has no card", () => {
    expect(cardFor("forges", { plan: "small" })).toBeUndefined();
  });

  describe("over MCP", () => {
    let dataDir = "";
    let app: App;
    let servers: Servers;
    let adminToken = "";
    let bobToken = "";
    const call = async (as: string) => {
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${as}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "forges", arguments: {} } }),
      });
      return ((await res.json()) as any).result;
    };
    beforeAll(async () => {
      dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-forges-card-"));
      app = createApp({ dataDir, port: 0 });
      const DAY = 86_400_000;
      mkdirSync(join(dataDir, "spawn"), { recursive: true });
      const send = (name: string, who: string, daysAgo: number) =>
        writeFileSync(join(dataDir, "spawn", `${name}.json`), JSON.stringify({ name, bodyId: `cell-${name}`, done: true, placement: "hosted", size: "small", apps: [], forWhom: who, createdAt: new Date(Date.now() - daysAgo * DAY).toISOString() }));
      send("alpha", "Ann", 1);
      send("beta", "Bob", 4);
      useChildFetch(app, async () => Response.json({ claimed: false, link: { state: "open", revokedAt: null, usedAt: null } }));
      servers = await serve(app);
      const make = async (n: string) => {
        const r = await createUser(app.db, { origin: "seed", trusted: true, username: n, email: `${n}@f.dev`, password: "a-good-passphrase", adminIfFirst: n === "alice" });
        if (!r.ok) throw new Error("user");
        return r.value;
      };
      const alice = await make("alice");
      const bob = await make("bob");
      adminToken = createToken(app.db, alice.id, "admin", "admin").token;
      bobToken = createToken(app.db, bob.id, "bob", "ro").token;
    }, 60_000);
    afterAll(async () => {
      servers.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    });

    test("an admin's listing carries the card with the real forges, resend first; a non-admin is forbidden with none", async () => {
      const ok = await call(adminToken);
      expect(ok.structuredContent.card.kind).toBe("forges");
      expect(ok.structuredContent.card.status).toBe("2 forges sent");
      const rows = ok.structuredContent.card.rows;
      expect(rows.map((r: any) => r.label)).toEqual(["beta", "alpha"]);
      expect(rows[0].value).toBe("for Bob · resend");
      expect(rows[1].value).toBe("for Ann · sent");
      const no = await call(bobToken);
      expect(no.isError).toBe(true);
      expect(no.structuredContent?.card).toBeUndefined();
      expect(JSON.stringify(no)).toContain("forbidden");
    });
  });
});
