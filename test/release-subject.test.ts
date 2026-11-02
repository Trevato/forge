import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReleaseSubject, releaseOfCommit } from "../src/core/release_subject.ts";

let dir: string;
let release: string;
let plain: string;

function git(...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "forge-release-subject-"));
  git("init", "-q");
  writeFileSync(join(dir, "a"), "1");
  git("add", "a");
  git("commit", "-q", "-m", "Release 0.7.251: Hot files; fixed (#12);Second thing (#34)");
  release = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "a"), "2");
  git("commit", "-q", "-am", "Just a change");
  plain = git("rev-parse", "HEAD");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a release subject parses into version and pulls", () => {
  expect(parseReleaseSubject("Release 0.7.251: A (#1);B, c (#2)")).toEqual({
    version: "0.7.251",
    pulls: [{ title: "A", number: 1 }, { title: "B, c", number: 2 }],
  });
  expect(parseReleaseSubject("Fix things")).toBeUndefined();
});

test("a subject cut short with an ellipsis loses its last pull", () => {
  expect(parseReleaseSubject("Release 0.7.251: A (#1);B was cut sh…")).toEqual({
    version: "0.7.251",
    pulls: [{ title: "A", number: 1 }],
  });
});

test("a production release commit is read; a preview or a plain commit is not", async () => {
  expect(await releaseOfCommit(dir, "production", release)).toEqual({
    version: "0.7.251",
    pulls: [{ title: "Hot files; fixed", number: 12 }, { title: "Second thing", number: 34 }],
  });
  expect(await releaseOfCommit(dir, "preview", release)).toBeUndefined();
  expect(await releaseOfCommit(dir, "production", plain)).toBeUndefined();
});
