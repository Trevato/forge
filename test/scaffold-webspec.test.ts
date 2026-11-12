/**
 * A freshly scaffolded app is held to the website specification (#3041).
 * The scaffold is written out, booted on a loopback port, and `webspec()`
 * reads `/` and the site files. The findings' checks must equal KNOWN: a
 * new gap fails, and so does a fixed gap still listed.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bakedFiles as scaffoldFiles } from "../src/apps/template.ts";
import { webspec, type Finding } from "../src/release/webspec.ts";

/** Today's gaps, each with its specification.website section. None: the scaffold meets it. */
const KNOWN: string[] = [];

let dir: string;
let child: ReturnType<typeof Bun.spawn> | undefined;
let findings: Finding[] = [];
let served: Headers = new Headers();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-scaffold-webspec-"));
  for (const f of scaffoldFiles({ name: "field-notes", description: "" })) {
    const path = join(dir, f.path);
    await mkdir(dirname(path), { recursive: true });
    if (f.content !== null) await writeFile(path, f.content);
  }
  const port = 20000 + Math.floor(Math.random() * 20000);
  child = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      PORT: String(port),
      FORGE_APP_DATA: join(dir, "data"),
      FORGE_APP_URL: `http://127.0.0.1:${port}`,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  const end = Date.now() + 15_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {}
    if (Date.now() > end) throw new Error("the scaffold did not boot");
    await Bun.sleep(50);
  }
  served = (await fetch(`${base}/`)).headers;
  findings = await webspec(base, ["/"], fetch, { site: true });
}, 30_000);

afterAll(async () => {
  child?.kill();
  await child?.exited;
  await rm(dir, { recursive: true, force: true });
});

test("a fresh scaffold's webspec findings are exactly the known gaps", () => {
  const got = [...new Set(findings.map((f) => f.check))].sort();
  expect(got).toEqual([...KNOWN].sort());
});

test("a fresh scaffold sends Cross-Origin-Opener-Policy: same-origin", () => {
  expect(findings.map((f) => f.check)).not.toContain("coop");
  expect(served.get("cross-origin-opener-policy")).toBe("same-origin");
});
