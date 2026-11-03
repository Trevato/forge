/** The flow answer is computed in the background, in slices, never in a request (#8978). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "../src/app.ts";
import { createApp } from "../src/app.ts";
import { serve } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { flowCached, flowEtag, flowMaxAge, warmFlow, FLOW_TTL_MS, type FlowDeps } from "../src/system/flow_cache.ts";
import { countRead, resetTelemetryReads, telemetryReadsFamily } from "../src/system/telemetry_reads.ts";
import { flowSlices } from "../src/system/telemetry.ts";
import { openMetrics } from "../src/metrics/openmetrics.ts";
import { bigForge } from "./helpers/big-forge.ts";

let dir = "";
let big: App;
beforeAll(() => {
  ({ app: big, dir } = bigForge());
}, 120_000);
afterAll(() => {
  big.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A scheduler the test turns by hand, and a log it can read. */
function manual() {
  const queue: Array<() => void> = [];
  const logged: string[] = [];
  const deps: FlowDeps = { schedule: (f) => void queue.push(f), log: (m) => void logged.push(m) };
  const drain = () => {
    let turns = 0;
    for (let f = queue.shift(); f; f = queue.shift()) (f(), turns++);
    return turns;
  };
  return { deps, drain, logged, pending: () => queue.length };
}
const owner = { kind: "owner" } as const;

test("a warmed cache answers 50 reads from one object, with no slice left queued, on a production-sized forge", async () => {
  const m = manual();
  const warming = warmFlow(big, m.deps, () => 1_000);
  m.drain();
  await warming;
  const first = flowCached(big, owner, 1_100, m.deps);
  for (let i = 0; i < 50; i++) expect(flowCached(big, owner, 1_100 + i, m.deps)).toBe(first);
  expect(m.pending()).toBe(0);
}, 120_000);

test("the computation is cut into slices, so no turn runs the whole of it", () => {
  const g = flowSlices(big, owner, new Date());
  let slices = 0;
  while (!g.next().done) slices++;
  expect(slices).toBeGreaterThanOrEqual(8);
}, 60_000);

test("a stale copy is served at once; the recompute runs on later turns, once, and replaces it", async () => {
  const m = manual();
  const warming = warmFlow(big, m.deps, () => 0);
  m.drain();
  await warming;
  const first = flowCached(big, owner, 1, m.deps);
  const stale = flowCached(big, owner, FLOW_TTL_MS + 1, m.deps);
  expect(stale).toBe(first);
  expect(flowCached(big, owner, FLOW_TTL_MS + 2, m.deps)).toBe(first);
  expect(m.pending()).toBe(1); // one refresh queued, not two
  expect(m.drain()).toBeGreaterThan(1); // took several turns
  expect(flowCached(big, owner, FLOW_TTL_MS + 3, m.deps)).not.toBe(first);
}, 120_000);

test("a failing refresh keeps the stale copy and is logged", async () => {
  const m = manual();
  let broken = false;
  const flaky = new Proxy(big, {
    get: (t, k) => {
      if (k === "db" && broken) throw new Error("db gone");
      return Reflect.get(t, k);
    },
  });
  const warming = warmFlow(flaky, m.deps, () => 0);
  m.drain();
  await warming;
  const first = flowCached(flaky, owner, 1, m.deps);
  broken = true;
  expect(flowCached(flaky, owner, FLOW_TTL_MS + 1, m.deps)).toBe(first);
  m.drain();
  expect(m.logged.length).toBe(1);
  expect(m.logged[0]).toContain("serving the stale copy");
  expect(flowCached(flaky, owner, FLOW_TTL_MS + 2, m.deps)).toBe(first);
  expect(m.pending()).toBe(1); // the next read tries again
}, 120_000);

test("readers of different rights do not share a copy", () => {
  const m = manual();
  const a = flowCached(big, { kind: "agent" }, 5, m.deps);
  const b = flowCached(big, { kind: "agent", spend: true }, 5, m.deps);
  expect(a).not.toBe(b);
});

test("a reader polling shows on the metrics page by route and name", () => {
  resetTelemetryReads();
  for (let i = 0; i < 3; i++) countRead("flow", "foundry");
  const text = openMetrics([telemetryReadsFamily()]);
  expect(text).toContain('forge_telemetry_reads_total{reader="foundry",route="flow"} 3');
});

test("readers past the bound are counted as other, not dropped", () => {
  resetTelemetryReads();
  for (let i = 0; i < 250; i++) countRead("flow", `r${i}`);
  countRead("flow", "late");
  const text = openMetrics([telemetryReadsFamily()]);
  expect(text).toContain('reader="other",route="flow"} 51');
});

// --- the validators a poller reads (#9068) ---

test("etag differs by reader kind and by computed-at; max-age counts down to the TTL", () => {
  expect(flowEtag({ kind: "owner" }, 7)).not.toBe(flowEtag({ kind: "agent" }, 7));
  expect(flowEtag({ kind: "agent" }, 7)).not.toBe(flowEtag({ kind: "agent", spend: true }, 7));
  expect(flowEtag(owner, 7)).not.toBe(flowEtag(owner, 8));
  expect(flowMaxAge(1_000, 1_000)).toBe(5);
  expect(flowMaxAge(1_000, 1_000 + FLOW_TTL_MS - 1)).toBe(1);
  expect(flowMaxAge(1_000, 1_000 + FLOW_TTL_MS + 50)).toBe(0);
});

test("the flow route: headers on 200, matching etag is an empty 304, unauthenticated learns nothing", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-flow304-"));
  const app = createApp({ dataDir, port: 0 });
  const servers = await serve(app);
  try {
    await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
    const minted = await fetch(`${servers.url}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
    });
    const auth = { authorization: `Bearer ${((await minted.json()) as { token: string }).token}` };
    const url = `${servers.url}/api/v1/telemetry/flow`;
    resetTelemetryReads();
    const ok = await fetch(url, { headers: auth });
    await ok.arrayBuffer();
    expect(ok.status).toBe(200);
    const etag = ok.headers.get("etag")!;
    expect(etag).toBeTruthy();
    expect(ok.headers.get("vary")).toStartWith("authorization, cookie");
    expect(ok.headers.get("cache-control")).toMatch(/^private, max-age=[0-5]$/);
    const again = await fetch(url, { headers: { ...auth, "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect((await again.arrayBuffer()).byteLength).toBe(0);
    expect(again.headers.get("etag")).toBe(etag);
    expect(again.headers.get("x-content-type-options")).toBe("nosniff");
    expect(again.headers.get("content-security-policy")).toBeTruthy();
    const other = await fetch(url, { headers: { ...auth, "if-none-match": '"flow-agent-1"' } });
    await other.arrayBuffer();
    expect(other.status).toBe(200);
    const metrics = openMetrics([telemetryReadsFamily()]);
    expect(metrics).toMatch(/forge_telemetry_reads_total\{reader="alice",route="flow"\} 3/);
    const anon = await fetch(url, { headers: { "if-none-match": etag } });
    await anon.arrayBuffer();
    expect(anon.status).toBe(401);
    expect(anon.headers.get("etag")).toBeNull();
  } finally {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
