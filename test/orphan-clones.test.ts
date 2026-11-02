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

  test("clones moved aside and a crashed run's own clone go; a held one stays (#8219)", async () => {
    const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "orphans-"));
    const names = ["10.broken-1730000000000", "10.run-abc", "10.run-live"];
    for (const n of names) mkdirSync(join(root, "scout/r1", n), { recursive: true });
    const live = join(root, "scout/r1/10.run-live");
    const swept = await sweepOrphanClones(root, () => true, (d) => d === live);
    expect(swept).toBe(2);
    expect(existsSync(join(root, "scout/r1", names[0]!))).toBe(false);
    expect(existsSync(join(root, "scout/r1", names[1]!))).toBe(false);
    expect(existsSync(live)).toBe(true);
  });
});
