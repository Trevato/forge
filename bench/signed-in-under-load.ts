/**
 * Signed-in pages while strangers flood code pages (#9513). Boots a throwaway
 * forge in this process with the Shield `open` (so the crawl budget turns no
 * stranger away and the whole flood reaches git), seeds one public
 * repository and a signed-in session, then runs bench/load.ts against it:
 * anonymous tree, blob and raw pages open-loop at `--rate` a second, and a
 * signed-in `/` and repository home every 50 ms beside them.
 *
 * It also times every wait for a `gitGate` permit in the server while the load
 * runs, and prints their p50/p95/max: when signed-in pages are slow and these
 * waits are long, the plumbing pool is where the time goes.
 *
 *   bun bench/signed-in-under-load.ts --rate 500 --seconds 15
 *   FORGE_STRANGER_CODE_CONCURRENCY=8 bun bench/signed-in-under-load.ts ...  # strangers may take the whole pool: the old behaviour
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { changeShield } from "../src/actions/shield.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { gitGate } from "../src/git/env.ts";
import { serve } from "../src/http/server.ts";
import { strangerCodeGate } from "../src/http/stranger_code.ts";

const arg = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  const v = at >= 0 ? process.argv[at + 1]! : fallback;
  if (!(Number(v) > 0)) throw new Error(`bad --${name}`);
  return v;
};
const rate = arg("rate", "500");
const seconds = arg("seconds", "15");

// Every wait for a plumbing permit, timed where it happens.
const waits: number[] = [];
const acquire = gitGate.acquire.bind(gitGate);
gitGate.acquire = async (options) => {
  const began = performance.now();
  const release = await acquire(options);
  waits.push(performance.now() - began);
  return release;
};

const dataDir = await mkdtemp(join(tmpdir(), "forge-signed-in-load-"));
const app = createApp({ dataDir, port: 0 });
const servers = await serve(app);
try {
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", isAdmin: true });
  if (!u.ok) throw new Error(u.error);
  const shield = changeShield(app, u.value, "open");
  if (!shield.ok) throw new Error(shield.error);
  const r = await createRepo(app, u.value, { name: "open", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  const files = Array.from({ length: 40 }, (_, i) => ({ path: `src/f${i}.ts`, content: `export const x${i} = ${i};\n`.repeat(50) }));
  const c = await commitToBranch(app, u.value, getRepo(app.db, "alice", "open")!, { message: "Start", files });
  if (!c.ok) throw new Error(String(c.error));
  const cookie = `forge_session=${createSession(app.db, u.value.id).token}`;

  const load = Bun.spawn(["bun", join(import.meta.dir, "load.ts"), "--url", servers.url, "--repo", "alice/open", "--rate", rate, "--seconds", seconds], {
    // Bun's fetch holds a few hundred requests a process by default: past that
    // the signed-in stream would queue in the client behind the flood.
    env: { BUN_CONFIG_MAX_HTTP_REQUESTS: "65000", ...process.env, FORGE_LOAD_COOKIE: cookie },
    stdout: "inherit",
    stderr: "inherit",
  });
  waits.length = 0;
  // The main thread's lag: how late a 10 ms timer fires. Long lag with short
  // gate waits is a busy event loop; short lag with long waits is the pool.
  const lags: number[] = [];
  const held: number[] = [];
  let tick = performance.now();
  const sampler = setInterval(() => {
    const now = performance.now();
    lags.push(Math.max(0, now - tick - 10));
    held.push(gitGate.stats().active);
    tick = now;
  }, 10);
  await load.exited;
  clearInterval(sampler);

  const s = [...waits].sort((a, b) => a - b);
  const at = (p: number) => (s.length === 0 ? "-" : s[Math.min(s.length - 1, Math.floor(p * s.length))]!.toFixed(1));
  console.log(`strangers' share: ${strangerCodeGate.limit} of ${gitGate.limit} git permits`);
  const l = [...lags].sort((a, b) => a - b);
  console.log(`event-loop lag: p50 ${l[Math.floor(0.5 * l.length)]?.toFixed(1)} ms, p95 ${l[Math.floor(0.95 * l.length)]?.toFixed(1)} ms, max ${l.at(-1)?.toFixed(1)} ms; git permits held, mean ${(held.reduce((a, b) => a + b, 0) / Math.max(1, held.length)).toFixed(1)}`);
  console.log(`gitGate waits: ${s.length}, p50 ${at(0.5)} ms, p95 ${at(0.95)} ms, max ${at(1)} ms`);
} finally {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
}
