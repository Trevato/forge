/**
 * A hosted forge reaches an outside git host through its parent's gate, by
 * name (the child of the experiment that could not connect an origin, 2026-11-13).
 * The gate is the real one (`startEgress`), the host a real TLS server with a
 * real git behind it, and the forge's code runs in a process that has only
 * the variables a cell gives it: `HTTPS_PROXY`, and `FORGE_PARENT_LOCAL`.
 * `spawn-cell-e2e.test.ts` runs the whole cell where bwrap and socat are; this
 * needs neither, so it runs everywhere.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { egressTotals, meterEgress, resetEgressTotals, startEgress } from "../src/apps/egress.ts";
import { resultLine } from "./helpers/result-line.ts";
import { seedRepo, selfSigned, serveGit } from "./helpers/gate-fixture.ts";

// `localhost` is the one name every machine resolves, and the gate resolves it: it is the forge's own origin there, so the gate lets it be private.
const pair = selfSigned("localhost");
const t = pair ? test : test.skip;
const label = `forge:gate-e2e-${process.pid}`;
let server: ReturnType<typeof serveGit> | undefined;
let gate: ReturnType<typeof startEgress> | undefined;
const gatePort = 30_000 + Math.floor(Math.random() * 20_000);

beforeAll(() => {
  resetEgressTotals();
  if (pair === undefined) return;
  server = serveGit(seedRepo(), pair);
  gate = startEgress({ tcp: gatePort }, { hosts: [], origins: [{ host: "localhost", port: server.port! }], label });
});
afterAll(() => {
  gate?.close();
  server?.stop(true);
  resetEgressTotals();
});

/** Only what a cell gives a process: no address to dial, and the proxy as the way out. */
async function inCell(extra: Record<string, string>): Promise<Record<string, unknown>> {
  const proxy = `http://127.0.0.1:${gatePort}`;
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "helpers", "gate-child.ts")], {
    env: {
      PATH: process.env["PATH"] ?? "/usr/bin:/bin",
      HOME: "/dev/null",
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      FORGE_PARENT_LOCAL: "127.0.0.1:1",
      ...extra,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const line = resultLine(out);
  if (line === "") throw new Error(`the child printed no result: ${out.slice(-500)} ${err.slice(-800)}`);
  return JSON.parse(line) as Record<string, unknown>;
}

t("a forge that has only its cell's proxy fetches and runs git against an outside host through the gate", async () => {
  const viaGate = meterEgress(label);
  const seen = await inCell({ TARGET: `https://localhost:${server!.port}`, CA_FILE: pair!.certFile });
  expect(seen["via"]).toBe("gate");
  expect(seen["body"]).toBe("hello over tls");
  expect(seen["listed"]).toContain("refs/heads/main");
  expect(seen["fetched"]).toBe(true);
  expect(String(seen["main"])).toMatch(/^[0-9a-f]{40}$/);
  // An address literal is never dialled, and a host the gate does not list is its refusal.
  expect(seen["literal"]).toBe("refused");
  expect(seen["refused"]).toBe("refused: the forge's host does not let it reach localhost");
  // Every byte of it crossed the gate.
  expect(viaGate.stop()).toBeGreaterThan(1000);
  const moved = egressTotals().find((row) => row.destination === `localhost:${server!.port}`);
  expect(moved?.bytesIn).toBeGreaterThan(0);
  expect(moved?.bytesOut).toBeGreaterThan(0);
});
