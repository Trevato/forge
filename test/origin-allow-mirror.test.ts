/**
 * A host the operator names in `FORGE_ORIGIN_ALLOW` is one an origin may be
 * connected from, so it is one that origin may be mirrored from too. Before,
 * discovery let such a host through and the mirror's git refused it as a
 * private address: the origin connected, and every mirror, sync and fetch
 * from it then failed. The mirror now trusts that name the way it trusts
 * `FORGE_OUTBOUND_TRUSTED_HOSTS`: by name, pinned to the answer that passed,
 * never by address.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join, normalize } from "node:path";
import {
  fetchMirror,
  MIRROR_REFUSED,
  provideMirrorOutboundForTest,
  vettedEnv,
} from "../src/origins/git-mirror.ts";
import { loadTrustedHosts } from "../src/origins/trusted-hosts.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const inCluster = async () => ["10.43.191.15"];

/** Run `fn` with `FORGE_ORIGIN_ALLOW` set (or unset), and put it back. */
async function withAllow<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env.FORGE_ORIGIN_ALLOW;
  if (value === undefined) delete process.env.FORGE_ORIGIN_ALLOW;
  else process.env.FORGE_ORIGIN_ALLOW = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.FORGE_ORIGIN_ALLOW;
    else process.env.FORGE_ORIGIN_ALLOW = before;
  }
}

/** The address git is pinned to, from the environment the mirror hands it. */
function pinOf(env: Record<string, string>): string | undefined {
  for (let i = 0; i < Number(env["GIT_CONFIG_COUNT"] ?? "0"); i++)
    if (env[`GIT_CONFIG_KEY_${i}`] === "http.curloptResolve")
      return env[`GIT_CONFIG_VALUE_${i}`];
  return undefined;
}

afterEach(() => {
  loadTrustedHosts(undefined, {});
  provideMirrorOutboundForTest({ allow: ["127.0.0.1", "::1"] });
});

test("a name the operator allows as an origin passes the mirror's vet, pinned to its answer", async () => {
  provideMirrorOutboundForTest({ resolve: inCluster });
  const url = "https://git.lan/acme/app.git";
  const refused = await withAllow(undefined, () => vettedEnv(url, {}));
  expect(!refused.ok && refused.error.message).toBe(MIRROR_REFUSED);

  const passed = await withAllow("git.lan", () => vettedEnv(url, {}));
  if (!passed.ok) throw new Error(passed.error.message);
  expect(pinOf(passed.value)).toContain("10.43.191.15");
});

test("the allowance is the name's: another name at the same address, or another port, is refused", async () => {
  provideMirrorOutboundForTest({ resolve: inCluster });
  await withAllow("git.lan:8443", async () => {
    const port = await vettedEnv("https://git.lan:8443/acme/app.git", {});
    expect(port.ok).toBe(true);
    for (const url of [
      "https://git.lan/acme/app.git",
      "https://git.lan:9443/acme/app.git",
      "https://other.lan:8443/acme/app.git",
    ]) {
      const refused = await vettedEnv(url, {});
      expect(!refused.ok && refused.error.message).toBe(MIRROR_REFUSED);
    }
  });
});

test("an address the operator names is not trusted for git: trust is by name", async () => {
  await withAllow("10.43.191.15", async () => {
    const refused = await vettedEnv("https://10.43.191.15/acme/app.git", {});
    expect(!refused.ok && refused.error.message).toBe(MIRROR_REFUSED);
  });
});

/** This machine's first private, non-loopback IPv4 address, if it has one. */
function privateAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? [])
      if (
        a.family === "IPv4" &&
        !a.internal &&
        /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)
      )
        return a.address;
  return undefined;
}

const lan = privateAddress();
if (lan === undefined)
  console.log("SKIPPING the end-to-end half: this machine has no private, non-loopback address");

describe.skipIf(lan === undefined)("an allowed origin inside the network, end to end", () => {
  let dir: string;
  let git: ReturnType<typeof Bun.serve>;
  let served = 0;

  const run = (args: string[], cwd: string): string => {
    const done = Bun.spawnSync(["git", ...args], { cwd, env: gitClientEnv() });
    if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`);
    return done.stdout.toString().trim();
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-allow-mirror-"));
    // A repository served as any static web server serves one (git's "dumb"
    // HTTP), on this machine's private address only.
    run(["init", "-q", "-b", "main", "work"], dir);
    await Bun.write(join(dir, "work", "README.md"), "# app\n");
    run(["add", "README.md"], join(dir, "work"));
    run(["commit", "-q", "-m", "first"], join(dir, "work"));
    run(["clone", "-q", "--bare", "work", "app.git"], dir);
    run(["update-server-info"], join(dir, "app.git"));
    run(["init", "-q", "--bare", "mirror.git"], dir);
    const root = join(dir, "app.git");
    git = Bun.serve({
      hostname: lan!,
      port: 0,
      fetch(request) {
        served++;
        const path = decodeURIComponent(new URL(request.url).pathname);
        if (!path.startsWith("/acme/app.git/")) return new Response("", { status: 404 });
        const file = normalize(join(root, path.slice("/acme/app.git/".length)));
        if (!file.startsWith(root)) return new Response("", { status: 404 });
        return new Response(Bun.file(file));
      },
      error: () => new Response("", { status: 404 }),
    });
  });

  afterAll(async () => {
    git.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  test("not allowed, the name that resolves to it is refused before anything is fetched", async () => {
    provideMirrorOutboundForTest({ resolve: async () => [lan!] });
    const before = served;
    const refused = await withAllow(undefined, () =>
      fetchMirror(join(dir, "mirror.git"), `http://git.lan:${git.port}/acme/app.git`, {}),
    );
    expect(!refused.ok && refused.error.message).toBe(MIRROR_REFUSED);
    expect(served).toBe(before);
  });

  test("allowed, the same name is mirrored over git", async () => {
    provideMirrorOutboundForTest({ resolve: async () => [lan!] });
    const fetched = await withAllow(`git.lan:${git.port}`, () =>
      fetchMirror(join(dir, "mirror.git"), `http://git.lan:${git.port}/acme/app.git`, {}),
    );
    if (!fetched.ok) throw new Error(fetched.error.message);
    expect(run(["rev-parse", "refs/heads/main"], join(dir, "mirror.git"))).toBe(
      run(["rev-parse", "HEAD"], join(dir, "work")),
    );
  });
});
