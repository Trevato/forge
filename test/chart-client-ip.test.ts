import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The chart can say who the client is behind a proxy (README, Signup):
// FORGE_TRUSTED_PROXIES and FORGE_CLIENT_IP_HEADER come from optional
// values, and a release that sets neither gets neither.
const chart = (file: string) =>
  readFileSync(join(import.meta.dir, "../charts/app", file), "utf8");

describe("the chart's client address settings", () => {
  for (const [value, env] of [
    ["trustedProxies", "FORGE_TRUSTED_PROXIES"],
    ["clientIpHeader", "FORGE_CLIENT_IP_HEADER"],
  ] as const) {
    test(`${env} is set only from forge.${value}`, () => {
      const slot = new RegExp(
        `\\{\\{- with \\.Values\\.forge\\.${value} \\}\\}\\n(?:\\s*#.*\\n)*\\s*- name: ${env}\\n\\s*value: \\{\\{ \\. \\| quote \\}\\}\\n\\s*\\{\\{- end \\}\\}`,
      );
      expect(chart("templates/deployment.yaml")).toMatch(slot);
    });
    test(`forge.${value} is unset by default`, () => {
      expect(chart("values.yaml")).not.toMatch(new RegExp(`^\\s*${value}:`, "m"));
    });
  }
});
