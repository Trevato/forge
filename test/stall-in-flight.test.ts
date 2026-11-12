/** A loop stall names the request still running when the loop woke, not only the ones that finished (#11478). */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { stallFamilies } from "../src/metrics/stalls.ts";
import { createInFlight } from "../src/perf/in_flight.ts";
import { inFlight, loopWatch } from "../src/perf/live.ts";
import { blamed, createLoopWatch, LIMIT_MS, NO_REQUEST, stallLine } from "../src/perf/loop.ts";
import { whatOf } from "../src/perf/stall_blame.ts";
import { quietLogs } from "./helpers/globals.ts";
import { freshStallState } from "./helpers/stall-state.ts";

quietLogs();
freshStallState();

/** A watch over a hand-held open set, on a clock the test names. */
function watched() {
  const open = createInFlight<string>((key) => key.split("#")[0]!);
  return { open, watch: createLoopWatch(250, () => ["sampler"], open.since) };
}

test("a request held open across a stall is charged with it, labelled in flight", () => {
  const { open, watch } = watched();
  open.begin("/explore#1", 1_000);
  // The wake at 2_000 is 400 ms late: the loop was held from 1_600.
  const stall = watch.stalled(400, 2_000)!;
  expect(stall.inFlight).toEqual(["/explore"]);
  expect(blamed(stall)).toEqual(["/explore (in flight)"]);
  expect(whatOf(stall)).toBe("/explore (in flight)");
  expect(stallLine(stall)).toBe("event loop blocked 400 ms; running then: /explore (in flight)");
  // Charged in place of the job: a request ran, so the job is not read.
  expect(stall.jobs).toEqual([]);
  expect(watch.tally(2_000).hour).toEqual([{ route: "/explore (in flight)", ms: 400, count: 1 }]);
});

test("a request that started after the stall began is not charged", () => {
  const { open, watch } = watched();
  open.begin("/late#1", 1_700);
  const stall = watch.stalled(400, 2_000)!;
  expect(stall.inFlight).toBeUndefined();
  expect(blamed(stall)).toEqual(["job:sampler"]);
});

test("one started exactly when the stall began is older than it, and charged", () => {
  const { open, watch } = watched();
  open.begin("/edge#1", 1_600);
  expect(blamed(watch.stalled(400, 2_000)!)).toEqual(["/edge (in flight)"]);
});

test("an ended request is no longer in flight; finished and open both carry the stall", () => {
  const { open, watch } = watched();
  open.begin("/gone#1", 1_000);
  open.end("/gone#1");
  expect(blamed(watch.stalled(400, 2_000)!)).toEqual(["job:sampler"]);
  open.begin("/held#1", 2_100);
  watch.finished("/done", 2_500, 2_900);
  expect(blamed(watch.stalled(400, 3_000)!)).toEqual(["/done", "/held (in flight)"]);
});

test("open requests are named oldest first, each pattern once", () => {
  const open = createInFlight<string>((key) => key.split("#")[0]!);
  open.begin("/b#1", 30);
  open.begin("/a#1", 10);
  open.begin("/b#2", 20);
  open.begin("/c#1", 90);
  expect(open.since(50)).toEqual(["/a", "/b"]);
});

test("the open set holds only what is open: a million requests begun and ended leave it empty", () => {
  const open = createInFlight<object>(() => "/x");
  for (let i = 0; i < 1_000_000; i++) {
    const key = {};
    open.begin(key, i);
    open.end(key);
  }
  expect(open.size()).toBe(0);
  // Ending what was never begun is harmless.
  open.end({});
  expect(open.size()).toBe(0);
});

test("`during` holds a request open while it runs and lets it go however it settles", async () => {
  const open = createInFlight<object>(() => "/x");
  const key = {};
  const seen = await open.during(key, 5, async () => open.since(5));
  expect(seen).toEqual(["/x"]);
  expect(open.size()).toBe(0);
  await expect(open.during({}, 5, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  expect(open.size()).toBe(0);
});

test("a stall nothing ran across is still `none`", () => {
  const watch = createLoopWatch(250);
  expect(blamed(watch.stalled(400, 2_000)!)).toEqual([NO_REQUEST]);
});

test("the in-flight row is a metrics series like any route", () => {
  const { open, watch } = watched();
  open.begin("/explore#1", 1_000);
  watch.stalled(400, 2_000);
  const total = stallFamilies(watch.tally(2_000)).find((f) => f.name === "forge_loop_stall_milliseconds_total")!;
  expect(total.samples).toContainEqual({ labels: { route: "/explore (in flight)" }, value: 400 });
});

describe_server();

function describe_server() {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let token = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-stall-inflight-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@x.test", password: "correct horse battery 9", isAdmin: true });
    if (!u.ok) throw new Error("alice");
    token = createToken(app.db, u.value.id, "t", "admin").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const system = async (): Promise<any> => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "system", arguments: {} } }),
    });
    const body = (await res.json()) as any;
    return JSON.parse(body.result.content[0].text);
  };

  test("a real request held open across a stall is in MCP `system` `stalls`; one begun after is not", async () => {
    loopWatch.clear();
    // A request whose body has not finished arriving: the server is answering it, and it is open.
    let push: ((chunk: Uint8Array) => void) | undefined;
    let close: (() => void) | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        push = (chunk) => c.enqueue(chunk);
        close = () => c.close();
      },
    });
    const held = fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body,
      duplex: "half",
    } as RequestInit);
    push!(new TextEncoder().encode('{"jsonrpc":"2.0",'));
    const deadline = Date.now() + 5_000;
    while (inFlight.size() === 0 && Date.now() < deadline) await Bun.sleep(5);
    expect(inFlight.size()).toBe(1);
    await Bun.sleep(LIMIT_MS + 60);
    // The wake: the loop held for longer than the stall limit, beginning after the request did.
    const now = performance.now();
    const stall = loopWatch.stalled(LIMIT_MS + 10, now)!;
    const named = stall.inFlight ?? [];
    expect(named).toEqual(["/mcp"]);
    // A stall shorter than the request's age is charged; one reaching back before it began is not.
    expect(loopWatch.stalled(60_000, now)!.inFlight).toBeUndefined();
    push!(new TextEncoder().encode('"id":9,"method":"tools/list"}'));
    close!();
    await (await held).text();
    expect(inFlight.size()).toBe(0);

    const out = await system();
    // A loaded machine may charge a real stall to the same cause as well: at least ours is there.
    const row = out.stalls.find((r: { cause: string }) => r.cause === `${named[0]} (in flight)`);
    expect(row.count).toBeGreaterThanOrEqual(1);
    expect(row.ms).toBeGreaterThanOrEqual(LIMIT_MS + 10);
  });
}
