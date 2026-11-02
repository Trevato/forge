/**
 * A forge booting beside one still draining on the same database answers
 * /healthz within a second throughout (#6957). 0.7.278 came up while
 * 0.7.276 finished a batch of gates on the shared data, started its own
 * work, and waited on the old pod's write lock on the one thread it serves
 * from: readiness timed out for minutes.
 *
 * The peer here is that old pod in miniature: a process that keeps the
 * leases of a batch of 8 running checks fresh and holds the write lock
 * for most of every second, then finishes and lets go.
 */

import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";

const PEER_MS = 20_000;
const HOLD_MS = 2_500;
const GAP_MS = 150;

/** Holds the write lock `HOLD_MS` of every `HOLD_MS + GAP_MS`, renewing the 8 leases each time; then lands them and exits. */
const peerScript = `
const { Database } = require("bun:sqlite");
const db = new Database(process.argv[2]);
db.run("PRAGMA busy_timeout = 15000");
const ids = ${JSON.stringify(Array.from({ length: 8 }, (_, n) => `gate-${n}`))};
const until = Date.now() + ${PEER_MS};
const spin = (ms) => { const end = Date.now() + ms; while (Date.now() < end) {} };
console.log("peer up");
const tick = () => {
  db.run("BEGIN IMMEDIATE");
  db.run("UPDATE run SET heartbeat_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id IN (" + ids.map((i) => "'" + i + "'").join(",") + ")");
  spin(${HOLD_MS});
  db.run("COMMIT");
  if (Date.now() < until) return void setTimeout(tick, ${GAP_MS});
  db.run("UPDATE run SET state = 'ok' WHERE state = 'running'");
  console.log("peer done");
  process.exit(0);
};
tick();
`;

test("healthz answers within 1 s throughout a boot beside a draining forge's batch of 8, and work starts once it lets go", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-bootpeer-"));
  const seed = createApp({ dataDir, port: 0 });
  seed.db.run("PRAGMA foreign_keys = OFF");
  const now = new Date().toISOString();
  for (let n = 0; n < 8; n++)
    seed.db
      .query("INSERT INTO run (id, repo_id, kind, state, started_at, heartbeat_at) VALUES (?1, 'r', 'check', 'running', ?2, ?2)")
      .run(`gate-${n}`, now);
  seed.close();
  const script = join(dataDir, "..", `${dataDir.split("/").pop()}-peer.js`);
  await writeFile(script, peerScript);

  const peer = Bun.spawn(["bun", script, join(dataDir, "forge.db")], { stdout: "pipe", stderr: "inherit" });
  await peer.stdout.getReader().read();

  const web = 20000 + Math.floor(Math.random() * 20000);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    FORGE_DATA: dataDir,
    PORT: String(web),
    FORGE_SSH_PORT: "0",
    FORGE_APPS: "0",
  };
  delete env.FORGE_URL;
  const forge = Bun.spawn(["bun", "run", "src/main.ts"], { env, stdout: "pipe", stderr: "pipe" });
  let out = "";
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) out += new TextDecoder().decode(chunk);
  };
  void drain(forge.stdout);
  void drain(forge.stderr);
  try {
    // Up: the first answer, however long the boot behind the lock took.
    let up = false;
    for (let i = 0; i < 300 && !up; i++) {
      try {
        up = (await fetch(`http://127.0.0.1:${web}/healthz`, { signal: AbortSignal.timeout(1_000) })).ok;
      } catch {
        await Bun.sleep(100);
      }
    }
    expect(up).toBe(true);
    // Then every probe answers within a second while the peer holds on, and after.
    const slow: number[] = [];
    const end = performance.now() + PEER_MS;
    while (performance.now() < end) {
      const t = performance.now();
      try {
        const res = await fetch(`http://127.0.0.1:${web}/healthz`, { signal: AbortSignal.timeout(1_000) });
        if (!res.ok) slow.push(-res.status);
      } catch {
        slow.push(Math.round(performance.now() - t));
      }
      await Bun.sleep(200);
    }
    // A probe that timed out: the forge's own log names what held it.
    if (slow.length > 0) console.log(out);
    expect(slow).toEqual([]);
    expect(out).toContain("another forge still works this database");
    await peer.exited;
    for (let i = 0; i < 100 && !out.includes("the other forge let go of this database"); i++) await Bun.sleep(100);
    expect(out).toContain("the other forge let go of this database");
    expect(out).not.toContain("event loop stalled");
  } finally {
    peer.kill();
    forge.kill();
    await Promise.all([peer.exited, forge.exited]);
    await rm(dataDir, { recursive: true, force: true });
    await rm(script, { force: true });
  }
}, 60_000);
