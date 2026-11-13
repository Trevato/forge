/**
 * The claim page's sentence on who can see the forge afterwards (#11785): a
 * start nobody signed in for never names the placeholder account that holds
 * the forge until it is claimed; a real spawner, whatever they are called, is
 * named whether or not they keep access.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childDirOf, childNamed } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { useProbe } from "../src/spawn/door.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const ONLY_YOU = "Once you open it as yours, only you can see its private work.";

describe("the claim page's access sentence", () => {
  let dir = "";
  let parent: App;
  let parentServers: Servers;
  let rw = "";
  const kids: { app: App; servers: Servers }[] = [];

  /** The text of the claim page of a child, once it has booted. */
  async function claimPage(bodyId: string, before?: (dir: string) => Promise<void>): Promise<string> {
    await before?.(childDirOf(parent, bodyId));
    const app = createApp({ dataDir: childDirOf(parent, bodyId), port: 0 });
    await firstBoot(app);
    const servers = await serve(app);
    kids.push({ app, servers });
    const res = await fetch(`${servers.url}/claim`);
    expect(res.status).toBe(200);
    return (await res.text()).replace(/\s+/g, " ");
  }

  /** A forge a signed-in person starts, and its claim page. */
  async function spawnedBy(name: string, keepAccess: boolean): Promise<string> {
    const res = await fetch(`${parentServers.url}/api/v1/forges`, {
      method: "POST",
      headers: { authorization: `Bearer ${rw}`, "content-type": "application/json" },
      body: JSON.stringify({ name, apps: [], dryRun: false, keepAccess }),
    });
    if (res.status !== 201) throw new Error(`spawn ${res.status} ${await res.text()}`);
    return claimPage(((await res.json()) as { bodyId: string }).bodyId);
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-claim-access-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    useProbe(parent, () => async () => true);
    // A real person whose username is the placeholder's.
    const made = await createUser(parent.db, {
      origin: "seed", trusted: true, username: "founder", email: "f@x.test",
      password: "a-long-claim-passphrase", isAdmin: true,
    });
    if (!made.ok) throw new Error("user");
    rw = createToken(parent.db, made.value.id, "rw", "rw").token;
    parentServers = await serve(parent);
  }, 60_000);

  afterAll(async () => {
    for (const k of kids) {
      k.servers.stop();
      k.app.close();
    }
    parentServers.stop();
    parent.close();
    await rm(dir, { recursive: true, force: true });
  });

  /** A forge a stranger starts from the home page, with no account, and its claim page. */
  async function startedAnonymously(name: string, before?: (dir: string) => Promise<void>): Promise<string> {
    const started = await fetch(`${parentServers.url}/forges/start`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ name, js: "1" }),
      redirect: "manual",
    });
    expect(started.status).toBe(303);
    const made = await childNamed(parent, name);
    if (made === undefined) throw new Error("no child");
    return claimPage(made.bodyId, before);
  }

  /** What an anonymous start's claim page says, whatever its parent.json's age. */
  function namesNoOne(text: string): void {
    expect(text).toContain(ONLY_YOU);
    expect(text).not.toMatch(/founder/i);
    expect(text).not.toContain("Whoever made it");
    // The placeholder has no way in, so `founderToTake` would offer it ("Open it as
    // founder and you will take over…"): never, here. A new link is asked of whoever sent it.
    expect(text).not.toContain('id="claim-takeover"');
    expect(text).not.toContain("take over");
    expect(text).toContain('id="claim-expiry"');
    expect(text).toContain("ask whoever sent it to send you a new one");
  }

  test("an anonymous start never shows the placeholder name", async () => {
    namesNoOne(await startedAnonymously("stranger"));
  });

  test("a forge started anonymously before the start was recorded names no one either", async () => {
    namesNoOne(
      await startedAnonymously("older", async (dir) => {
        const file = join(dir, "parent.json");
        const { anonymous, ...rest } = (await Bun.file(file).json()) as Record<string, unknown>;
        expect(anonymous).toBe(true);
        await Bun.write(file, JSON.stringify(rest));
      }),
    );
  });

  test("a named spawner is named when they keep access", async () => {
    const text = await spawnedBy("keeps", true);
    expect(text).toContain("founder keeps owner access to this forge");
    // A real spawner is asked for a new link by name; keeping access, their account is not offered.
    expect(text).toContain("ask founder to send you a new one");
    expect(text).not.toContain('id="claim-takeover"');
  });

  test("a named spawner is named when they do not keep access", async () => {
    const text = await spawnedBy("leaves", false);
    expect(text).toContain(
      "founder, who made it, no longer has access unless you invite them back",
    );
    expect(text).not.toContain(ONLY_YOU);
    // Asked for a new link by name, and offered their account here, by name, to take over.
    expect(text).toContain("ask founder to send you a new one");
    expect(text).toContain(
      "Open it as founder and you will take over founder's account on this forge, with everything already made under it.",
    );
  });
});
