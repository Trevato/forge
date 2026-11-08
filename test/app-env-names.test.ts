import { describe, expect, test } from "bun:test";
import {
  APP_ENV_SCOPES,
  isAppEnvName,
  isAppEnvScope,
  isReservedAppEnvName,
  NAME_MAX,
  scopeOfEnv,
} from "../src/core/app_env.ts";

describe("isAppEnvName", () => {
  test("accepts shell-style upper-case names up to NAME_MAX", () => {
    for (const n of ["A", "API_KEY", "X1", "A".repeat(NAME_MAX)])
      expect(isAppEnvName(n)).toBe(true);
  });

  test("refuses empty, lower-case, leading digit or underscore, and odd characters", () => {
    for (const n of ["", "api_key", "1A", "_A", "A-B", "A B", "A".repeat(NAME_MAX + 1)])
      expect(isAppEnvName(n)).toBe(false);
  });
});

describe("isReservedAppEnvName", () => {
  test("is true for every name the forge sets itself", () => {
    for (const n of ["PORT", "HOST", "NODE_ENV", "PATH", "HOME", "LANG", "TMPDIR", "USER", "LOGNAME"])
      expect(isReservedAppEnvName(n)).toBe(true);
  });

  test("is true for any FORGE_ prefix", () => {
    for (const n of ["FORGE_APP_DATA", "FORGE_X"])
      expect(isReservedAppEnvName(n)).toBe(true);
  });

  test("is false for look-alikes", () => {
    for (const n of ["FORGEX", "MY_FORGE_X", "API_KEY"])
      expect(isReservedAppEnvName(n)).toBe(false);
  });
});

describe("scopes", () => {
  test("isAppEnvScope accepts each scope and nothing else", () => {
    for (const s of APP_ENV_SCOPES) expect(isAppEnvScope(s)).toBe(true);
    for (const s of ["Production", "", "dev"]) expect(isAppEnvScope(s)).toBe(false);
  });

  test("scopeOfEnv maps production to production and every other environment to preview", () => {
    expect(scopeOfEnv("production")).toBe("production");
    expect(scopeOfEnv("preview")).toBe("preview");
    expect(scopeOfEnv("4417")).toBe("preview");
    expect(scopeOfEnv("")).toBe("preview");
  });
});
