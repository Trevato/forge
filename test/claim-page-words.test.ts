/**
 * The claim page in plain words (#11339): a good link says when it stops
 * working; an expired or used one answers 410 with one line saying why and
 * who can send another, and never a technical word.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childDirOf } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { relativeWords } from "../src/web/pages/claim.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("the claim page in plain words", () => {
  let dir = "";
  let parent: App;
  let parentServers: Servers;
  let child: App;
  let childServers: Servers;
  let token = "";

  const get = () => fetch(`${childServers.url}/claim`);
  const setStored = (patch: Record<string, unknown>) => {
    const row = child.db.query<{ value: string }, []>("SELECT value FROM user_setting WHERE key = 'spawn_claim'").get();
    child.db
      .query("UPDATE user_setting SET value = ?1 WHERE key = 'spawn_claim'")
      .run(JSON.stringify({ ...JSON.parse(row!.value), ...patch }));
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-claim-words-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const alice = await createUser(parent.db, {
      origin: "seed", trusted: true, username: "alice", email: "a@x.test",
      password: "a-long-claim-passphrase", isAdmin: true,
    });
    if (!alice.ok) throw new Error("user");
    const rw = createToken(parent.db, alice.value.id, "rw", "rw").token;
    parentServers = await serve(parent);
    const made = await fetch(`${parentServers.url}/api/v1/forges`, {
      method: "POST",
      headers: { authorization: `Bearer ${rw}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "maria", apps: [], dryRun: false }),
    });
    if (made.status !== 201) throw new Error(`spawn ${made.status} ${await made.text()}`);
    const body = (await made.json()) as { claimUrl: string; bodyId: string };
    token = body.claimUrl.split("#")[1] ?? "";
    child = createApp({ dataDir: childDirOf(parent, body.bodyId), port: 0 });
    await firstBoot(child);
    childServers = await serve(child);
  }, 60_000);

  afterAll(async () => {
    childServers.stop();
    child.close();
    parentServers.stop();
    parent.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("relative words", () => {
    expect(relativeWords(5 * 3_600_000)).toBe("in 5 hours");
    expect(relativeWords(60_000)).toBe("in 1 minute");
    expect(relativeWords(-3 * 86_400_000)).toBe("3 days ago");
  });

  test("a valid link names its expiry as a date and a relative time", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('id="claim-expiry"');
    expect(html).toMatch(/works until\s*<time datetime="[^"]+">[A-Z][a-z]{2} \d{1,2}, \d\d:\d\d UTC<\/time>\s*\(in (23|24) hours\)/);
    expect(html).toContain("alice");
  });

  test("an expired link answers 410 in plain words", async () => {
    setStored({ e: new Date(Date.now() - 3_600_000).toISOString() });
    for (const res of [
      await get(),
      await fetch(`${childServers.url}/claim`, {
        method: "POST", headers: { origin: childServers.url }, body: new URLSearchParams({ token }),
      }),
    ]) {
      expect(res.status).toBe(410);
      const text = await res.text();
      expect(text).toContain("This link has expired");
      expect(text).toContain("Ask alice to send you a new one");
      expect(text).not.toMatch(/token|\b4\d\d\b/i);
    }
  });

  test("a used link answers 410 in plain words", async () => {
    setStored({ e: new Date(Date.now() + 3_600_000).toISOString(), u: new Date().toISOString() });
    const res = await get();
    expect(res.status).toBe(410);
    const text = await res.text();
    expect(text).toContain("This link has already been used");
    expect(text).toContain("ask alice to send you a new one");
    expect(text).not.toMatch(/token|\b4\d\d\b/i);
  });

  test("a made-up code still only meets the not-a-forge-link answer", async () => {
    const res = await fetch(`${childServers.url}/claim`, {
      method: "POST", headers: { origin: childServers.url }, body: new URLSearchParams({ token: "x".repeat(43) }),
    });
    expect(res.status).toBe(404);
  });
});
