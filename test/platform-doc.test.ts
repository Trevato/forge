import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// docs/PLATFORM.md (#7667) is the inventory of what the forge still takes
// from the platform. It stays true to the repository: the files it says
// can be deleted are really there, and it names the gate.
const root = join(import.meta.dir, "..");
const doc = readFileSync(join(root, "docs/PLATFORM.md"), "utf8");

test("every file the inventory names exists", () => {
  const paths = [...doc.matchAll(/`((?:docs|src|scripts|\.forgejo)\/[A-Za-z0-9_./-]+\.(?:md|ts|yml))`/g)].map((m) => m[1]!);
  expect(paths.length).toBeGreaterThan(8);
  expect(paths.filter((p) => !existsSync(join(root, p)))).toEqual([]);
});

test("it covers each dependency the owner listed, and says nothing is turned off", () => {
  for (const topic of ["Image build and registry", "Gitops and reconcile", "pod and its supervisor", "Ingress and TLS", "Identity", "Backup lanes", "Forgejo, where outside people", "Hosted apps", "release tick"])
    expect(doc).toContain(topic);
  expect(doc).toContain("without the owner present");
  expect(doc).toContain("#8952");
});
