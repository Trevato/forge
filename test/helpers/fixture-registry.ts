/**
 * A registry on loopback serving one package, `fixture-pkg@1.0.0`, with the
 * sha512 integrity npm serves, so a lockfile bun writes against it is one
 * the shared cache's fill trusts (`checks/fillable.ts`). Counts its requests.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FixtureRegistry {
  readonly url: string;
  readonly hits: string[];
  readonly stop: () => void;
}

/** Serve `fixture-pkg@1.0.0` from a tarball built under `dir`. */
export async function fixtureRegistry(dir: string): Promise<FixtureRegistry> {
  mkdirSync(join(dir, "pkg", "package"), { recursive: true });
  writeFileSync(join(dir, "pkg", "package", "package.json"), JSON.stringify({ name: "fixture-pkg", version: "1.0.0" }));
  const made = Bun.spawnSync(["tar", "-czf", join(dir, "fixture.tgz"), "-C", join(dir, "pkg"), "package"]);
  if (made.exitCode !== 0) throw new Error("tar is needed for the fixture registry");
  const tarball = new Uint8Array(await Bun.file(join(dir, "fixture.tgz")).arrayBuffer());
  const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(tarball).digest("base64")}`;
  const hits: string[] = [];
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req): Response {
      const path = new URL(req.url).pathname;
      hits.push(path);
      if (path === "/fixture-pkg/-/fixture-pkg-1.0.0.tgz") return new Response(tarball);
      if (path === "/fixture-pkg")
        return Response.json({
          name: "fixture-pkg",
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              name: "fixture-pkg",
              version: "1.0.0",
              dist: { tarball: `http://127.0.0.1:${server.port}/fixture-pkg/-/fixture-pkg-1.0.0.tgz`, integrity },
            },
          },
        });
      return new Response("not found", { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}/`, hits, stop: () => void server.stop(true) };
}

/** The `bun.lock` bun writes for a package depending on `fixture-pkg@1.0.0` from `reg`. */
export async function fixtureLock(dir: string, reg: string): Promise<{ packageJson: string; lock: string }> {
  const co = join(dir, "lock-only");
  mkdirSync(co, { recursive: true });
  const packageJson = `${JSON.stringify({ name: "steps", version: "0.1.0", private: true, dependencies: { "fixture-pkg": "1.0.0" } })}\n`;
  writeFileSync(join(co, "package.json"), packageJson);
  // Async: the fixture registry answers from this process's event loop.
  const made = Bun.spawn(["bun", "install", "--lockfile-only"], {
    cwd: co,
    env: { PATH: process.env["PATH"] ?? "", HOME: dir, BUN_CONFIG_REGISTRY: reg, BUN_INSTALL_CACHE_DIR: join(dir, "lock-cache") },
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await made.exited) !== 0) throw new Error(`fixture lockfile: ${await new Response(made.stderr).text()}`);
  return { packageJson, lock: await Bun.file(join(co, "bun.lock")).text() };
}
