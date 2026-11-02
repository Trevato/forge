import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepOrphanClones } from "../src/crew/orphans.ts";

describe("sweeping clones nothing claims", () => {
  test("only the unclaimed clones go; the cache and odd names stay", async () => {
    const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "orphans-"));
    for (const p of ["scout/r1/10", "scout/r1/11", "scout/r2/12", ".cache/r1/bun", "scout/r1/notes"])
      mkdirSync(join(root, p), { recursive: true });
    writeFileSync(join(root, "scout/r1/11/f"), "x");
    const seen: string[] = [];
    const swept = await sweepOrphanClones(root, (agent, repo, n) => {
      seen.push(`${agent}/${repo}/${n}`);
      return n === 10;
    });
    expect(swept).toBe(2);
    expect(seen.sort()).toEqual(["scout/r1/10", "scout/r1/11", "scout/r2/12"]);
    expect(existsSync(join(root, "scout/r1/10"))).toBe(true);
    expect(existsSync(join(root, "scout/r1/11"))).toBe(false);
    expect(existsSync(join(root, "scout/r2/12"))).toBe(false);
    expect(existsSync(join(root, ".cache/r1/bun"))).toBe(true);
    expect(existsSync(join(root, "scout/r1/notes"))).toBe(true);
  });
});
