/**
 * The toolchains an app may pin in `forge.json` (`"toolchain": {"rust":
 * "1.82"}`): which the forge knows and which versions it provides. This
 * module only names and validates; nothing here installs or downloads.
 */

import { err, ok, type Result } from "../kernel/result.ts";

/** Every toolchain the forge knows, with the versions it provides. */
export const TOOLCHAINS = {
  rust: ["1.82"],
} as const satisfies Record<string, readonly string[]>;

export type ToolchainName = keyof typeof TOOLCHAINS;

/** A validated pin: toolchain name to a version this forge provides. */
export type ToolchainPin = Readonly<Partial<Record<ToolchainName, string>>>;

const VERSION_RE = /^\d{1,3}\.\d{1,3}$/;

const isName = (name: string): name is ToolchainName =>
  Object.hasOwn(TOOLCHAINS, name);

/** The `toolchain` value of `forge.json`; `undefined` (absent) is no pin. */
export function parseToolchain(value: unknown): Result<ToolchainPin | undefined, string> {
  if (value === undefined) return ok(undefined);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return err('forge.json: toolchain must be an object like {"rust": "1.82"}');
  const pin: Partial<Record<ToolchainName, string>> = {};
  for (const [name, version] of Object.entries(value)) {
    if (!isName(name))
      return err(
        `forge.json: toolchain ${name.replace(/[\x00-\x1f\x7f]/g, "?").slice(0, 40)} is not known here; this forge knows ${Object.keys(TOOLCHAINS).join(", ")}`,
      );
    if (typeof version !== "string" || !VERSION_RE.test(version))
      return err(`forge.json: toolchain.${name} must be a version like "${TOOLCHAINS[name][0]}"`);
    const have: readonly string[] = TOOLCHAINS[name];
    if (!have.includes(version))
      return err(
        `forge.json: ${name} ${version} is not provided here; this forge has ${name} ${have.join(", ")}`,
      );
    pin[name] = version;
  }
  return ok(Object.keys(pin).length === 0 ? undefined : pin);
}
