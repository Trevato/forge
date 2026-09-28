/**
 * The app a new app starts as keeps its own promises. The scaffold is
 * written out as a person would get it, and its own suite runs there: the
 * tokens compile and nothing spells out a colour, every change leaves an
 * audit row, the committed API description is what the routes say, the
 * door refuses a stranger before the body, `/healthz` answers. Then the
 * two scripts the app ships run as a person would run them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseManifest } from "../src/apps/manifest.ts";
import { scaffoldFiles } from "../src/apps/scaffold.ts";

/** A child that inherits nothing it was not handed. */
const run = async (
  cwd: string,
  argv: string[],
): Promise<{ code: number; out: string }> => {
  const child = Bun.spawn(argv, {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? cwd,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out: out + err };
};

describe("a scaffolded app, written out and run on its own", () => {
  let dir: string;
  const files = scaffoldFiles({ name: "field-notes", description: "" });
  const content = (path: string): string => {
    const file = files.find((f) => f.path === path);
    if (file === undefined || typeof file.content !== "string")
      throw new Error(`scaffold has no text file at ${path}`);
    return file.content;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-scaffold-"));
    for (const file of files) {
      const path = join(dir, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content as string);
    }
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  test("its own suite is green", async () => {
    const { code, out } = await run(dir, [process.execPath, "test"]);
    expect([code, out.includes(" 0 fail")]).toEqual([0, true]);
    // Each guarantee has its own file of tests in the suite.
    for (const name of [
      "design.test.ts",
      "audit.test.ts",
      "openapi.test.ts",
      "security.test.ts",
      "server.test.ts",
      "contract.test.ts",
    ])
      expect(out).toContain(name);
  }, 60_000);

  test("the design lint passes, and refuses a colour spelled out", async () => {
    expect(
      (await run(dir, [process.execPath, "run", "lint:design"])).code,
    ).toBe(0);
    const css = join(dir, "static", "app.css");
    const before = await readFile(css, "utf8");
    await writeFile(css, `${before}\n.oops { color: #ff0000; }\n`);
    const refused = await run(dir, [process.execPath, "run", "lint:design"]);
    await writeFile(css, before);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("static/app.css");
    expect(refused.out).toContain("raw colour #ff0000");
  }, 30_000);

  test("the committed API description is exactly what contract:emit writes", async () => {
    const committed = content("contract/openapi.json");
    const emitted = await run(dir, [process.execPath, "run", "contract:emit"]);
    expect(emitted.code).toBe(0);
    expect(await readFile(join(dir, "contract", "openapi.json"), "utf8")).toBe(
      committed,
    );
    const doc = JSON.parse(committed) as {
      info: { title: string; description: string };
    };
    expect(doc.info).toMatchObject({
      title: "field-notes",
      description: "A new app on the forge.",
    });
  }, 30_000);

  test("it typechecks under strict settings, with the forge's own type definitions", async () => {
    // The app ships no dependencies, so the checker borrows the forge's
    // Bun types; the app's code itself must be clean under the same strictness
    // the forge holds itself to.
    const root = fileURLToPath(new URL("..", import.meta.url));
    const sources = [
      ...(await readdir(join(dir, "src"))).map((f) => join("src", f)),
      ...(await readdir(join(dir, "scripts"))).map((f) => join("scripts", f)),
    ].filter((f) => f.endsWith(".ts"));
    const { code, out } = await run(dir, [
      process.execPath,
      "x",
      "tsc",
      "--noEmit",
      "--strict",
      "--target",
      "esnext",
      "--module",
      "esnext",
      "--moduleResolution",
      "bundler",
      "--allowImportingTsExtensions",
      "--noUncheckedIndexedAccess",
      "--exactOptionalPropertyTypes",
      "--types",
      "bun-types",
      "--typeRoots",
      `${root}node_modules/@types,${root}node_modules`,
      ...sources,
    ]);
    expect([code, out.trim()]).toEqual([0, ""]);
  }, 120_000);

  test("forge.json points the forge's health poll at /healthz", () => {
    const manifest = parseManifest(
      content("forge.json"),
      content("package.json"),
    );
    expect(manifest.ok).toBe(true);
    if (manifest.ok) expect(manifest.value.health).toBe("/healthz");
  });
});
