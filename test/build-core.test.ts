/**
 * What build previews and Iterations stand on: the build environment's name,
 * the exact and leased ref moves, and a page's one extra frame origin.
 * Real git in a temp directory, nothing mocked.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEnv, buildEnvFromLabel, envBuild, envHostLabel, envPull, envWords, isEnvName } from "../src/apps/data.ts";
import { exactRefOid, moveRefLeased } from "../src/git/branches.ts";
import { frameSources } from "../src/web/layout.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const IDENTITY = {
  GIT_AUTHOR_NAME: "Ada",
  GIT_AUTHOR_EMAIL: "ada@forge.local",
  GIT_COMMITTER_NAME: "Ada",
  GIT_COMMITTER_EMAIL: "ada@forge.local",
};

async function sh(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, env: gitClientEnv(IDENTITY), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}

describe("the build environment's name", () => {
  test("is the short sha, and reads back from names, labels and hosts", () => {
    const env = buildEnv("1A2B3C4D5E6F");
    expect(env).toBe("build-1a2b3c4");
    expect(isEnvName(env)).toBe(true);
    expect(envBuild(env)).toBe("1a2b3c4");
    expect(envHostLabel("show", env)).toBe("show--b1a2b3c4");
    expect(buildEnvFromLabel("b1a2b3c4")).toBe(env);
    expect(envWords(env)).toBe("the build at 1a2b3c4");
    expect(envPull(env)).toBeUndefined();
  });

  test("production and a pull keep their names, and a short or odd sha is no environment", () => {
    expect(envHostLabel("show", "production")).toBe("show");
    expect(envHostLabel("show", "pull-12")).toBe("show--12");
    expect(envBuild("pull-12")).toBeUndefined();
    expect(envPull("pull-12")).toBe(12);
    expect(isEnvName("build-1a2b3c")).toBe(false);
    expect(isEnvName("build-1a2b3cz")).toBe(false);
    expect(buildEnvFromLabel("b1a2b3c")).toBeUndefined();
  });
});

describe("exact and leased refs", () => {
  let dir: string;
  let one = "";
  let two = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-build-core-"));
    await sh(["init", "-q", "-b", "main"], dir);
    await sh(["commit", "-q", "--allow-empty", "-m", "one"], dir);
    one = await sh(["rev-parse", "HEAD"], dir);
    await sh(["commit", "-q", "--allow-empty", "-m", "two"], dir);
    two = await sh(["rev-parse", "HEAD"], dir);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  test("exactRefOid reads a full ref and never a branch that shares its short name", async () => {
    expect(await exactRefOid(dir, "refs/heads/main")).toBe(two);
    expect(await exactRefOid(dir, "refs/pin")).toBeUndefined();
    await sh(["branch", "pin", one], dir);
    expect(await exactRefOid(dir, "refs/pin")).toBeUndefined();
    expect(await exactRefOid(dir, "pin")).toBeUndefined();
    expect(await exactRefOid(dir, "refs/../x")).toBeUndefined();
  });

  test("moveRefLeased creates, moves and deletes only from the value the caller saw", async () => {
    const ref = "refs/pins/a";
    expect((await moveRefLeased(dir, ref, one, undefined)).ok).toBe(true);
    expect(await exactRefOid(dir, ref)).toBe(one);
    // Creating over an existing ref, and moving from a stale value, are refused.
    expect(await moveRefLeased(dir, ref, two, undefined)).toEqual({ ok: false, error: "ref_moved" });
    expect(await moveRefLeased(dir, ref, two, two)).toEqual({ ok: false, error: "ref_moved" });
    expect(await exactRefOid(dir, ref)).toBe(one);
    expect((await moveRefLeased(dir, ref, two, one)).ok).toBe(true);
    expect(await exactRefOid(dir, ref)).toBe(two);
    expect(await moveRefLeased(dir, ref, undefined, one)).toEqual({ ok: false, error: "ref_moved" });
    expect((await moveRefLeased(dir, ref, undefined, two)).ok).toBe(true);
    expect(await exactRefOid(dir, ref)).toBeUndefined();
  });

  test("moveRefLeased refuses a ref outside refs/ and an oid that is not one", async () => {
    expect(await moveRefLeased(dir, "main", one, undefined)).toEqual({ ok: false, error: "invalid_ref" });
    expect(await moveRefLeased(dir, "refs/x y", one, undefined)).toEqual({ ok: false, error: "invalid_ref" });
    expect(await moveRefLeased(dir, "refs/pins/b", "--delete", undefined)).toEqual({ ok: false, error: "invalid_oid" });
  });
});

describe("a page's frame origin", () => {
  test("is added to frame-src for the page that asks, beside Turnstile's, and nowhere else", () => {
    expect(frameSources({})).toBe("");
    expect(frameSources({ turnstile: true })).toBe("frame-src https://challenges.cloudflare.com; ");
    expect(frameSources({ frameSrc: "https://d.example.test:8443" })).toBe("frame-src https://d.example.test:8443; ");
    expect(frameSources({ turnstile: true, frameSrc: "http://localhost:3000" })).toBe(
      "frame-src https://challenges.cloudflare.com http://localhost:3000; ",
    );
  });

  test("ignores anything that is not a bare origin", () => {
    for (const bad of ["*", "https://a.test/x", "https://a.test; script-src *", "'self'", "data:", "https://a.test *"])
      expect(frameSources({ frameSrc: bad })).toBe("");
  });
});
