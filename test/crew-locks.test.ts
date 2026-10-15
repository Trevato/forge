import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearStaleLocks, lockedOut } from "../src/crew/locks.ts";

function clone() {
  const dir = mkdtempSync(join(tmpdir(), "forge-locks-"));
  mkdirSync(join(dir, ".git", "refs", "heads", "scout"), { recursive: true });
  return dir;
}
const plant = (path: string, ageMs: number) => {
  writeFileSync(path, "");
  const when = new Date(Date.now() - ageMs);
  utimesSync(path, when, when);
};

describe("stale git locks in a kept clone", () => {
  test("old locks go, one line each; young locks and other files stay", () => {
    const dir = clone();
    const old = [
      join(dir, ".git", "config.lock"),
      join(dir, ".git", "index.lock"),
      join(dir, ".git", "refs", "heads", "scout", "x.lock"),
    ];
    for (const path of old) plant(path, 10 * 60_000);
    const young = join(dir, ".git", "HEAD.lock");
    plant(young, 1_000);
    const config = join(dir, ".git", "config");
    plant(config, 10 * 60_000);
    const lines: string[] = [];
    const removed = clearStaleLocks(dir, (l) => lines.push(l));
    expect(removed.sort()).toEqual([...old].sort());
    expect(lines).toHaveLength(3);
    for (const path of old) expect(existsSync(path)).toBe(false);
    expect(existsSync(young)).toBe(true);
    expect(existsSync(config)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a directory with no .git is left alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-locks-"));
    expect(clearStaleLocks(dir, () => {})).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a lock failure is recognised from git's words", () => {
    expect(
      lockedOut("error: could not lock config file .git/config: File exists"),
    ).toBe(true);
    expect(
      lockedOut("fatal: Unable to create '/x/.git/index.lock': File exists."),
    ).toBe(true);
    expect(lockedOut("fatal: not a git repository")).toBe(false);
    expect(lockedOut("error: could not lock ref: cannot lock the thing")).toBe(false);
  });
});
