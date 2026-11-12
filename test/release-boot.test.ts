/**
 * A release that does not boot is refused before it ships (#2652): the
 * build and the promote preflight both run `src/release/boot.ts`, which
 * starts the tree on a scratch data directory and wants `/api/v1/health` to
 * answer as the stamped version. 0.7.166's image crashed at import; a tree
 * that does the same is refused here, naming the error.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, existsSync, readFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PORT_RETRIES } from "../src/kernel/port.ts";
import { bootRestored } from "../src/snapshot/boot.ts";
import { bootProof, parseArgs, proveBoot, why } from "../src/release/boot.ts";

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "forge-release-boot-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A tree whose `src/main.ts` is `main`. */
function tree(name: string, main: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "main.ts"), main);
  return dir;
}

/** A forge in miniature: health answers with whatever `version()` says. */
const serving = (version: string) => `
Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch(req) {
  if (new URL(req.url).pathname !== "/api/v1/health") return new Response("", { status: 404 });
  return Response.json({ ok: true, version: ${version} });
} });
`;

test("a tree whose main import throws is refused, naming the module it could not find", async () => {
  const dir = tree("broken", `import { smoke } from "../../scripts/smoke.ts";\nconsole.log(smoke);\n`);
  const result = await proveBoot({ tree: dir, version: "0.7.166", budgetMs: 30_000 });
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.line).toStartWith("exited with 1 before it answered health: ");
    expect(result.line).toContain("Cannot find module '../../scripts/smoke.ts'");
  }
});

test("a tree that answers as its version passes; the scratch directory is gone after", async () => {
  const dir = tree("well", serving("process.env.FORGE_VERSION"));
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith("boot-proof-")).length;
  const result = await proveBoot({ tree: dir, version: "1.2.3", budgetMs: 30_000 });
  expect(result).toMatchObject({ ok: true });
  expect(readdirSync(tmpdir()).filter((n) => n.startsWith("boot-proof-")).length).toBe(before);
});

test("an answer as another version is not a pass: the budget runs out and says what it saw", async () => {
  const dir = tree("stale", serving(`"0.0.1"`));
  const result = await bootProof({ tree: dir, version: "1.2.3", dataDir: join(root, "stale-data"), budgetMs: 2_000 });
  expect(result).toEqual({ ok: false, line: "did not answer health as 1.2.3 within 2s (health answered as 0.0.1)" });
});

test("--from boots a copy of the live data: the database as it is, the top-level files, never the live directory", async () => {
  const live = join(root, "live");
  mkdirSync(join(live, "repos", "a"), { recursive: true });
  writeFileSync(join(live, "secret.key"), "k", { mode: 0o600 });
  const db = new Database(join(live, "forge.db"), { create: true });
  db.run("PRAGMA journal_mode=WAL");
  db.run("CREATE TABLE stamp (v TEXT)");
  db.run("INSERT INTO stamp VALUES ('4.5.6')");
  // Held open, as the running forge holds it: the row is in the log, not yet the file.
  const dir = tree(
    "copied",
    `import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
const data = process.env.FORGE_DATA!;
if (readFileSync(data + "/secret.key", "utf8") !== "k" || existsSync(data + "/repos")) process.exit(3);
const v = new Database(data + "/forge.db").query("SELECT v FROM stamp").get().v;
${serving("v")}`,
  );
  try {
    expect(await proveBoot({ tree: dir, version: "4.5.6", from: live, budgetMs: 30_000 })).toMatchObject({ ok: true });
  } finally {
    db.close();
  }
  expect(readdirSync(live).sort()).toEqual(["forge.db", "repos", "secret.key"]);
  expect(await proveBoot({ tree: dir, version: "4.5.6", from: join(root, "nowhere") })).toEqual({
    ok: false,
    line: `${join(root, "nowhere")} holds no forge.db to copy`,
  });
});

test("this tree, shipped as the image ships it (src/ alone), boots", async () => {
  const image = join(root, "image");
  const repo = join(import.meta.dir, "..");
  cpSync(join(repo, "src"), join(image, "src"), { recursive: true });
  for (const file of ["package.json", "tsconfig.json"]) cpSync(join(repo, file), join(image, file));
  // The Dockerfile copies the OpenCode plugin too: src/http/plugin_routes.ts reads it at boot (#10274).
  cpSync(join(repo, "plugins", "opencode"), join(image, "plugins", "opencode"), { recursive: true });
  expect(existsSync(join(image, "scripts"))).toBe(false);
  const result = await proveBoot({ tree: image, version: "9.9.9", budgetMs: 60_000 });
  expect(result).toMatchObject({ ok: true });
}, 90_000);

test("the reason is the error line, one line, bounded", () => {
  expect(why("\n1 | import x\n    ^\nerror: Cannot find module 'x'\n    at y\n\nBun v1.3\n")).toBe("error: Cannot find module 'x'");
  expect(why("just died\n")).toBe("just died");
  expect(why("")).toBe("");
  expect(why("x".repeat(500)).length).toBe(300);
});

test("arguments: --from and --budget, nothing else", () => {
  expect(parseArgs([])).toEqual({ budgetMs: 120_000 });
  expect(parseArgs(["--from", "/data", "--budget", "60"])).toEqual({ from: "/data", budgetMs: 60_000 });
  for (const bad of [["--from"], ["--budget", "0"], ["--budget", "1e3"], ["--nope"], ["/data"]])
    expect(typeof parseArgs(bad)).toBe("string");
});

test("the build runs the proof on the image it built, and the chart runs it on a copy before an upgrade", async () => {
  const repo = join(import.meta.dir, "..");
  const docker = await Bun.file(join(repo, "Dockerfile")).text();
  const lines = docker.split("\n");
  const copied = lines.findIndex((l) => l.startsWith("COPY src "));
  const proved = lines.indexOf("RUN bun src/release/boot.ts");
  expect(copied).toBeGreaterThan(-1);
  expect(proved).toBeGreaterThan(copied);
  expect(proved).toBeGreaterThan(lines.findIndex((l) => l.startsWith("ENV FORGE_VERSION=")));
  const hook = await Bun.file(join(repo, "charts/app/templates/boot-proof.yaml")).text();
  expect(hook).toContain("helm.sh/hook: pre-upgrade");
  expect(hook).toContain('command: ["bun", "src/release/boot.ts", "--from", "/data", "--budget", "180"]');
  expect(hook).toContain("claimName: {{ .Release.Name }}-data");
  expect(hook).toContain("backoffLimit: 0");
});

/** A tree whose main logs one line per run to `counter`, then dies saying `stderr`. */
function dying(name: string, stderr: string): { dir: string; runs: () => number } {
  const counter = join(root, `${name}.count`);
  const dir = tree(
    name,
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(counter)}, "run\\n");\nconsole.error(${JSON.stringify(stderr)});\nprocess.exit(1);\n`,
  );
  return { dir, runs: () => (existsSync(counter) ? readFileSync(counter, "utf8").split("\n").length - 1 : 0) };
}

test("bootProof starts again on a fresh port while the child lost its port, and gives up after PORT_RETRIES", async () => {
  const t = dying("lost-proof", "error: address already in use");
  const result = await bootProof({ tree: t.dir, version: "1.0.0", dataDir: root, budgetMs: 30_000 });
  expect(result.ok).toBe(false);
  expect(t.runs()).toBe(PORT_RETRIES + 1);
});

test("bootProof does not retry a child that died for another reason", async () => {
  const t = dying("other-proof", "TypeError: x");
  const result = await bootProof({ tree: t.dir, version: "1.0.0", dataDir: root, budgetMs: 30_000 });
  expect(result.ok).toBe(false);
  expect(t.runs()).toBe(1);
});

test("bootRestored retries a lost port and not another failure", async () => {
  const lost = dying("lost-restored", "error: address already in use");
  expect((await bootRestored(root, 30_000, lost.dir)).ok).toBe(false);
  expect(lost.runs()).toBe(PORT_RETRIES + 1);
  const other = dying("other-restored", "TypeError: x");
  expect((await bootRestored(root, 30_000, other.dir)).ok).toBe(false);
  expect(other.runs()).toBe(1);
});
