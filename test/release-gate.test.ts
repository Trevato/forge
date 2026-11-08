/**
 * One release gate (#2794): the forge's own full check green on the
 * release commit, then the built image booting. The release workflow waits
 * on the first before it builds, the Dockerfile's build is the second, and
 * no workflow on the mirror runs its own copy of the suite on a push, a
 * pull or a tag — that copy held good releases on runner-only reds.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const WORKFLOWS = join(ROOT, ".forgejo", "workflows");
const read = (path: string) => readFileSync(path, "utf8");

/** The workflow's `on:` block: the lines up to `jobs:`. */
const triggers = (yml: string) => yml.slice(yml.indexOf("\non:"), yml.indexOf("\njobs:"));

describe("the release gate", () => {
  const release = read(join(WORKFLOWS, "release.yml"));

  test("the release waits on the forge's own check of the commit before it builds", () => {
    const wait = release.indexOf("- name: the forge's own check is green on this commit");
    const build = release.indexOf("- name: build & push image");
    expect(wait).toBeGreaterThan(0);
    expect(build).toBeGreaterThan(wait);
    const step = release.slice(wait, build);
    expect(step).toContain("/api/v1/repos/$REPO/commits/$SHA/check");
    expect(step).toContain("SHA=$(git -C src rev-parse HEAD)");
    // Only `ok` lets the build start; `failed`, `superseded` (nothing will
    // check that commit again) and `none` past its grace stop it at once.
    expect(step).toMatch(/ok\) [^\n]*exit 0/);
    expect(step).toMatch(/failed\) [^\n]*exit 1/);
    // A later landing cancelling the tag's check does not hold a release: the landing gate and the boot proof stand.
    expect(step).toMatch(/superseded\) [^\n]*exit 0/);
    expect(step).toMatch(/none\) [^\n]*-lt 600 [^\n]*exit 1/);
  });

  test("the build boots the image it built", () => {
    expect(read(join(ROOT, "Dockerfile"))).toContain("RUN bun src/release/boot.ts");
  });

  test("no workflow run by a push, a pull or a tag runs the suite", () => {
    const suite = /test-shards\.ts|\bbun test\b/;
    const onEvent = /^\s+(push|pull_request|pull_request_target):/m;
    const copies = readdirSync(WORKFLOWS)
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .filter((name) => {
        const yml = read(join(WORKFLOWS, name));
        return onEvent.test(triggers(yml)) && suite.test(yml);
      });
    expect(copies).toEqual([]);
  });
});
