/**
 * #11392, part of #11140: losing someone's work is never the penalty for not
 * paying. No call path from the billing webhook (`POST /hooks/stripe`,
 * `src/http/stripe_hook.ts`, and what it uses in `src/billing/*`) removes a
 * forge's or an app's directory, or runs the child-removal action. The walk
 * is `src/kernel/destroy_reach.ts`; `bun scripts/gate.ts` runs it too.
 */

import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { billingDeletesRefusal } from "../scripts/gate.ts";
import { ALLOWED_REMOVALS, destroyReach, destroyReachRefusal, layoutMisses, STOPS, unitsOf, WEBHOOK_ENTRY } from "../src/kernel/destroy_reach.ts";

const root = new URL("..", import.meta.url).pathname;

const tree = (files: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "reach-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
};

describe("the billing webhook cannot delete", () => {
  test("today's tree: nothing reachable from the webhook removes a forge, an app or a child", () => {
    expect(destroyReach(root, WEBHOOK_ENTRY)).toEqual([]);
    expect(destroyReachRefusal(root)).toEqual([]);
  });

  test("every stop and every allowance still means something, with a reason", () => {
    const runtime = readFileSync(join(root, "src/apps/runtime.ts"), "utf8");
    for (const { unit, why, from } of STOPS) {
      expect(why.length).toBeGreaterThan(10);
      expect(runtime).toContain(unit.split(".")[1]!);
      // Each unit allowed to reach a stop exists in the tree.
      for (const f of from) expect(unitsOf(root, f.split(":")[0]!).some((u) => u.name === f.split(":")[1])).toBe(true);
    }
    // With no allowance the walk finds each allowed unit: an entry that finds nothing is stale.
    const found = destroyReach(root, WEBHOOK_ENTRY, []).join("\n");
    for (const { unit, why } of ALLOWED_REMOVALS) {
      expect(why.length).toBeGreaterThan(10);
      expect(found).toContain(`${unit}]`);
    }
  });

  test("the webhook cannot trigger the runtime's teardown: no reachable unit names repo.deleted, and the runtime's entries are entered only from the units allowed", () => {
    expect(destroyReach(root, WEBHOOK_ENTRY).filter((f) => f.includes("names a removal") || f.includes("reaches "))).toEqual([]);
    // The one name collision the walk lets through: `cells.start(` is the cell registry's.
    const settle = unitsOf(root, "src/spawn/host.ts").find((u) => u.name === "settleCell")!;
    expect(settle.text).toContain("cellChildren(");
    expect(settle.text).not.toMatch(/appsRuntime\(|AppsRuntime/);
    // And the walk does notice a webhook that appends it or boots an existing forge's apps.
    const dir = tree({
      "src/http/stripe_hook.ts": 'export function hook(app: any) {\n  app.events.append({ kind: "repo.deleted" });\n}\nexport async function boot(rt: any) {\n  await rt.reconcileApp(1);\n}\nclass AppsRuntime {\n  async reconcileApp(a: number) {}\n}\n',
    });
    const bad = destroyReach(dir, WEBHOOK_ENTRY);
    rmSync(dir, { recursive: true, force: true });
    expect(bad.some((f) => f.includes("repo.deleted"))).toBe(true);
    expect(bad.some((f) => f.includes("reaches AppsRuntime.reconcileApp"))).toBe(true);
  });

  test("a deliberate rmSync on a forge dir added to the real webhook handler is found, with its path", () => {
    const copy = mkdtempSync(join(tmpdir(), "reach-real-"));
    cpSync(join(root, "src"), join(copy, "src"), { recursive: true });
    const hook = join(copy, WEBHOOK_ENTRY);
    writeFileSync(
      hook,
      readFileSync(hook, "utf8") +
        '\nexport function dropForge(app: App, bodyId: string) {\n  rmSync(childDirOf(app, bodyId), { recursive: true, force: true });\n}\n',
    );
    const found = destroyReach(copy, WEBHOOK_ENTRY);
    rmSync(copy, { recursive: true, force: true });
    expect(found.length).toBe(1);
    expect(found[0]).toContain(`${WEBHOOK_ENTRY}:`);
    expect(found[0]).toContain("rmSync(childDirOf(app, bodyId)");
  });

  test("a removal two imports away, through a re-export and a namespace, is found by chain", () => {
    const dir = tree({
      "src/http/stripe_hook.ts": 'import { settle } from "../billing/settle.ts";\nexport function hook() {\n  settle();\n}\n',
      "src/billing/settle.ts": 'import * as gone from "./gone.ts";\nexport function settle() {\n  gone.tidy();\n}\n',
      "src/billing/gone.ts": 'export * from "../apps/data.ts";\n',
      "src/apps/data.ts": 'import { rmSync } from "node:fs";\nexport function tidy() {\n  rmSync(join(appsRoot("d"), "a"), { recursive: true });\n}\n',
    });
    const found = destroyReach(dir, WEBHOOK_ENTRY);
    rmSync(dir, { recursive: true, force: true });
    expect(found.length).toBe(1);
    expect(found[0]).toContain("src/apps/data.ts:3:");
    expect(found[0]).toContain("src/http/stripe_hook.ts:hook -> src/billing/settle.ts:settle -> src/apps/data.ts:tidy");
  });

  test("the child-removal action by name is found, as a call or a method", () => {
    const dir = tree({
      "src/http/stripe_hook.ts": 'export async function hook(app: any) {\n  await app.forges.removeForge(app, "x");\n}\n',
    });
    const found = destroyReach(dir, WEBHOOK_ENTRY);
    rmSync(dir, { recursive: true, force: true });
    expect(found.length).toBe(1);
    expect(found[0]).toContain("removeForge");
  });

  test("a removal nobody on the webhook's path calls is no finding; a scratch file is one unless its unit is allowed", () => {
    const dir = tree({
      "src/http/stripe_hook.ts": 'import { scratch } from "../billing/s.ts";\nexport function hook() {\n  scratch();\n}\n',
      "src/billing/s.ts": 'export function scratch() {\n  rmSync("/tmp/x.tmp", { force: true });\n}\nexport function unrelated() {\n  rmSync(childDirOf(a, b), { recursive: true });\n}\n',
    });
    const found = destroyReach(dir, WEBHOOK_ENTRY);
    const allowed = destroyReach(dir, WEBHOOK_ENTRY, [{ unit: "src/billing/s.ts:scratch", why: "scratch file" }]);
    rmSync(dir, { recursive: true, force: true });
    expect(found.length).toBe(1);
    expect(found[0]).toContain("s.ts:2:");
    expect(allowed).toEqual([]);
  });

  const shapes: Record<string, string> = {
    "a path held in a variable": 'import { rmSync } from "node:fs";\nexport function hook() {\n  const d = childDirOf(app, id);\n  rmSync(d, { recursive: true });\n}\n',
    "a bare name that says nothing": 'import { rmSync } from "node:fs";\nexport function hook(dir: string) {\n  rmSync(dir);\n}\n',
    "a call over several lines": 'import { rmSync } from "node:fs";\nexport function hook() {\n  rmSync(\n    join(a, b),\n    { recursive: true },\n  );\n}\n',
    "a member of a promises namespace": 'import fs from "node:fs";\nexport async function hook(target: string) {\n  await fs.promises.rm(target);\n}\n',
    "a namespace import": 'import * as fs from "node:fs/promises";\nexport async function hook(t: string) {\n  await fs.rm(t);\n}\n',
    "an aliased import": 'import { rmSync as r } from "node:fs";\nexport function hook(t: string) {\n  r(t, { force: true });\n}\n',
    "a destructured alias": 'import fs from "node:fs";\nexport function hook(t: string) {\n  const { rmSync: gone } = fs;\n  gone(t);\n}\n',
    "unlink and rmdir": 'import { unlinkSync, rmdirSync } from "fs";\nexport function hook(t: string) {\n  unlinkSync(t);\n  rmdirSync(t);\n}\n',
  };
  for (const [name, text] of Object.entries(shapes))
    test(`a removal is found without judging the path: ${name}`, () => {
      const dir = tree({ "src/http/stripe_hook.ts": text });
      const found = destroyReach(dir, WEBHOOK_ENTRY);
      rmSync(dir, { recursive: true, force: true });
      expect(found.length).toBeGreaterThan(0);
      expect(found[0]).toContain("removes a file");
    });

  test("a call in a comment or a string-free name like `farm(` is not a removal", () => {
    const dir = tree({ "src/http/stripe_hook.ts": '// rmSync(x)\n/* rm(y) */\nexport function hook() {\n  farm(1);\n  confirm(2);\n}\n' });
    const found = destroyReach(dir, WEBHOOK_ENTRY);
    rmSync(dir, { recursive: true, force: true });
    expect(found).toEqual([]);
  });

  test("a unit on the allow-list may remove, and only that unit", () => {
    const dir = tree({
      "src/http/stripe_hook.ts": 'import { tidy } from "../billing/t.ts";\nexport function hook() {\n  tidy();\n}\n',
      "src/billing/t.ts": 'import { rmSync } from "node:fs";\nexport function tidy() {\n  rmSync("/x");\n}\n',
    });
    const allowed = [{ unit: "src/billing/t.ts:tidy", why: "scratch" }];
    expect(destroyReach(dir, WEBHOOK_ENTRY, allowed)).toEqual([]);
    expect(destroyReach(dir, WEBHOOK_ENTRY, []).length).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a webhook that has moved is a refusal in the real tree, and the walk is skipped only in a fixture without it", () => {
    const moved = tree({ "src/kernel/destroy_reach.ts": "// copy\n" });
    expect(destroyReachRefusal(moved)[0]).toContain(`${WEBHOOK_ENTRY} is not there`);
    expect(billingDeletesRefusal(moved)[0]).toContain("is not there");
    rmSync(moved, { recursive: true, force: true });
    const fixture = tree({ "README.md": "x" });
    expect(billingDeletesRefusal(fixture)).toEqual([]);
    rmSync(fixture, { recursive: true, force: true });
    expect(billingDeletesRefusal(root)).toEqual([]);
  });

  test("an entry that parses to no unit, or code at an odd indent, is a finding and never a quiet pass", () => {
    const empty = tree({ "src/http/stripe_hook.ts": "  export function hook() {\n    rmSync(x);\n  }\n" });
    const found = destroyReach(empty, WEBHOOK_ENTRY);
    rmSync(empty, { recursive: true, force: true });
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]).toContain("no unit parsed");
    const odd = tree({
      "src/http/stripe_hook.ts": 'import { a } from "../billing/a.ts";\nexport function hook() {\n  a();\n}\n',
      "src/billing/a.ts": 'export function a() {}\n  export function hidden() {\n    rmSync(x);\n  }\n',
    });
    const miss = destroyReach(odd, WEBHOOK_ENTRY);
    rmSync(odd, { recursive: true, force: true });
    expect(miss.some((f) => f.includes("indented top-level code"))).toBe(true);
  });

  test("every unit of the entry and of src/billing was parsed: each exported name has a non-empty unit", () => {
    const files = [WEBHOOK_ENTRY, ...readdirSync(join(root, "src/billing")).filter((f) => f.endsWith(".ts")).map((f) => `src/billing/${f}`)];
    for (const file of files) {
      expect(layoutMisses(root, file)).toEqual([]);
      const units = unitsOf(root, file);
      const text = readFileSync(join(root, file), "utf8");
      const exported = [...text.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]!);
      for (const name of exported) {
        const unit = units.find((u) => u.name === name);
        expect(unit, `${file}: ${name} was not parsed`).toBeDefined();
        expect(unit!.text.trim().length).toBeGreaterThan(name.length);
      }
    }
  });
});
