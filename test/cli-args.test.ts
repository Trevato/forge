import { describe, expect, test } from "bun:test";
import { parseArgs, parseDuration, parseRepoRef } from "../src/cli/args.ts";

describe("parseArgs", () => {
  test("the first word is the command, the rest are positionals", () => {
    const a = parseArgs(["run", "one", "two"]);
    expect(a.command).toBe("run");
    expect(a.positional).toEqual(["one", "two"]);
  });

  test("no words means no command", () => {
    const a = parseArgs([]);
    expect(a.command).toBeUndefined();
    expect(a.positional).toEqual([]);
  });

  test("a declared value flag takes the next word", () => {
    const a = parseArgs(["scan", "--root", "src", "x"], { values: ["root"] });
    expect(a.value("root")).toBe("src");
    expect(a.flag("root")).toBe(true);
    expect(a.positional).toEqual(["x"]);
  });

  test("an undeclared flag is a boolean and leaves the next word positional", () => {
    const a = parseArgs(["scan", "--root", "src"]);
    expect(a.flag("root")).toBe(true);
    expect(a.value("root")).toBeUndefined();
    expect(a.positional).toEqual(["src"]);
  });

  test("a declared value flag followed by a flag, or nothing, stays boolean", () => {
    const a = parseArgs(["c", "--root", "--other"], { values: ["root"] });
    expect(a.value("root")).toBeUndefined();
    expect(a.flag("root")).toBe(true);
    expect(a.flag("other")).toBe(true);
    const b = parseArgs(["c", "--root"], { values: ["root"] });
    expect(b.value("root")).toBeUndefined();
    expect(b.flag("root")).toBe(true);
  });

  test("an absent flag is false", () => {
    expect(parseArgs(["c"]).flag("nope")).toBe(false);
  });

  test("--key=value is supported, with or without a declaration", () => {
    const a = parseArgs(["c", "--root=src", "--eq=a=b"]);
    expect(a.value("root")).toBe("src");
    expect(a.value("eq")).toBe("a=b");
    expect(a.positional).toEqual([]);
  });

  test("short flags are booleans, one per letter", () => {
    const a = parseArgs(["c", "-hv"]);
    expect(a.flag("h")).toBe(true);
    expect(a.flag("v")).toBe(true);
  });

  test("a lone dash is a positional", () => {
    expect(parseArgs(["c", "-"]).positional).toEqual(["-"]);
  });

  test("after -- every word is positional, even --x", () => {
    const a = parseArgs(["c", "--a", "--", "--x", "-v", "--"]);
    expect(a.flag("a")).toBe(true);
    expect(a.flag("x")).toBe(false);
    expect(a.flag("v")).toBe(false);
    expect(a.positional).toEqual(["--x", "-v", "--"]);
  });

  test("-- before the command makes the command positional too", () => {
    const a = parseArgs(["--", "--weird"]);
    expect(a.command).toBe("--weird");
  });
});

describe("parseDuration", () => {
  test("units and bare seconds, in milliseconds", () => {
    expect(parseDuration("250ms")).toBe(250);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("90")).toBe(90_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("1.5s")).toBe(1500);
  });

  test("anything else is undefined", () => {
    for (const bad of ["", "5d", "-1s", "s", undefined]) {
      expect(parseDuration(bad)).toBeUndefined();
    }
  });
});

describe("parseDuration trimming", () => {
  test("surrounding whitespace is ignored", () => {
    expect(parseDuration(" 5m ")).toBe(300_000);
  });

  test("a malformed decimal is rejected", () => {
    expect(parseDuration("1.5.2s")).toBeUndefined();
  });
});

describe("parseRepoRef", () => {
  test("owner/name is a pair", () => {
    expect(parseRepoRef("trevato/forge")).toEqual({ owner: "trevato", name: "forge" });
  });

  test("one part, three parts, empty and undefined are rejected", () => {
    expect(parseRepoRef("forge")).toBeUndefined();
    expect(parseRepoRef("a/b/c")).toBeUndefined();
    expect(parseRepoRef("")).toBeUndefined();
    expect(parseRepoRef(undefined)).toBeUndefined();
  });
});
