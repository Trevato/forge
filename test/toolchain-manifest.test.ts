import { describe, expect, test } from "bun:test";
import { parseManifest } from "../src/apps/manifest.ts";

const parse = (extra: Record<string, unknown>) =>
  parseManifest(JSON.stringify({ app: { run: "bun x" }, ...extra }), undefined);
const message = (r: ReturnType<typeof parse>) =>
  !r.ok && r.error.kind === "invalid" ? r.error.message : "";

describe("forge.json toolchain", () => {
  test("a provided version is parsed", () => {
    const r = parse({ toolchain: { rust: "1.82" } });
    expect(r.ok && r.value.toolchain).toEqual({ rust: "1.82" });
  });
  test("an unknown toolchain fails naming what is known", () => {
    const m = message(parse({ toolchain: { go: "1.22" } }));
    expect(m).toContain("go");
    expect(m).toContain("rust");
  });
  test("an unknown name with control characters stays one line", () => {
    const m = message(parse({ toolchain: { "go\nrm\x07": "1" } }));
    expect(m).toContain("go?rm?");
    expect(m).not.toMatch(/[\x00-\x1f\x7f]/);
  });
  test("a malformed version fails", () => {
    for (const v of ["latest", "1", "1.82.0", 1.82, "", null])
      expect(message(parse({ toolchain: { rust: v } }))).toContain("toolchain.rust");
    expect(message(parse({ toolchain: "rust" }))).toContain("toolchain must be an object");
    expect(message(parse({ toolchain: ["rust"] }))).toContain("toolchain must be an object");
  });
  test("an unprovided version fails in one plain line", () => {
    const m = message(parse({ toolchain: { rust: "1.70" } }));
    expect(m).toContain("rust 1.70 is not provided here; this forge has rust 1.82");
    expect(m).not.toContain("\n");
  });
  test("absent deploys as before", () => {
    const r = parse({});
    expect(r.ok && r.value.toolchain).toBeUndefined();
    expect(r.ok && "toolchain" in r.value).toBe(false);
  });
});
