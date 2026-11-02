/**
 * Whether the forge may fill a repository's shared bun cache from a commit's
 * lockfile (#7543, #7541). The fill runs on the host, outside a cell's
 * egress (`checks/install.ts`, `prefillInstallCache`), so a lockfile is
 * filled only when every package in it is a plain `name@version` from the
 * pinned registry with a sha512 integrity bun checks: no tarball URL, git,
 * file, link or workspace dependency, and no patches. Anything else installs
 * as before, into the cell's own cache.
 */

import { err, ok, type Result } from "../kernel/result.ts";

/** `name@1.2.3` or `@scope/name@1.2.3-pre+build`: a registry package at one version. */
const REGISTRY_ID = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@\d+\.\d+\.\d+[\w.+-]*$/i;

/** A dependency range or tag, optionally an `npm:` alias: never a path, URL, git or workspace spec. */
const REGISTRY_SPEC = /^(npm:(@[\w.-]+\/)?[\w.-]+@)?[\w\s.^~<>=|*+-]*$/;

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];

/**
 * Whether the forge may fill the shared cache from this `package.json` and
 * `bun.lock`: an Err names what keeps it out. Every package must come from
 * `registry` by name and version, with a sha512 integrity bun checks.
 */
export function fillable(packageJson: string, lock: string, registry: string): Result<void, string> {
  let manifest: unknown;
  let parsed: unknown;
  try {
    manifest = JSON.parse(packageJson);
    parsed = Bun.JSONC.parse(lock);
  } catch {
    return err("package.json or bun.lock does not parse");
  }
  if (!isRecord(manifest) || !isRecord(parsed)) return err("package.json or bun.lock is not an object");
  if (manifest["workspaces"] !== undefined) return err("workspaces");
  for (const field of DEPENDENCY_FIELDS) {
    const deps = manifest[field];
    if (deps === undefined) continue;
    if (!isRecord(deps)) return err(`${field} is not an object`);
    for (const [name, spec] of Object.entries(deps))
      if (typeof spec !== "string" || !REGISTRY_SPEC.test(spec))
        return err(`${name} is not a registry dependency`);
  }
  if (parsed["patchedDependencies"] !== undefined) return err("patched dependencies");
  // An override replaces a package wherever it is locked: a path, URL or git
  // spec in one is as much the host's fetch as a dependency's would be.
  for (const [where, field] of [[manifest, "overrides"], [manifest, "resolutions"], [parsed, "overrides"]] as const) {
    const bad = field in where ? nonRegistry(where[field]) : undefined;
    if (bad !== undefined) return err(`${field}: ${bad} is not a registry version`);
  }
  const workspaces = parsed["workspaces"];
  if (!isRecord(workspaces) || Object.keys(workspaces).some((key) => key !== ""))
    return err("workspaces");
  const packages = parsed["packages"] ?? {};
  if (!isRecord(packages)) return err("bun.lock has no packages");
  let origin: string;
  try {
    origin = new URL(registry).origin;
  } catch {
    return err("the registry is not a URL");
  }
  for (const [key, entry] of Object.entries(packages)) {
    if (!Array.isArray(entry) || entry.length !== 4) return err(`${key} is not a registry package`);
    const [id, url, , integrity] = entry as unknown[];
    if (typeof id !== "string" || !REGISTRY_ID.test(id)) return err(`${key} is not a registry package`);
    if (url !== "" && !(typeof url === "string" && sameOrigin(url, origin)))
      return err(`${key} comes from another registry`);
    if (typeof integrity !== "string" || !integrity.startsWith("sha512-"))
      return err(`${key} has no sha512 integrity`);
  }
  return ok(undefined);
}

/** The first override spec that is not a registry range, nested ones included; undefined when all are. */
function nonRegistry(value: unknown, name = "overrides"): string | undefined {
  if (typeof value === "string") return REGISTRY_SPEC.test(value) ? undefined : name;
  if (!isRecord(value)) return name;
  for (const [key, inner] of Object.entries(value)) {
    const bad = nonRegistry(inner, key);
    if (bad !== undefined) return bad;
  }
  return undefined;
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
