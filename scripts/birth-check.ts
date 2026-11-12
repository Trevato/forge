/**
 * `bun scripts/birth-check.ts <checkout>`: the second half of a template
 * pull's check (#10305). Births an app from the checkout's tracked files
 * exactly as New app does (`fillTemplate`), writes it to a scratch
 * directory, boots it on a free port with its own data directory and waits
 * for `/healthz`. The template's own `bun test` is the first half and runs
 * in the checkout itself. Exits 0 when the born app answers, 1 when not.
 */

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fillTemplate } from "../src/apps/template.ts";

const [dir] = process.argv.slice(2);
if (dir === undefined) {
  console.error("usage: bun scripts/birth-check.ts <checkout>");
  process.exit(2);
}
const listed = Bun.spawnSync(["git", "-C", dir, "ls-files", "-z"], { stdout: "pipe", stderr: "pipe" });
if (listed.exitCode !== 0) {
  console.error(`birth-check: not a git checkout: ${listed.stderr.toString().trim()}`);
  process.exit(1);
}
const paths = listed.stdout.toString().split("\0").filter((p) => p !== "");
const files = await Promise.all(paths.map(async (path) => ({ path, content: new Uint8Array(await Bun.file(join(dir, path)).arrayBuffer()) })));
const born = fillTemplate({ files, from: "checkout", commit: "" }, { name: "born-from-template", description: "Born in the template check." });
if (born === undefined) {
  console.error("birth-check: template.json is missing or unreadable");
  process.exit(1);
}

const work = await mkdtemp(join(process.env["TMPDIR"] ?? tmpdir(), "birth-check-"));
let child: ReturnType<typeof Bun.spawn> | undefined;
try {
  for (const f of born) {
    const to = join(work, "app", f.path);
    await mkdir(dirname(to), { recursive: true });
    await Bun.write(to, f.content ?? "");
  }
  // Port 0 asks the kernel for a free one; the app is told it only after the
  // probe socket is closed, so a port taken in between is retried, not fatal.
  let up = false;
  let port = 0;
  for (let attempt = 0; attempt < 3 && !up; attempt++) {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    port = probe.port;
    probe.stop(true);
    child = Bun.spawn(["bun", "run", "src/server.ts"], {
      cwd: join(work, "app"),
      env: { PATH: process.env["PATH"] ?? "", PORT: String(port), FORGE_APP_DATA: join(work, "data"), FORGE_APP_ENV: "preview" },
      stdout: "ignore",
      stderr: "inherit",
    });
    for (let i = 0; i < 100 && !up && child.exitCode === null; i++) {
      await Bun.sleep(100);
      up = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
    }
    if (!up) child.kill();
  }
  const home = up ? await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text(), () => "") : "";
  if (!up || !home.includes("born-from-template")) {
    console.error(`birth-check: the born app ${up ? "answers / without its name" : "did not answer /healthz"}`);
    process.exitCode = 1;
  } else console.log(`birth-check: born from ${paths.length} files, booted, / answers`);
} finally {
  child?.kill();
  await rm(work, { recursive: true, force: true });
}
