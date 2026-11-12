/**
 * Anonymous code pages at a rate, on a copy shaped like production (#9514).
 *
 * Boots a throwaway forge in this process with the Shield at its default
 * (`ceiling`: every stranger budget in force), and pushes this clone's own
 * history into one public repository: the forge's biggest
 * repository on production is this one, so its folders, file sizes and
 * languages are production's shape. Then runs bench/load.ts against it with
 * the edge bypassed (there is no edge in-process), spread over `--addresses`
 * made-up strangers, and prints its result.
 *
 *   bun bench/code-pages-at-rate.ts --rate 500 --seconds 20 --addresses 4000 --crawl 3000 \
 *     --out bench/results/9514-in-process-bypass.json
 *
 * What it is not: the edge run. That one needs the real deployment and is run
 * with bench/load.ts against it (docs/features/load-test.md).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve } from "../src/http/server.ts";

const arg = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(`--${name}`);
  const v = at >= 0 ? process.argv[at + 1]! : fallback;
  if (!(Number(v) >= 0)) throw new Error(`bad --${name}`);
  return v;
};
const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : undefined;
const root = join(import.meta.dir, "..");

const dataDir = await mkdtemp(join(tmpdir(), "forge-code-rate-"));
const app = createApp({ dataDir, port: 0 });
const servers = await serve(app);
try {
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "trevato", email: "t@forge.local", password: "a-good-passphrase", isAdmin: true });
  if (!u.ok) throw new Error(u.error);
  const r = await createRepo(app, u.value, { name: "forge", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  // The clone's own history, fetched whole (a fetch runs no receive hook): every folder, file and commit as the forge holds them.
  const pushed = Bun.spawnSync(["git", "--git-dir", repoDir(app.reposRoot, "trevato", "forge"), "fetch", "--quiet", root, "HEAD:refs/heads/main"], { cwd: root, stderr: "pipe" });
  if (pushed.exitCode !== 0) throw new Error(`copying the clone failed: ${pushed.stderr.toString()}`);
  const files = Bun.spawnSync(["git", "ls-files"], { cwd: root }).stdout.toString().split("\n").length - 1;
  console.error(`copy: trevato/forge with ${files} files at ${Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim()}`);

  const args = ["--url", servers.url, "--repo", "trevato/forge", "--bypass", "--version", "in-process"];
  for (const name of ["rate", "seconds", "addresses", "crawl", "warm"]) args.push(`--${name}`, arg(name, { rate: "500", seconds: "20", addresses: "4000", crawl: "3000", warm: "0" }[name]!));
  if (out !== undefined) args.push("--out", out);
  const load = Bun.spawn(["bun", join(import.meta.dir, "load.ts"), ...args], {
    // Bun's fetch holds a few hundred requests a process by default; an open loop must not queue in the client.
    env: { BUN_CONFIG_MAX_HTTP_REQUESTS: "65000", ...process.env },
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exitCode = await load.exited;
} finally {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
}
