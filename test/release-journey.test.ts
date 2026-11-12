/**
 * `walkJourney` (#11158, part 2) against a forge served here: the parent and
 * the child it spawns both run for real, the child's crew is a stand-in for
 * Claude Code (a script that speaks stream-json and stays at work). Only the
 * child's address is a stand-in: its host name is routed to the local server.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childDirOf, childNamed } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { startCrew, type CrewHandle } from "../src/crew/dispatch.ts";
import { createToken } from "../src/core/tokens.ts";
import { addSubscription } from "../src/core/subscriptions.ts";
import { createUser } from "../src/core/users.ts";
import { FIRST_FIVE_MINUTES } from "../src/design/first_five_minutes.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { walkJourney } from "../src/release/journey.ts";
import { useProbe } from "../src/spawn/door.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let parent: App;
let parentServers: Servers;
let adminToken = "";
const kids = new Map<string, { app: App; servers: Servers; crew: CrewHandle }>();
/** A step that answers 503, as `METHOD path` on the child. */
let broken: string | undefined;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-journey-"));
  parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
  useProbe(parent, () => async () => true);
  const alice = await createUser(parent.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.test", password: "a-good-passphrase", adminIfFirst: true });
  if (!alice.ok) throw new Error(alice.error);
  adminToken = createToken(parent.db, alice.value.id, "journey", "admin").token;
  parentServers = await serve(parent);
}, 30_000);

afterAll(async () => {
  for (const k of kids.values()) {
    await k.crew.stop();
    k.servers.stop();
    k.app.close();
  }
  parentServers.stop();
  parent.close();
  await rm(dir, { recursive: true, force: true });
});

/** Boots the child the parent made for `name`, with a stand-in crew, the first time its host is asked for. */
async function kid(name: string) {
  const had = kids.get(name);
  if (had) return had;
  const made = await childNamed(parent, name);
  if (made === undefined) throw new Error(`the parent made no forge named ${name}`);
  const dataDir = childDirOf(parent, made.bodyId);
  const app = createApp({ dataDir, port: 0 });
  await firstBoot(app);
  const sub = addSubscription(app.db, dataDir, { name: "work", token: "sk-ant-api03-journey-stand-in-0123456789abcdef" });
  if (!sub.ok) throw new Error(sub.error);
  const servers = await serve(app);
  const fake = join(dir, `fake-claude-${name}`);
  writeFileSync(
    fake,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
echo '{"type":"system","subtype":"init","session_id":"fake-1","model":"fake"}'
sleep 20
`,
  );
  chmodSync(fake, 0o755);
  const crew = await startCrew(app, { forgeUrl: servers.url, localUrl: servers.url, binary: fake, concurrency: 1, budgetUsd: 1, runTimeoutMs: 30_000, networkRetryScale: 0, tickMs: 100 });
  const k = { app, servers, crew };
  kids.set(name, k);
  return k;
}

/** The fetch a walker gets: the parent as it is, a child's host routed to the child's server. */
function routed(log: string[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const name = /^([a-z0-9-]+)--forge\.test$/.exec(url.hostname)?.[1];
    if (name === undefined) {
      // The parent believes it lives at forge.test: a browser there would send that origin.
      const headers = new Headers(init?.headers);
      if (headers.has("origin")) headers.set("origin", "https://forge.test");
      return fetch(url, { ...init, headers });
    }
    const k = await kid(name);
    log.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (broken !== undefined && broken === `${init?.method ?? "GET"} ${url.pathname}`) return new Response("down", { status: 503 });
    const headers = new Headers(init?.headers);
    if (headers.has("origin")) headers.set("origin", k.servers.url);
    return fetch(`${k.servers.url}${url.pathname}${url.search}`, { ...init, headers });
  }) as typeof fetch;
}

const forgeGone = (name: string) => childNamed(parent, name).then((c) => c === undefined && !existsSync(join(dir, "spawn", `${name}.json`)));

test("a passing walk: the screens, the timings, and the throwaway forge removed", async () => {
  broken = undefined;
  const log: string[] = [];
  let t = 0;
  const result = await walkJourney({ base: parentServers.url, fetch: routed(log), adminToken, now: () => (t += 10), sleep: () => Bun.sleep(100), pollMs: 100 });
  expect(result.failure).toBeUndefined();
  expect(result.ok).toBe(true);
  expect(result.screens).toEqual(["home", "account", "forge"]);
  expect(result.screens.length).toBeLessThanOrEqual(FIRST_FIVE_MINUTES.screensBeforeForge);
  expect(result.readyMs).toBeGreaterThan(0);
  expect(result.readyMs!).toBeLessThan(FIRST_FIVE_MINUTES.forgeReadySeconds * 1000);
  expect(result.firstActivityMs).toBeGreaterThan(0);
  expect(result.firstActivityMs!).toBeLessThan(FIRST_FIVE_MINUTES.firstCrewActivitySeconds * 1000);
  expect(log).toContain("POST /tell");
  // Removed: the host no longer knows it, and its data is gone.
  expect(result.removed).toBe(true);
  expect(result.forge).toMatch(/^probe-[0-9a-f]{8}$/);
  expect(await forgeGone(result.forge!)).toBe(true);
}, 60_000);

test("a failing walk names the step that answered 503, and still removes the forge", async () => {
  broken = "POST /claim";
  const log: string[] = [];
  const result = await walkJourney({ base: parentServers.url, fetch: routed(log), adminToken, sleep: () => Bun.sleep(100), pollMs: 100 });
  broken = undefined;
  expect(result.ok).toBe(false);
  expect(result.failure).toBe("the account could not be made: it answered 503");
  expect(result.screens).toEqual(["home", "account"]);
  expect(result.firstActivityMs).toBeNull();
  expect(log).not.toContain("POST /tell");
  expect(result.removed).toBe(true);
  expect(await forgeGone(result.forge!)).toBe(true);
}, 60_000);

test("a forge that is never ready fails in words, with the budget in them", async () => {
  useProbe(parent, () => async () => false);
  let t = 0;
  const result = await walkJourney({ base: parentServers.url, fetch: routed([]), adminToken, now: () => (t += 5_000), sleep: async () => {}, pollMs: 0 });
  useProbe(parent, () => async () => true);
  expect(result.ok).toBe(false);
  expect(result.failure).toBe(`the forge was not ready in ${FIRST_FIVE_MINUTES.forgeReadySeconds} s`);
  expect(result.readyMs).toBeNull();
  expect(await forgeGone(result.forge!)).toBe(true);
}, 30_000);

test("without an admin token the forge cannot be removed from here, and the result says so", async () => {
  const result = await walkJourney({ base: parentServers.url, fetch: routed([]), pollMs: 100, now: (() => { let t = 0; return () => (t += 5_000); })(), sleep: async () => {} });
  expect(result.removed).toBe(false);
  expect(result.forge).not.toBeNull();
  await fetch(`${parentServers.url}/forges/${result.forge}/remove`, { method: "POST", headers: { origin: parentServers.url, authorization: `Bearer ${adminToken}` } });
});

test("an address that is not http(s) is refused before anything is sent", async () => {
  const result = await walkJourney({ base: "ftp://forge.test", fetch: (() => { throw new Error("no request"); }) as unknown as typeof fetch });
  expect(result).toMatchObject({ ok: false, forge: null, removed: true, failure: "the forge's address is not http or https" });
});
