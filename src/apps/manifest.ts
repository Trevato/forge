/**
 * How an app says it runs: `forge.json` at the root of the commit being
 * deployed. It is read from the tree, never from the database, so a pull
 * that changes how the app starts is previewed the way it will run.
 *
 * Fail closed. A file that is present and wrong is a deploy that fails with
 * the reason in its log, never a guess at what was meant. A file that is
 * absent falls back to the one convention everyone already has — a
 * `package.json` with a `start` script — and a repository with neither is
 * simply not an app yet, which the surfaces say in those words.
 */

import { err, ok, type Result } from "../kernel/result.ts";

export interface AppManifest {
  /** The command that serves on `$PORT`. Run through `sh -c`, `exec`-ed. */
  readonly run: string;
  /** Runs before `run`, in the checkout. `null` skips it. */
  readonly install: string | null;
  /** Runs after `install`; a non-zero exit fails the deploy. `null` skips. */
  readonly test: string | null;
  /** The path polled until the app answers. */
  readonly health: string;
  /** Seconds to wait for `health` before the deploy fails. */
  readonly ready: number;
  /**
   * The app's terminal interface: a command run on a pty when someone
   * `ssh`es to the app (`<slug>@forge`), in the deployed checkout with the
   * environment's own variables. `null` means the app has none.
   */
  readonly tty: string | null;
}

export type ManifestError =
  /** Neither `forge.json` nor a `package.json` start script. */
  | { readonly kind: "not_an_app" }
  /** A file was present and wrong; `message` names the field. */
  | { readonly kind: "invalid"; readonly message: string };

const READY_DEFAULT = 30;
const READY_MAX = 600;
const COMMAND_MAX = 1_000;

/**
 * Resolve a manifest from the two files that can declare one. `forgeJson`
 * and `packageJson` are the file contents at the commit, or `undefined`
 * when the path is absent from the tree.
 */
export function parseManifest(
  forgeJson: string | undefined,
  packageJson: string | undefined,
): Result<AppManifest, ManifestError> {
  const pkg = packageJson === undefined ? undefined : readPackage(packageJson);
  if (pkg !== undefined && !pkg.ok) return pkg;
  const hasDeps = pkg?.value.hasDeps ?? false;
  const start = pkg?.value.start;

  if (forgeJson === undefined) {
    if (start === undefined) return err({ kind: "not_an_app" });
    return ok({
      run: start,
      install: hasDeps ? "bun install" : null,
      test: null,
      health: "/",
      ready: READY_DEFAULT,
      tty: null,
    });
  }

  const parsed = parseJson(forgeJson, "forge.json");
  if (!parsed.ok) return parsed;
  const app = parsed.value["app"];
  if (app === undefined) return err({ kind: "not_an_app" });
  if (!isObject(app)) return invalid("forge.json: app must be an object");

  const run = command(app, "run");
  if (!run.ok) return run;
  const runCommand = run.value ?? start;
  if (runCommand === undefined)
    return invalid(
      "forge.json: app.run is required (no package.json start script to fall back on)",
    );
  const install = command(app, "install");
  if (!install.ok) return install;
  const test = command(app, "test");
  if (!test.ok) return test;
  const tty = command(app, "tty");
  if (!tty.ok) return tty;

  const health = app["health"];
  if (
    health !== undefined &&
    (typeof health !== "string" || !health.startsWith("/"))
  )
    return invalid("forge.json: app.health must be a path starting with /");
  const ready = app["ready"];
  if (
    ready !== undefined &&
    (typeof ready !== "number" ||
      !Number.isInteger(ready) ||
      ready < 1 ||
      ready > READY_MAX)
  )
    return invalid(
      `forge.json: app.ready must be a whole number of seconds, 1–${READY_MAX}`,
    );

  return ok({
    run: runCommand,
    // `install` unset means "whatever the package says"; an explicit empty
    // string means "nothing", which is how an app opts out of bun install.
    install:
      install.value === undefined
        ? hasDeps
          ? "bun install"
          : null
        : install.value || null,
    test: test.value ?? null,
    health: health ?? "/",
    ready: ready ?? READY_DEFAULT,
    tty: tty.value || null,
  });
}

/** Whether `forge.json` declares an app at all, without validating it. */
export function declaresApp(forgeJson: string | undefined): boolean {
  if (forgeJson === undefined) return false;
  const parsed = parseJson(forgeJson, "forge.json");
  return parsed.ok && parsed.value["app"] !== undefined;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const invalid = (message: string): Result<never, ManifestError> =>
  err({ kind: "invalid", message });

function parseJson(source: string, name: string): Result<Json, ManifestError> {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    return invalid(
      `${name}: ${error instanceof Error ? error.message : "not JSON"}`,
    );
  }
  if (!isObject(value)) return invalid(`${name}: must be a JSON object`);
  return ok(value);
}

/** A command field: absent, or a bounded non-empty string. */
function command(
  app: Json,
  key: string,
): Result<string | undefined, ManifestError> {
  const value = app[key];
  if (value === undefined) return ok(undefined);
  if (typeof value !== "string")
    return invalid(`forge.json: app.${key} must be a string`);
  if (value.length > COMMAND_MAX)
    return invalid(
      `forge.json: app.${key} is longer than ${COMMAND_MAX} characters`,
    );
  if (value.includes("\0") || value.includes("\n"))
    return invalid(`forge.json: app.${key} must be one line`);
  return ok(value.trim());
}

function readPackage(
  source: string,
): Result<{ start: string | undefined; hasDeps: boolean }, ManifestError> {
  const parsed = parseJson(source, "package.json");
  if (!parsed.ok) return parsed;
  const scripts = parsed.value["scripts"];
  const rawStart = isObject(scripts) ? scripts["start"] : undefined;
  const start =
    typeof rawStart === "string" && rawStart.trim() !== ""
      ? "bun run start"
      : undefined;
  const hasDeps =
    hasKeys(parsed.value["dependencies"]) ||
    hasKeys(parsed.value["devDependencies"]);
  return ok({ start, hasDeps });
}

const hasKeys = (value: unknown): boolean =>
  isObject(value) && Object.keys(value).length > 0;
