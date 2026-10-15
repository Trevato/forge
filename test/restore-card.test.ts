/**
 * The restore card (`docs/RESTORE.md`) runs. Its numbered command lines are
 * parsed out of the document and executed, in order, against a snapshot
 * taken here into a temporary directory; a card that drifts from the
 * command goes red. Only the lines marked `# network` (clone, install) and
 * `# boot` (start the forge) are skipped, and the test names them so a line
 * cannot dodge the run by being marked.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { takeSnapshot } from "../src/snapshot/snapshot.ts";

const PASS = "correct horse battery staple";
const card = readFileSync(join(import.meta.dir, "../docs/RESTORE.md"), "utf8");
const lines = [...card.matchAll(/^(\d+)\. `(.+)`$/gm)].map((m) => ({
  n: Number(m[1]),
  text: m[2]!,
}));

let root: string;
let app: App;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-restore-card-"));
  app = createApp({ dataDir: join(root, "live"), port: 0 });
  const u = await createUser(app.db, {
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  const repo = await createRepo(app, u.value, { name: "notes", visibility: "private" });
  if (!repo.ok) throw new Error(String(repo.error));
  const c = await commitToBranch(app, u.value, repo.value, {
    message: "first",
    files: [{ path: "README.md", content: "# notes\n" }],
  });
  if (!c.ok) throw new Error(JSON.stringify(c.error));
  await takeSnapshot(
    {
      db: app.db,
      dataDir: app.config.dataDir,
      reposRoot: app.reposRoot,
      version: "t",
      passphrase: PASS,
    },
    dirStore(join(root, "store")),
    new Date("2026-09-22T08:00:00Z"),
  );
});

afterAll(async () => {
  app.close();
  await rm(root, { recursive: true, force: true });
});

test("the card is at most ten numbered lines, in order", () => {
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.length).toBeLessThanOrEqual(10);
  expect(lines.map((l) => l.n)).toEqual(lines.map((_, i) => i + 1));
});

test("only network and boot lines are skipped, and they are the known ones", () => {
  const skipped = lines.filter((l) => /# (network|boot)$/.test(l.text));
  expect(skipped.map((l) => l.text.replace(/ # (network|boot)$/, "")).sort()).toEqual([
    "FORGE_DATA=<data-dir> bun run src/main.ts",
    "bun install",
    "git clone https://forge.open-platform.sh/trevato/forge.git forge && cd forge",
  ]);
});

test("the card's own lines restore the snapshot into an empty directory", async () => {
  const store = join(root, "store");
  const data = join(root, "restored");
  const script = lines
    .filter((l) => !/# (network|boot)$/.test(l.text))
    .map((l) =>
      l.text
        .replaceAll("<store-dir>", store)
        .replaceAll("<data-dir>", data)
        .replaceAll("<passphrase>", PASS),
    );
  for (const l of script) expect(l).not.toMatch(/<[a-z-]+>/);
  const run = Bun.spawnSync(["sh", "-ec", script.join("\n")], {
    cwd: join(import.meta.dir, ".."),
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = run.stdout.toString() + run.stderr.toString();
  expect(out).toContain("restored 2026-09-22T08-00-00Z");
  expect(run.exitCode).toBe(0);
  expect(existsSync(join(data, "forge.db"))).toBe(true);
  expect(existsSync(join(data, "repos"))).toBe(true);
});
