/** The platform's word on the rollout: ok, blocked, held — and stale. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { running } from "../src/kernel/version.ts";
import {
  forgeHealth,
  parseGuard,
  readGuard,
  rolloutLine,
} from "../src/kernel/guard.ts";

const NOW = Date.parse("2026-10-02T12:00:00Z");
const fresh = "2026-10-02T11:59:00Z";
const status = (incidents: Record<string, string>) =>
  JSON.stringify({ incidents, public: 200, service: 200 });

test("no ConfigMap, or an empty one, reports ok", () => {
  const none = forgeHealth(readGuard("/nonexistent/forge-guard"), NOW);
  expect(none.ok).toBe(true);
  expect(none.rollout).toEqual({ state: "ok", reason: "" });
  expect(none.checkedAt).toBeNull();
  const empty = forgeHealth(parseGuard(status({}), fresh), NOW);
  expect(empty.ok).toBe(true);
  expect(empty.incidents).toEqual([]);
  expect(rolloutLine(empty)).toBeNull();
});

test("a stuck incident blocks the rollout with its reason", () => {
  const reason = "pod refused: exceeded quota; raise requests.memory to 10Gi";
  const h = forgeHealth(parseGuard(status({ stuck: reason }), fresh), NOW);
  expect(h.rollout).toEqual({ state: "blocked", reason });
  expect(h.ok).toBe(false);
  expect(rolloutLine(h)).toBe(`rollout blocked: ${reason}`);
});

test("a held incident holds the rollout", () => {
  const h = forgeHealth(
    parseGuard(status({ held: "preflight: no room on node" }), fresh),
    NOW,
  );
  expect(h.rollout).toEqual({ state: "held", reason: "preflight: no room on node" });
  expect(rolloutLine(h)).toBe("rollout held: preflight: no room on node");
});

test("a stale view says so instead of all fine", () => {
  const h = forgeHealth(parseGuard(status({}), "2026-10-02T11:40:00Z"), NOW);
  expect(h.stale).toBe(true);
  expect(h.ok).toBe(false);
  expect(h.rollout.reason).toContain("stale");
  expect(rolloutLine(h)).toContain("stale");
});

test("malformed input reads as nothing, and odd keys are dropped", () => {
  expect(parseGuard("{not json", "nonsense")).toEqual({ incidents: [], checkedAt: null });
  const g = parseGuard(status({ "bad key!": "x", "oom:web": "killed", n: 5 as never }), fresh);
  expect(g.incidents).toEqual([{ key: "oom:web", message: "killed" }]);
});

let dir: string;
let guardDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-guard-"));
  guardDir = mkdtempSync(join(tmpdir(), "forge-guard-cm-"));
  process.env["FORGE_GUARD_DIR"] = guardDir;
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
});

afterAll(async () => {
  delete process.env["FORGE_GUARD_DIR"];
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
  rmSync(guardDir, { recursive: true, force: true });
});

test("/api/v1/health answers anyone, from the mounted ConfigMap", async () => {
  let res = await fetch(servers.url + "/api/v1/health");
  expect(res.status).toBe(200);
  let body = (await res.json()) as any;
  expect(body.ok).toBe(true);
  expect(body.rollout.state).toBe("ok");
  expect(body.draining).toBe(false);
  // What is running, as the build stamped it (`test/version.test.ts`).
  expect([body.version, body.commit]).toEqual([
    running().version,
    running().commit,
  ]);

  mkdirSync(guardDir, { recursive: true });
  writeFileSync(join(guardDir, "status.json"), status({ stuck: "quota refused <b>" }));
  writeFileSync(join(guardDir, "checkedAt"), new Date().toISOString());
  res = await fetch(servers.url + "/api/v1/health");
  body = await res.json();
  expect(body.rollout).toEqual({ state: "blocked", reason: "quota refused <b>" });
  expect(body.ok).toBe(false);
  expect(body.incidents).toEqual([{ key: "stuck", message: "quota refused <b>" }]);
});
