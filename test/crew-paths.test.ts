/**
 * stripForgeDirs and spellings: how a run log names the files it touched.
 * Split from crew.test.ts so the stand-in forge there runs apart.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spellings, stripForgeDirs } from "../src/runs/paths.ts";

describe("stripForgeDirs", () => {
  test("strips a known directory, leaves the rest of the path", () => {
    expect(
      stripForgeDirs(["/data/crew/bot/1/2"], "/data/crew/bot/1/2/src/a.ts"),
    ).toBe("src/a.ts");
  });

  test("a line with no match passes through whole", () => {
    expect(stripForgeDirs(["/data/crew/bot/1/2"], "/usr/bin/ssh")).toBe(
      "/usr/bin/ssh",
    );
  });

  test("an empty directory is dropped, not used as a prefix", () => {
    expect(stripForgeDirs([""], "/usr/bin/ssh")).toBe("/usr/bin/ssh");
  });

  test("the directory alone reads as here, wherever it stands in the line", () => {
    const dir = "/data/crew/bot/1/2";
    expect(stripForgeDirs([dir], `cd ${dir} && ls ${dir}/src`)).toBe(
      "cd . && ls src",
    );
    expect(stripForgeDirs([dir], `at "${dir}/a.ts":3 (${dir})`)).toBe(
      'at "a.ts":3 (.)',
    );
  });

  test("its text inside a longer path is left whole, never a path that was not there", () => {
    const dir = "/var/folders/x/work";
    // The same directory through a symlink the forge did not resolve.
    expect(stripForgeDirs([dir], `/private${dir}/CREW.md`)).toBe(
      `/private${dir}/CREW.md`,
    );
    // A sibling whose name begins the same way.
    expect(stripForgeDirs(["/data/1/2"], "/data/1/23/a.ts /data/1/2.bak")).toBe(
      "/data/1/23/a.ts /data/1/2.bak",
    );
    // And the whole one beside them still goes.
    expect(
      stripForgeDirs(["/data/1/2"], "/data/1/23/a.ts /data/1/2/a.ts"),
    ).toBe("/data/1/23/a.ts a.ts");
  });

  test("a directory before a full stop that punctuates goes, and the stop stays", () => {
    const dir = "/var/folders/x/work";
    expect(stripForgeDirs([dir], `wrote to ${dir}.`)).toBe("wrote to .");
    expect(stripForgeDirs([dir], `${dir}. Then ${dir}/a.ts`)).toBe(
      ". Then a.ts",
    );
    // Inside brackets or quotes, before a comma, and in an ellipsis.
    expect(stripForgeDirs([dir], `(see ${dir}.)`)).toBe("(see .)");
    expect(stripForgeDirs([dir], `"${dir}.", it said`)).toBe('".", it said');
    expect(stripForgeDirs([dir], `${dir}...`)).toBe("...");
    // A name that goes on after the dot is a sibling, left whole — after
    // one dot or two.
    expect(stripForgeDirs([dir], `${dir}.bak is kept`)).toBe(
      `${dir}.bak is kept`,
    );
    expect(stripForgeDirs([dir], `${dir}..bak is kept`)).toBe(
      `${dir}..bak is kept`,
    );
  });

  test("a directory reached through a symlink reads relative under either spelling", async () => {
    const root = realpathSync(await mkdtemp(join(tmpdir(), "forge-paths-")));
    try {
      const real = join(root, "real");
      const link = join(root, "link");
      mkdirSync(real);
      symlinkSync(real, link);
      // The forge named the link; a child process reports the real path.
      const dirs = spellings([link]);
      expect(dirs).toEqual([link, real].sort((a, b) => b.length - a.length));
      expect(stripForgeDirs(dirs, `${real}/CREW.md`)).toBe("CREW.md");
      expect(stripForgeDirs(dirs, `${link}/CREW.md`)).toBe("CREW.md");
      // A directory that is not there yet keeps its own spelling.
      expect(spellings([join(root, "later"), ""])).toEqual([
        join(root, "later"),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
