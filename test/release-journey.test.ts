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
import { useChildFetch } from "../src/spawn/clients.ts";
import { addSubscription } from "../src/core/subscriptions.ts";
import { createUser } from "../src/core/users.ts";
import { FIRST_FIVE_MINUTES } from "../src/design/first_five_minutes.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { REMOVE_BACKOFF_MS, sweepProbes, walkJourney } from "../src/release/journey.ts";
import { useProbe } from "../src/spawn/door.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let parent: App;
let parentServers: Servers;
let adminToken = "";
const kids = new Map<string, { app: App; servers: Servers; crew: CrewHandle; dataDir: string }>();
/** A step that answers 503, as `METHOD path` on the child. */
let broken: string | undefined;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-journey-"));
  parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
  useProbe(parent, () => async () => true);
  // The forge list asks each child about itself; none of those asks leaves this machine.
  useChildFetch(parent, async () => new Response("{}", { status: 503 }));
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
  const k = { app, servers, crew, dataDir };
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

test("a walk that blows up half-way (outside any step) still removes its forge", async () => {
  let calls = 0;
  const log: string[] = [];
  const inner = routed(log);
  // `now` throws once the account exists: nothing in the walk catches it as a step.
  const now = () => {
    if (log.includes("POST /claim")) throw new Error("clock exploded");
    return (calls += 1);
  };
  const result = await walkJourney({ base: parentServers.url, fetch: inner, adminToken, now, sleep: () => Bun.sleep(100), pollMs: 100 }); // real-timer: the stand-in crew child runs in real time
  // The walk does not reject: it says what stopped it, and cleans up all the same.
  expect(result.ok).toBe(false);
  expect(result.failure).toBe("the walk stopped unexpectedly");
  expect(result.removed).toBe(true);
  expect(log).toContain("POST /claim");
  const name = [...kids.keys()].at(-1)!;
  expect(await forgeGone(name)).toBe(true);
  // The account lived in the forge's own data: that directory is gone, and the account with it.
  expect(existsSync(kids.get(name)!.dataDir)).toBe(false);
}, 60_000);

test("a run sweeps the probe forges an interrupted run left over an hour ago, and only those", async () => {
  const start = async (name: string) => {
    const res = await fetch(`${parentServers.url}/forges/start`, { method: "POST", redirect: "manual", headers: { origin: "https://forge.test" }, body: new URLSearchParams({ name, js: "1" }) });
    await res.body?.cancel();
    expect(res.status).toBe(303);
  };
  const age = async (name: string, ms: number) => {
    const file = join(dir, "spawn", `${name}.json`);
    const ledger = JSON.parse(await Bun.file(file).text());
    ledger.createdAt = new Date(Date.now() - ms).toISOString();
    await Bun.write(file, JSON.stringify(ledger));
  };
  await start("probe-aaaaaaaa");
  await start("probe-bbbbbbbb");
  await start("keepme-forge");
  await age("probe-aaaaaaaa", 2 * 60 * 60 * 1000);
  await age("keepme-forge", 5 * 60 * 60 * 1000);
  const result = await walkJourney({ base: parentServers.url, fetch: routed([]), adminToken, pollMs: 0, now: (() => { let t = 0; return () => (t += 5_000); })(), sleep: async () => {} });
  expect(result.swept).toEqual(["probe-aaaaaaaa"]);
  expect(await forgeGone("probe-aaaaaaaa")).toBe(true);
  expect(await childNamed(parent, "probe-bbbbbbbb")).toBeDefined(); // under an hour: may be a run in progress
  expect(await childNamed(parent, "keepme-forge")).toBeDefined(); // not a probe's name
  for (const n of ["probe-bbbbbbbb", "keepme-forge"])
    await fetch(`${parentServers.url}/forges/${n}/remove`, { method: "POST", headers: { origin: parentServers.url, authorization: `Bearer ${adminToken}` } });
}, 60_000);

test("a removal that fails once is tried again after a pause, and the result says it is gone", async () => {
  const log: string[] = [];
  const inner = routed(log);
  const pauses: number[] = [];
  let failed = 0;
  const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/api/v1/forges") throw new Error("the list is down");
    if (/\/forges\/probe-[0-9a-f]{8}\/remove$/.test(new URL(String(input)).pathname) && failed < 1) {
      failed += 1;
      return new Response("busy", { status: 503 });
    }
    return inner(input, init);
  }) as typeof fetch;
  let t = 0;
  const sleep = async (ms: number) => {
    pauses.push(ms);
    await Bun.sleep(100); // real-timer: the stand-in crew child runs in real time
  };
  const result = await walkJourney({ base: parentServers.url, fetch: flaky, adminToken, pollMs: 100, now: () => (t += 10), sleep });
  // The sweep's list was down: that is reported, and the passing walk is still passing.
  expect(result.failure).toBeUndefined();
  expect(result.ok).toBe(true);
  expect(result.sweepError).toBe("the list is down");
  expect(failed).toBe(1);
  expect(result.removed).toBe(true);
  expect(pauses).toContain(REMOVE_BACKOFF_MS[0]!);
  expect(await forgeGone(result.forge!)).toBe(true);
}, 60_000);

test("a removal that never succeeds waits between its attempts and says it is not gone", async () => {
  const inner = routed([]);
  const pauses: number[] = [];
  const stuck = (async (input: string | URL | Request, init?: RequestInit) =>
    /\/remove$/.test(new URL(String(input)).pathname) && init?.method === "POST" ? new Response("no", { status: 503 }) : inner(input, init)) as typeof fetch;
  let t = 0;
  const result = await walkJourney({ base: parentServers.url, fetch: stuck, adminToken, pollMs: 0, now: () => (t += 5_000), sleep: async (ms) => void pauses.push(ms) });
  expect(result.removed).toBe(false);
  expect(pauses).toEqual([...REMOVE_BACKOFF_MS]);
  await fetch(`${parentServers.url}/forges/${result.forge}/remove`, { method: "POST", headers: { origin: parentServers.url, authorization: `Bearer ${adminToken}` } });
}, 60_000);

test("a sweep with no admin token does nothing and says nothing is wrong", async () => {
  const never = (() => { throw new Error("no request"); }) as unknown as typeof fetch;
  expect(await sweepProbes(never, new URL(parentServers.url), undefined, Date.now())).toEqual({ gone: [] });
});

test("a sweep that throws comes back as its reason and never throws", async () => {
  const broke = (async () => { throw new Error("the list is down"); }) as unknown as typeof fetch;
  expect(await sweepProbes(broke, new URL(parentServers.url), adminToken, Date.now())).toEqual({ gone: [], error: "the list is down" });
});
