/**
 * The releases a forge has shipped are the frozen ones and its annotated
 * `v*` tags, newest first; a cut is a tag, so main never moves (#6642).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrationFiles, NUMBERED } from "../src/core/schema.ts";
import { releasesBehind } from "../src/spawn/heartbeat.ts";
import {
  compareVersions,
  mergeShipped,
  parseRecord,
  readTagged,
  recordFor,
  setTagged,
  shippedReleases,
} from "../src/release/shipped.ts";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-shipped-"));
});
afterAll(async () => {
  setTagged([]);
  await rm(dir, { recursive: true, force: true });
});

const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (args: string[], date: string, stdin?: string) =>
  Bun.spawn(["git", ...args], {
    cwd: dir,
    env: { ...env, GIT_COMMITTER_DATE: date },
    stdout: "ignore",
    stderr: "ignore",
    ...(stdin === undefined ? {} : { stdin: new Blob([stdin]) }),
  }).exited;

describe("a release record", () => {
  test("is read from a tag message, and anything else is not one", () => {
    expect(parseRecord('{"version":"0.7.272","migrations":151,"ids":["20261016130000-usage-count"]}\n')).toEqual({
      version: "0.7.272",
      migrations: 151,
      ids: ["20261016130000-usage-count"],
    });
    expect(parseRecord('{"version":"0.7.40","migrations":40}')).toEqual({ version: "0.7.40", migrations: 40 });
    const signed = '{"version":"1.0.0","migrations":1}\n-----BEGIN PGP SIGNATURE-----\nxyz\n-----END PGP SIGNATURE-----\n';
    expect(parseRecord(signed)).toEqual({ version: "1.0.0", migrations: 1 });
    for (const bad of [
      "forge 0.3.9 — git trusts the runtime's extra certificate authority",
      "{",
      '{"version":"a b; rm","migrations":1}',
      '{"version":"1.0.0","migrations":-1}',
      '{"version":"1.0.0","migrations":1.5}',
      '{"version":"1.0.0","migrations":1,"ids":["../x"]}',
      '{"version":"1.0.0","migrations":1,"ids":"x"}',
      "null",
    ])
      expect(parseRecord(bad)).toBeUndefined();
  });

  test("of a cut counts every migration and names the stamped ones", () => {
    const record = recordFor("9.0.0", migrationFiles, NUMBERED);
    expect(record.migrations).toBe(migrationFiles.length);
    expect(record.ids).toEqual(migrationFiles.slice(NUMBERED).map((m) => m.name));
    expect(parseRecord(JSON.stringify(record))).toEqual(record);
  });

  test("versions sort newest first, by number", () => {
    expect(["0.7.9", "0.7.271", "0.10.0", "0.7.10"].sort(compareVersions)).toEqual(["0.10.0", "0.7.271", "0.7.10", "0.7.9"]);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
});

describe("the shipped releases", () => {
  test("are the frozen ones until a tag is read, then the tags ahead of them", () => {
    const frozen = shippedReleases();
    expect(frozen.length).toBeGreaterThan(0);
    expect(shippedReleases()).toBe(frozen);
    expect(releasesBehind(frozen[0]!.version)).toBe(0);
    setTagged([{ version: "99.0.1", migrations: 1, at: 2 }, { version: "99.0.0", migrations: 1, at: 1 }]);
    expect(shippedReleases().slice(0, 3).map((r) => r.version)).toEqual(["99.0.1", "99.0.0", frozen[0]!.version]);
    expect(shippedReleases().length).toBe(frozen.length + 2);
    // A child on the newest frozen release is now two behind.
    expect(releasesBehind(frozen[0]!.version)).toBe(2);
    setTagged([]);
    expect(shippedReleases()).toBe(frozen);
  });

  test("a tag wins over the frozen entry of its version", () => {
    const merged = mergeShipped([{ version: "1.0.0", migrations: 1 }], [{ version: "1.0.0", migrations: 2, at: 5 }]);
    expect(merged).toEqual([{ version: "1.0.0", migrations: 2, at: 5 }]);
  });

  test("are read from the annotated v* tags; a lightweight or wordy tag is no record", async () => {
    await git(["init", "-q", "-b", "main"], "2026-10-26T10:00:00Z");
    await git(["commit", "-q", "--allow-empty", "-m", "one"], "2026-10-26T10:00:00Z");
    await git(["tag", "-a", "-F", "-", "v0.3.9"], "2026-09-09T19:54:19Z", "forge 0.3.9 — words, not a record");
    await git(["tag", "v0.7.300"], "2026-10-26T10:00:00Z");
    await git(["tag", "-a", "-F", "-", "not-a-release"], "2026-10-26T10:00:00Z", '{"version":"5.0.0","migrations":1}');
    await git(["tag", "-a", "-F", "-", "v0.7.272"], "2026-10-26T11:00:00Z", '{"version":"0.7.272","migrations":151,"ids":["a-b"]}');
    await git(["tag", "-a", "-F", "-", "v0.7.273"], "2026-10-26T12:00:00Z", '{\n  "version": "0.7.273",\n  "migrations": 152\n}\n');
    expect(await readTagged(dir)).toEqual([
      { version: "0.7.273", migrations: 152, at: Date.parse("2026-10-26T12:00:00Z") },
      { version: "0.7.272", migrations: 151, ids: ["a-b"], at: Date.parse("2026-10-26T11:00:00Z") },
    ]);
    expect(await readTagged(join(dir, "missing"))).toEqual([]);
  });
});
