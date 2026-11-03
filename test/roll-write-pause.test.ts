/**
 * Two forges on one data directory across a roll (#7799). The old one has a
 * check running and a merge-queue gate in flight; on SIGTERM it gives them
 * its drain budget, then hands them back queued and lets go. The new one,
 * booted beside it, holds its own queue work only until then: `waitForPeer`
 * returns well inside 30 s, and the check is queued again for the new forge.
 */

import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../src/app.ts";

const SRC = resolve(import.meta.dir, "../src");

/** The old forge in miniature: the real checks service and gate lane on the shared data, nothing else. */
const oldForge = `
const { createApp } = require(${JSON.stringify(SRC + "/app.ts")});
const { openPull } = require(${JSON.stringify(SRC + "/actions/pulls.ts")});
const { commitToBranch, createRepo } = require(${JSON.stringify(SRC + "/actions/repos.ts")});
const { gateCandidate } = require(${JSON.stringify(SRC + "/checks/landing.ts")});
const { startChecks } = require(${JSON.stringify(SRC + "/checks/service.ts")});
const { getPull } = require(${JSON.stringify(SRC + "/core/pulls.ts")});
const { createUser } = require(${JSON.stringify(SRC + "/core/users.ts")});
const { repoDir } = require(${JSON.stringify(SRC + "/git/repos.ts")});
const { drainBudgets } = require(${JSON.stringify(SRC + "/drain.ts")});
(async () => {
  const app = createApp({ dataDir: process.argv[2], port: 0 });
  const checks = startChecks(app, { forgeUrl: "http://127.0.0.1:1", concurrency: 2, drainMs: drainBudgets(process.env).checksMs });
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  const repo = (await createRepo(app, a.value, { name: "roll", visibility: "public" })).value;
  await commitToBranch(app, a.value, repo, { message: "Start", files: [{ path: "forge.json", content: JSON.stringify({ check: { run: "sleep 120", fast: "true", full: "sleep 120" } }) }] });
  await commitToBranch(app, a.value, repo, { branch: "feature", message: "Touch", files: [{ path: "b.txt", content: "b\\n" }] });
  const opened = await openPull(app, a.value, repo, { title: "Feature", baseBranch: "main", headBranch: "feature" });
  const pull = getPull(app.db, repo.id, opened.value.number);
  void gateCandidate(app, repo, pull, repoDir(app.reposRoot, repo.ownerName, repo.name), pull.headOid);
  process.on("SIGTERM", async () => {
    await checks.stop({ drain: true });
    app.close();
    console.log("old forge let go");
    process.exit(0);
  });
  const t = setInterval(() => {
    const running = app.db.query("SELECT COUNT(*) AS n FROM run WHERE state = 'running'").get().n;
    const gating = checks.adopt(pull.headOid) !== undefined;
    if (running > 0 && gating) { clearInterval(t); console.log("old forge up"); }
  }, 100);
})();
`;

test("the new forge starts its queue work within 30 s of SIGTERM to the old, with a gate and a check still in flight", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-rollpause-"));
  const script = join(dataDir, "..", `${dataDir.split("/").pop()}-old.js`);
  await writeFile(script, oldForge);
  const old = Bun.spawn(["bun", script, dataDir], {
    env: { ...(process.env as Record<string, string>), FORGE_CELLS: "off", FORGE_CHECKS_DRAIN_S: "3" },
    stdout: "pipe",
    stderr: "inherit",
  });
  const oldOut = old.stdout.getReader();
  let new_ = undefined as ReturnType<typeof Bun.spawn> | undefined;
  try {
    let said = "";
    const upDeadline = Date.now() + 60_000;
    while (!said.includes("old forge up") && Date.now() < upDeadline) {
      const { value, done } = await oldOut.read();
      if (done) break;
      said += new TextDecoder().decode(value);
    }
    expect(said).toContain("old forge up");

    const web = 20000 + Math.floor(Math.random() * 20000);
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      FORGE_DATA: dataDir,
      PORT: String(web),
      FORGE_SSH_PORT: "0",
      FORGE_APPS: "0",
      FORGE_CELLS: "off",
    };
    delete env.FORGE_URL;
    const forge = Bun.spawn(["bun", "run", "src/main.ts"], { env, stdout: "pipe", stderr: "pipe" });
    new_ = forge;
    let out = "";
    const collect = async (stream: ReadableStream<Uint8Array>) => {
      for await (const chunk of stream) out += new TextDecoder().decode(chunk);
    };
    void collect(forge.stdout as ReadableStream<Uint8Array>);
    void collect(forge.stderr as ReadableStream<Uint8Array>);
    for (let i = 0; i < 300 && !out.includes("another forge still works this database"); i++) await Bun.sleep(100);
    expect(out).toContain("another forge still works this database");

    const signalled = Date.now();
    old.kill("SIGTERM");
    for (let i = 0; i < 300 && !out.includes("the other forge let go of this database"); i++) await Bun.sleep(100);
    if (!out.includes("the other forge let go of this database")) throw new Error(`never came: still waiting while !out.includes("the other forge let go of this database")`);
    const pause = Date.now() - signalled;
    if (pause >= 30_000) console.log(out);
    expect(out).toContain("the other forge let go of this database");
    expect(pause).toBeLessThan(30_000);
    await old.exited;

    // The check the old forge cut off is queued again, for the new one to take.
    forge.kill();
    await forge.exited;
    const app = createApp({ dataDir, port: 0 });
    try {
      const states = app.db.query<{ state: string }, []>("SELECT state FROM run WHERE kind = 'check'").all().map((r) => r.state);
      expect(states.length).toBeGreaterThan(0);
      expect(states).not.toContain("failed");
    } finally {
      app.close();
    }
  } finally {
    old.kill("SIGKILL");
    new_?.kill("SIGKILL");
    await rm(dataDir, { recursive: true, force: true });
    await rm(script, { force: true });
  }
}, 120_000);
