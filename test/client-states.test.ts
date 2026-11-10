/**
 * Where each sent forge link stands (#10923): sent, opened, signed in,
 * first tell, in the same words on the page and in the MCP answer, read
 * from what is already kept. A link unopened for three days says so and
 * offers one action, resend.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { forgeLines } from "../src/tui/screens/forges.ts";
import { clientRows, orderRows, STAGE_WORDS, useChildFetch, STALE_WORDS, stageOf, type ClientRow } from "../src/spawn/clients.ts";
import { forgeRow } from "../src/web/pages/forges.ts";
import { tool } from "../src/http/mcp/tools/forges.ts";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const DAY = 86_400_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const base = (over: Partial<Omit<ClientRow, "attention" | "stage">> = {}) =>
  ({
    name: "acme", url: "https://acme.example", for: "Maria", apps: [], sentAt: ago(DAY), made: true, claimed: false,
    lastActivityAt: null, running: null, reach: null, link: { state: "open", revokedAt: null, usedAt: null }, spendTodayUsd: null,
    ceilingUsd: null, size: "small", use: { kind: "shared" }, disk: { own: false }, lastHeartbeatAt: null,
    nextStep: { key: "claim", words: "not claimed yet", lastTellAt: null }, ...over,
  }) as unknown as Omit<ClientRow, "attention" | "stage">;

const stage = (over = {}) => orderRows([base(over)], NOW)[0]!;

describe("client states", () => {
  test("sent, with the time it was sent", () => {
    const s = stage().stage!;
    expect([s.key, s.words, s.at, s.resend]).toEqual(["sent", "Sent", ago(DAY), false]);
  });

  test("opened once the link is spent but no one is signed in", () => {
    const s = stage({ link: { state: "used", revokedAt: null, usedAt: ago(2 * DAY) } }).stage!;
    expect([s.key, s.at]).toEqual(["opened", ago(2 * DAY)]);
  });

  test("signed in when claimed, at the time the link was spent; no time invented without it", () => {
    const s = stage({ claimed: true, link: { state: "used", revokedAt: null, usedAt: ago(DAY / 2) } }).stage!;
    expect([s.key, s.words, s.at]).toEqual(["signedin", "Signed in", ago(DAY / 2)]);
    const bare = stage({ claimed: true, lastActivityAt: ago(60_000), link: { state: "used", revokedAt: null, usedAt: null } }).stage!;
    expect([bare.key, bare.at]).toEqual(["signedin", null]);
  });

  test("last tell once the child's heartbeat carries a tell", () => {
    const s = stage({ claimed: true, nextStep: { key: "going", words: "", lastTellAt: ago(3600_000) } }).stage!;
    expect([s.key, s.words, s.at]).toEqual(["tell", "Last tell", ago(3600_000)]);
  });

  test("no state while it is made or when the child did not answer", () => {
    expect(stage({ made: false }).stage).toBeNull();
    expect(stage({ claimed: null }).stage).toBeNull();
  });

  test("unopened for three days is marked, and only then", () => {
    expect(stageOf(base({ sentAt: ago(2 * DAY) }), NOW)!.resend).toBe(false);
    const s = stageOf(base({ sentAt: ago(4 * DAY) }), NOW)!;
    expect([s.key, s.words, s.resend]).toEqual(["sent", STALE_WORDS, true]);
    expect(stageOf(base({ sentAt: ago(4 * DAY), claimed: true }), NOW)!.resend).toBe(false);
  });

  test("the page says the same words and offers resend only when stale", () => {
    const fresh = String(forgeRow(stage(), NOW));
    expect(fresh).toContain(`>${STAGE_WORDS.sent} `);
    expect(fresh).not.toContain("Resend");
    const stale = String(forgeRow(stage({ sentAt: ago(4 * DAY) }), NOW));
    expect(stale).toContain(STALE_WORDS);
    expect(stale).toContain("Resend");
    expect(stale).toContain("/forges/acme/claim-link");
  });

  test("the terminal line carries the same words, and resend", () => {
    const fresh = stage();
    expect(forgeLines([fresh])[0]![1]).toContain(` ${fresh.stage!.words} `);
    const stale = stage({ sentAt: ago(4 * DAY) });
    expect(stale.stage!.resend).toBe(true);
    expect(forgeLines([stale])[0]![1]).toContain(STALE_WORDS);
  });

  test("the forges tool answers with the page's words and resend", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-stage-"));
    const app = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    try {
      mkdirSync(join(dir, "spawn"), { recursive: true });
      writeFileSync(
        join(dir, "spawn", "kid.json"),
        JSON.stringify({ name: "kid", bodyId: "cell-k", done: true, placement: "hosted", size: "small", apps: [], createdAt: new Date(Date.now() - 4 * DAY).toISOString() }),
      );
      useChildFetch(app, async () => Response.json({ claimed: false, link: { state: "open", revokedAt: null, usedAt: null } }));
      const [row] = await clientRows(app);
      const out = (await tool.run({ app } as never, { isAdmin: true } as never, {})) as { ok: true; value: any };
      const got = (out.value.forges ?? out.value.value?.forges ?? JSON.parse(JSON.stringify(out)).forges ?? [])[0];
      expect(got.stage).toEqual({ ...row!.stage!, at: got.stage.at });
      expect(got.stage.words).toBe(STALE_WORDS);
      expect(got.stage.resend).toBe(true);
      expect(String(forgeRow(row!, Date.now()))).toContain(got.stage.words);
      expect(tool.doc).toContain("reachable");
      expect(tool.description).toContain("resend");
    } finally {
      app.close();
    }
  });
});
