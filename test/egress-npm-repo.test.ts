/**
 * A contained install that fetches more than a MiB from the npm registry
 * says the shared cache missed, and the registry's bytes are kept per
 * repository for the last hour (#8382), attributed by the cell's meter —
 * never by anything the install printed.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { meterEgress, NPM_REGISTRY, npmTopRepoLastHour, recordEgress, resetEgressTotals } from "../src/apps/egress.ts";
import { meteredInstall, npmMissLine } from "../src/checks/install.ts";

beforeEach(resetEgressTotals);
afterEach(resetEgressTotals);

const T = Date.UTC(2026, 10, 2, 12, 0, 0);
const MIN = 60_000;
const MiB = 1024 * 1024;

/** One metered install: what its proxy received, then the line its log ends with. */
function install(label: string, repoId: string | undefined, received: [string, number][], now = T): string | undefined {
  const meter = meterEgress(label, repoId);
  for (const [destination, bytes] of received) recordEgress(label, destination, bytes, 0, now);
  meter.stop();
  return npmMissLine(meter.npm());
}

test("an install over a MiB from the registry ends with the miss line; one under it does not", () => {
  expect(install("check:big", "r1", [[NPM_REGISTRY, 3 * MiB]])).toBe(
    "install fetched 3.0 MiB from the npm registry; the shared cache missed",
  );
  expect(install("check:small", "r1", [[NPM_REGISTRY, 512 * 1024]])).toBeUndefined();
  expect(install("check:edge", "r1", [[NPM_REGISTRY, MiB]])).toBeUndefined();
});

test("only the registry's bytes count toward the miss, not other hosts'", () => {
  expect(install("check:gh", "r1", [["github.com:443", 50 * MiB], [NPM_REGISTRY, 10]])).toBeUndefined();
});

test("bytes after stop() are not the install's", () => {
  const meter = meterEgress("check:late", "r1");
  recordEgress("check:late", NPM_REGISTRY, 100, 0, T);
  meter.stop();
  recordEgress("check:late", NPM_REGISTRY, 9 * MiB, 0, T);
  expect(meter.npm()).toBe(100);
});

test("two repositories' installs are attributed to each, and the top one is named", () => {
  install("check:a", "repo-a", [[NPM_REGISTRY, 2 * MiB]]);
  install("app:b/pr-1", "repo-b", [[NPM_REGISTRY, 3 * MiB]]);
  install("check:a2", "repo-a", [[NPM_REGISTRY, 2 * MiB]]);
  expect(npmTopRepoLastHour(T)).toEqual({ repoId: "repo-a", bytes: 4 * MiB });
  // An hour on, repo-a's minute has aged out while repo-b fetched again.
  install("app:b/pr-1", "repo-b", [[NPM_REGISTRY, 1]], T + 60 * MIN);
  expect(npmTopRepoLastHour(T + 60 * MIN)).toEqual({ repoId: "repo-b", bytes: 1 });
});

test("unmetered or repository-less traffic is attributed to no repository", () => {
  recordEgress("check:nobody", NPM_REGISTRY, 9 * MiB, 0, T);
  install("check:anon", undefined, [[NPM_REGISTRY, 9 * MiB]]);
  expect(npmTopRepoLastHour(T)).toBeUndefined();
});

test("a later holder's repository is kept when the first holder of the label had none", () => {
  const first = meterEgress("app:x/main");
  const second = meterEgress("app:x/main", "repo-x");
  recordEgress("app:x/main", NPM_REGISTRY, 2 * MiB, 0, T);
  second.stop();
  first.stop();
  expect(npmTopRepoLastHour(T)).toEqual({ repoId: "repo-x", bytes: 2 * MiB });
});

// The step both the check/gate site (`checks/service.ts`) and the app and
// preview site (`apps/process.ts`) run their contained install through.
test("a metered install's log ends with the miss line, after the fetched line a check asks for", async () => {
  const lines: string[] = [];
  const result = await meteredInstall(
    "check:run-1",
    "repo-c",
    async () => {
      recordEgress("check:run-1", NPM_REGISTRY, 5 * MiB, 0, T);
      return "done";
    },
    (line) => lines.push(line),
    { fetched: true },
  );
  expect(result).toBe("done");
  expect(lines).toEqual([
    "install fetched 5.2 MB from the registry",
    "install fetched 5.0 MiB from the npm registry; the shared cache missed",
  ]);
  expect(npmTopRepoLastHour(T)).toEqual({ repoId: "repo-c", bytes: 5 * MiB });
});

test("an app install logs only the miss line, and logs it when the install throws", async () => {
  const lines: string[] = [];
  const failing = meteredInstall(
    "app:y/pr-2",
    "repo-y",
    async () => {
      recordEgress("app:y/pr-2", NPM_REGISTRY, 2 * MiB, 0, T);
      throw new Error("aborted");
    },
    (line) => lines.push(line),
  );
  await expect(failing).rejects.toThrow("aborted");
  expect(lines).toEqual(["install fetched 2.0 MiB from the npm registry; the shared cache missed"]);
});

test("an uncontained install is not metered and logs nothing", async () => {
  const lines: string[] = [];
  await meteredInstall(undefined, "repo-z", async () => recordEgress("", NPM_REGISTRY, 9 * MiB, 0, T), (l) => lines.push(l), { fetched: true });
  expect(lines).toEqual([]);
  expect(npmTopRepoLastHour(T)).toBeUndefined();
});
