/**
 * What the forge fills its shared bun cache from, on the host (#7543,
 * #7541): only a lockfile whose every package is a registry `name@version`
 * with a sha512 integrity; anything else installs into the cell's own cache.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fillable } from "../src/checks/fillable.ts";
import { lockfileRefusal } from "../src/checks/install.ts";

const lockOf = (packages: Record<string, unknown>, workspaces: Record<string, unknown> = { "": {} }): string =>
  JSON.stringify({ lockfileVersion: 1, workspaces, packages });
const SHA = "sha512-AAAA";

describe("fillable: what the forge fills on the host", () => {
  const registry = "https://registry.npmjs.org/";

  test("plain registry packages by name and version are filled, scoped and aliased too", () => {
    const lock = `{
      "lockfileVersion": 1,
      "workspaces": { "": { "name": "p", "dependencies": { "a": "^1.0.0" }, }, },
      "packages": {
        "a": ["a@1.2.3", "", {}, "${SHA}"],
        "@s/b": ["@s/b@2.0.0-rc.1", "", { "os": "linux" }, "${SHA}"],
        "ts-api": ["typescript@5.9.3", "https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz", {}, "${SHA}"],
      },
    }`;
    const manifest = '{"dependencies":{"a":"^1.0.0","@s/b":"2.0.0-rc.1"},"devDependencies":{"ts-api":"npm:typescript@^5.9.0","c":"latest"}}';
    expect(fillable(manifest, lock, registry)).toEqual({ ok: true, value: undefined });
  });

  test("anything the registry does not serve by name keeps the fill off the host", () => {
    const deny = (manifest: string, lock: string): string => {
      const result = fillable(manifest, lock, registry);
      if (result.ok) throw new Error("filled");
      return result.error;
    };
    const plain = "{}";
    expect(deny(plain, lockOf({ x: ["x@1.0.0", "http://10.0.0.1/x.tgz", {}, SHA] }))).toContain("another registry");
    expect(deny(plain, lockOf({ x: ["x@github:o/r#abc", {}, "o-r-abc"] }))).toContain("not a registry package");
    expect(deny(plain, lockOf({ x: ["x@file:../../etc", {}] }))).toContain("not a registry package");
    expect(deny(plain, lockOf({ x: ["x@1.0.0", "", {}, "sha1-abc"] }))).toContain("sha512");
    expect(deny(plain, lockOf({}, { "": {}, "packages/a": {} }))).toBe("workspaces");
    expect(deny('{"workspaces":["packages/*"]}', lockOf({}))).toBe("workspaces");
    expect(deny('{"dependencies":{"x":"file:../x"}}', lockOf({}))).toContain("x is not a registry dependency");
    expect(deny('{"dependencies":{"x":"o/r"}}', lockOf({}))).toContain("x is not a registry dependency");
    expect(deny('{"dependencies":{"x":"git+https://h/r.git"}}', lockOf({}))).toContain("x is not");
    expect(deny(plain, "not json")).toContain("does not parse");
    expect(deny(plain, JSON.stringify({ lockfileVersion: 1, workspaces: { "": {} }, patchedDependencies: {} }))).toBe(
      "patched dependencies",
    );
  });

  test("an override or resolution that is not a registry version keeps the fill off the host", () => {
    const deny = (manifest: string, lock: string): string => {
      const result = fillable(manifest, lock, registry);
      if (result.ok) throw new Error("filled");
      return result.error;
    };
    expect(deny('{"overrides":{"x":"file:../../etc"}}', lockOf({}))).toBe("overrides: x is not a registry version");
    expect(deny('{"overrides":{"a":{"x":"github:o/r"}}}', lockOf({}))).toBe("overrides: x is not a registry version");
    expect(deny('{"resolutions":{"x":"https://h/x.tgz"}}', lockOf({}))).toBe("resolutions: x is not a registry version");
    const locked = JSON.stringify({ lockfileVersion: 1, workspaces: { "": {} }, overrides: { x: "link:x" }, packages: {} });
    expect(deny("{}", locked)).toBe("overrides: x is not a registry version");
    const pinned = '{"overrides":{"x":"1.2.3","a":{"y":"^2.0.0"}},"resolutions":{"z":"~3.1.0"}}';
    expect(fillable(pinned, lockOf({}), registry)).toEqual({ ok: true, value: undefined });
  });
});

describe("lockfileRefusal: the fill asks fillable too", () => {
  const registry = "https://registry.npmjs.org/";
  const checkout = (manifest: string, lock: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "fillable-"));
    writeFileSync(join(dir, "package.json"), manifest);
    writeFileSync(join(dir, "bun.lock"), lock);
    return dir;
  };

  test("a registry lockfile with sha512 integrities is filled", () => {
    const dir = checkout('{"dependencies":{"a":"1.2.3"}}', lockOf({ a: ["a@1.2.3", "", {}, SHA] }));
    try {
      expect(lockfileRefusal(dir, registry)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no URL and no git, yet a file dependency, a workspace or a weak integrity is still refused", () => {
    const cases: [string, string, string][] = [
      ['{"dependencies":{"x":"file:../../etc"}}', lockOf({ x: ["x@file:../../etc", {}] }), "not a registry"],
      ['{"workspaces":["packages/*"]}', lockOf({}), "workspaces"],
      ["{}", lockOf({ x: ["x@1.0.0", "", {}, "sha1-abc"] }), "sha512"],
    ];
    for (const [manifest, lock, why] of cases) {
      const dir = checkout(manifest, lock);
      try {
        expect(lockfileRefusal(dir, registry)).toContain(why);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
