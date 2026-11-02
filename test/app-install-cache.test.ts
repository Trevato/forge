/**
 * An app environment installs from its repository's shared bun cache
 * (#7544): the forge fills it on the host from the lockfile, as checks do,
 * so a second environment of the same app at the same lockfile — a new
 * preview — installs with its registry dead. A checkout with no `bun.lock`
 * installs as it always did, into its own home.
 */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppManifest } from "../src/apps/manifest.ts";
import { installPlan, startProcess, type StartInput } from "../src/apps/process.ts";
import { fixtureRegistry } from "./helpers/fixture-registry.ts";

setDefaultTimeout(60_000);

const manifest: AppManifest = {
  run: `${process.execPath} server.ts`,
  install: "bun install --frozen-lockfile",
  test: null,
  health: "/",
  ready: 10,
  tty: null,
  service: null,
  looks: ["/"],
};

const SERVER = `Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response("ok") });\n`;

/** A registry on loopback serving one package, `fixture-pkg@1.0.0`; counts its requests. */
const registry = fixtureRegistry;

/** An app's checkout depending on the fixture, with the lockfile bun writes against it. */
async function checkout(dir: string, reg: string): Promise<string> {
  const co = join(dir, "first");
  mkdirSync(co);
  writeFileSync(join(co, "package.json"), JSON.stringify({ name: "x", version: "1.0.0", dependencies: { "fixture-pkg": "1.0.0" } }));
  writeFileSync(join(co, "server.ts"), SERVER);
  // Async: the fixture registry answers from this process's event loop.
  const made = Bun.spawn(["bun", "install", "--lockfile-only"], {
    cwd: co,
    env: { PATH: process.env["PATH"] ?? "", HOME: dir, BUN_CONFIG_REGISTRY: reg, BUN_INSTALL_CACHE_DIR: join(dir, "lock-cache") },
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await made.exited) !== 0) throw new Error(`fixture lockfile: ${await new Response(made.stderr).text()}`);
  return co;
}

/** Run `body` with the forge's own environment pointing bun at `url`, as an operator's mirror would. */
async function withRegistry<T>(url: string, body: () => Promise<T>): Promise<T> {
  const before = process.env["BUN_CONFIG_REGISTRY"];
  process.env["BUN_CONFIG_REGISTRY"] = url;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env["BUN_CONFIG_REGISTRY"];
    else process.env["BUN_CONFIG_REGISTRY"] = before;
  }
}

async function start(dir: string, extra: Partial<StartInput>, lines: string[]): Promise<boolean> {
  const started = await startProcess({
    dir,
    dataDir: dir,
    manifest,
    env: "production",
    url: "http://app.test",
    commitOid: "0".repeat(40),
    forgeUrl: "http://forge.test",
    identityKey: "key",
    log: (line) => lines.push(line),
    signal: new AbortController().signal,
    ...extra,
  });
  if (started.ok) await started.value.handle.stop();
  return started.ok;
}

describe("an app environment's install (#7544)", () => {
  test("a second environment at the same lockfile installs from the shared cache with the registry dead", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-install-cache-"));
    const reg = await registry(root);
    try {
      const first = await checkout(root, reg.url);
      const second = join(root, "second");
      cpSync(first, second, { recursive: true });
      const cache = join(root, "shared", "bun");
      const lines: string[] = [];

      expect(await withRegistry(reg.url, () => start(first, { installCache: cache }, lines))).toBe(true);
      expect(reg.hits).toContain("/fixture-pkg/-/fixture-pkg-1.0.0.tgz");
      expect(existsSync(join(first, "node_modules", "fixture-pkg", "package.json"))).toBe(true);
      // The repository's cache holds it, not the environment's home.
      expect(readdirSync(cache).some((name) => name.startsWith("fixture-pkg@"))).toBe(true);

      reg.stop();
      reg.hits.length = 0;
      const again: string[] = [];
      expect(await withRegistry(reg.url, () => start(second, { installCache: cache }, again))).toBe(true);
      expect(existsSync(join(second, "node_modules", "fixture-pkg", "package.json"))).toBe(true);
      expect(reg.hits).toEqual([]);
      expect(existsSync(`${cache}.lock`)).toBe(false);
    } finally {
      reg.stop();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a checkout with no bun.lock installs as before, without the shared cache", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-install-cache-"));
    try {
      writeFileSync(join(root, "server.ts"), SERVER);
      const cache = join(root, "shared", "bun");
      const lines: string[] = [];
      const ok = await start(
        root,
        {
          installCache: cache,
          manifest: { ...manifest, install: `printf '%s' "\${BUN_INSTALL_CACHE_DIR:-none}" > seen` },
        },
        lines,
      );
      expect(ok).toBe(true);
      expect(readFileSync(join(root, "seen"), "utf8")).toBe("none");
      expect(lines).toContain("cache not filled: no bun lockfile in the checkout");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a fill that fails does not fail the deploy: the install runs into its home as before", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-install-cache-"));
    const reg = await registry(root);
    try {
      const co = await checkout(root, reg.url);
      // A cold cache and a dead registry: the fill cannot fetch.
      reg.stop();
      const cache = join(root, "shared", "bun");
      const lines: string[] = [];
      const ok = await withRegistry(reg.url, () =>
        start(
          co,
          {
            installCache: cache,
            manifest: { ...manifest, install: `printf '%s' "\${BUN_INSTALL_CACHE_DIR:-none}" > seen` },
          },
          lines,
        ),
      );
      expect(ok).toBe(true);
      expect(readFileSync(join(co, "seen"), "utf8")).toBe("none");
      expect(lines.some((line) => line.startsWith("cache not filled: filling the install cache exited"))).toBe(true);
      expect(existsSync(`${cache}.lock`)).toBe(false);
    } finally {
      reg.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the install's plan (#7544)", () => {
  const input = (extra: Partial<StartInput>): StartInput => ({
    dir: "/co",
    dataDir: "/data",
    manifest,
    env: "pull-7",
    url: "http://app.test",
    commitOid: "0".repeat(40),
    forgeUrl: "http://forge.test",
    identityKey: "key",
    log: () => {},
    signal: new AbortController().signal,
    ...extra,
  });
  const cell = { hide: ["/data"], home: "/homes/app" };
  const env = { PATH: "/bin" };

  test("in a cell, a filled cache is revealed read-only and the install copies from it", () => {
    const plan = installPlan("bun install --frozen-lockfile", input({ cell, installCache: "/cache/bun" }), env, true);
    expect(plan.cell?.reveal).toEqual(["/cache/bun"]);
    expect(plan.cell?.writable).toEqual([]);
    expect(plan.cell?.home).toBe("/homes/app");
    expect(plan.command).toBe("bun install --backend=copyfile --frozen-lockfile");
    expect(plan.env).toEqual({ PATH: "/bin", BUN_INSTALL_CACHE_DIR: "/cache/bun" });
    expect(plan.lock).toBeUndefined();
  });

  test("uncontained, a filled cache is read under its lock", () => {
    const plan = installPlan("bun install", input({ installCache: "/cache/bun" }), env, true);
    expect(plan.cell).toBeUndefined();
    expect(plan.command).toBe("bun install");
    expect(plan.env["BUN_INSTALL_CACHE_DIR"]).toBe("/cache/bun");
    expect(plan.lock).toBe("/cache/bun.lock");
  });

  test("an unfilled cache, or none, leaves the install as it was", () => {
    for (const plan of [
      installPlan("bun install", input({ cell, installCache: "/cache/bun" }), env, false),
      installPlan("bun install", input({ cell }), env, true),
    ]) {
      expect(plan.command).toBe("bun install");
      expect(plan.env).toEqual(env);
      expect(plan.cell?.reveal).toBeUndefined();
      expect(plan.lock).toBeUndefined();
    }
  });
});
