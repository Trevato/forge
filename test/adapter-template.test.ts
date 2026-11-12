/**
 * The adapter template (examples/adapter-template, docs/ADAPTERS.md) stays a
 * working adapter: its own suite runs here, in the forge's check, as the
 * template would run it (`bun test` in its own directory), and its manifest
 * is one the forge accepts, with every source host opened by egress.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseManifest } from "../src/apps/manifest.ts";
import { SOURCE } from "../examples/adapter-template/src/source.ts";

const TEMPLATE = join(import.meta.dir, "..", "examples", "adapter-template");

function templateManifest() {
  const m = parseManifest(readFileSync(join(TEMPLATE, "forge.json"), "utf8"), undefined);
  if (!m.ok) throw new Error(m.error.kind === "invalid" ? m.error.message : m.error.kind);
  return m.value;
}

describe("the adapter template", () => {
  test("its forge.json parses, with an adapter block", () => {
    expect(templateManifest().adapter).toEqual({ schedule: { every: 3600 } });
  });

  test("every source host is in egress", () => {
    expect(SOURCE.hosts.length).toBeGreaterThan(0);
    const egress = templateManifest().egress;
    for (const host of SOURCE.hosts) expect(egress).toContain(host);
  });

  test("has no dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(TEMPLATE, "package.json"), "utf8")) as Record<string, unknown>;
    expect(pkg["dependencies"]).toBeUndefined();
    expect(pkg["devDependencies"]).toBeUndefined();
  });

  test("its own tests pass", () => {
    const run = Bun.spawnSync([process.execPath, "test"], {
      cwd: TEMPLATE,
      stdout: "pipe",
      stderr: "pipe",
    });
    const log = run.stderr.toString() + run.stdout.toString();
    if (run.exitCode !== 0) throw new Error(`examples/adapter-template: bun test failed\n${log}`);
    expect(log).toMatch(/\b0 fail\b/);
    expect(log).not.toMatch(/\b0 pass\b/);
  }, 30_000);
});
