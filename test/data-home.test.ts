/**
 * A forge keeps its state outside the tree it runs from (#622): boot refuses
 * a data directory that is the checkout, or inside it and not ignored, with
 * the reason in one line. The fixture is a throwaway git repository with
 * `data/` in its `.gitignore`, as this one has.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataHomeRefusal } from "../src/kernel/data_home.ts";

let base: string;
let repo: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "forge-data-home-"));
  repo = join(base, "checkout");
  mkdirSync(join(repo, "src"), { recursive: true });
  Bun.spawnSync(["git", "init", "-q", repo]);
  writeFileSync(join(repo, ".gitignore"), "data/\n*.local\n");
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("dataHomeRefusal", () => {
  test("the checkout itself is refused, in one line", () => {
    const why = dataHomeRefusal(repo, join(repo, "src"));
    expect(why).toContain("is the repository checkout");
    expect(why).not.toContain("\n");
  });

  test("a relative path that resolves to the checkout is refused", () => {
    const why = dataHomeRefusal(join(repo, "src", ".."), join(repo, "src"));
    expect(why).toContain("is the repository checkout");
  });

  test("a directory inside the checkout that git does not ignore is refused", () => {
    const why = dataHomeRefusal(join(repo, "state"), join(repo, "src"));
    expect(why).toContain("git does not ignore it");
    expect(why).not.toContain("\n");
    expect(dataHomeRefusal(join(repo, "src"), repo)).toContain(
      "git does not ignore it",
    );
  });

  test("an ignored directory inside the checkout is allowed, existing or not", () => {
    expect(dataHomeRefusal(join(repo, "data"), repo)).toBeNull();
    expect(dataHomeRefusal(join(repo, "x.local"), repo)).toBeNull();
    mkdirSync(join(repo, "data"));
    expect(dataHomeRefusal(join(repo, "data"), repo)).toBeNull();
    expect(dataHomeRefusal(join(repo, "data", "deeper"), repo)).toBeNull();
  });

  test("a directory outside the checkout is allowed", () => {
    expect(dataHomeRefusal(join(base, "elsewhere"), repo)).toBeNull();
    expect(dataHomeRefusal(base, repo)).toBeNull();
  });

  test("a forge running from no checkout has nothing to refuse", () => {
    const loose = join(base, "loose");
    mkdirSync(loose);
    expect(dataHomeRefusal(loose, loose)).toBeNull();
  });
});

const root = new URL("..", import.meta.url).pathname;
const inCheckout =
  Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: root })
    .exitCode === 0;

describe("boot", () => {
  // The forge's check runs from a `checkout-index` directory with no `.git`,
  // where there is no checkout to protect and main.ts would boot for real.
  test.skipIf(!inCheckout)(
    "`FORGE_DATA` set to this checkout stops main.ts before anything starts",
    async () => {
      const proc = Bun.spawn(["bun", "run", "src/main.ts"], {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          FORGE_DATA: root,
          PORT: "0",
          FORGE_SSH_PORT: "0",
          FORGE_APPS: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const timer = setTimeout(() => proc.kill(), 20_000);
      const code = await proc.exited;
      clearTimeout(timer);
      const err = (await new Response(proc.stderr).text()).trim();
      expect(code).toBe(1);
      expect(err.split("\n")).toHaveLength(1);
      expect(err).toContain("refusing to boot");
    },
    30_000,
  );
});
