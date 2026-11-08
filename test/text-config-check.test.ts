import { expect, test } from "bun:test";
import { checkConfig, configKind } from "../src/text/config_check.ts";

test("the kind follows the extension", () => {
  expect(configKind("a/b.JSON")).toBe("json");
  expect(configKind("x.yml")).toBe("yaml");
  expect(configKind("x.yaml")).toBe("yaml");
  expect(configKind("x.toml")).toBe("toml");
  expect(configKind("x.ts")).toBeNull();
});

test("valid files parse", () => {
  expect(checkConfig("json", '{"a":1}')).toEqual({ ok: true });
  expect(checkConfig("yaml", "a: 1\nb: [1, 2]\n")).toEqual({ ok: true });
  expect(checkConfig("toml", "a = 1\n")).toEqual({ ok: true });
});

test("a broken file names its line and column", () => {
  expect(checkConfig("json", '{\n "a": 1,\n "b": }')).toMatchObject({ ok: false, line: 3, column: 7 });
  expect(checkConfig("yaml", 'a: 1\nb: "x')).toMatchObject({ ok: false, line: 2 });
  expect(checkConfig("toml", "a = 1\nb = \nc = 3")).toMatchObject({ ok: false, line: 3 });
});
