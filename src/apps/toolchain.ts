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

/**
 * Where the host keeps its toolchains: `$FORGE_TOOLCHAINS/<name>/<version>/`,
 * read-only, laid out as `bin/` (cargo, rustc), `cargo/` and `rustup/`.
 * An admin adds a version by unpacking it there (docs/features/toolchains.md);
 * nothing is ever fetched at deploy time.
 */
export function toolchainRoot(): string | undefined {
  const root = process.env["FORGE_TOOLCHAINS"];
  return root === undefined || root === "" ? undefined : root;
}

/** What a pinned toolchain adds to a step or the app: env, and the directory a cell must show. */
export interface ToolchainUse {
  readonly env: Record<string, string>;
  readonly reveal: readonly string[];
}

/**
 * The environment for a pin, from files already on the host. Synchronous
 * and offline by construction: it only checks the directory is there.
 * `scratch` is a writable place for CARGO_HOME (the registry cache and
 * locks cargo writes), since the toolchain itself is read-only.
 */
export function toolchainUse(
  pin: ToolchainPin | undefined,
  scratch: string,
  root: string | undefined = toolchainRoot(),
): Result<ToolchainUse | undefined, string> {
  const version = pin?.rust;
  if (version === undefined) return ok(undefined);
  const dir = root === undefined ? undefined : `${root.replace(/\/+$/, "")}/rust/${version}`;
  if (dir === undefined || !Bun.file(`${dir}/bin/cargo`).size)
    return err(`rust ${version} is pinned but not installed on this host`);
  return ok({
    env: {
      PATH: `${dir}/bin:${process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"}`,
      CARGO_HOME: `${scratch.replace(/\/+$/, "")}/.cargo`,
      RUSTUP_HOME: `${dir}/rustup`,
      // Never let a proxy binary go and fetch another toolchain.
      RUSTUP_TOOLCHAIN: version,
    },
    reveal: [dir],
  });
}
