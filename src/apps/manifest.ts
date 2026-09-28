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
  /**
   * The pages worth a look: each pictured at every width, once a deploy
   * comes up green. `["/"]` when the manifest says nothing, exactly as
   * before this field existed.
   */
  readonly looks: readonly string[];
}

export type ManifestError =
  /** Neither `forge.json` nor a `package.json` start script. */
  | { readonly kind: "not_an_app" }
  /** A file was present and wrong; `message` names the field. */
  | { readonly kind: "invalid"; readonly message: string };

const READY_DEFAULT = 30;
const READY_MAX = 600;
const COMMAND_MAX = 1_000;
/** More than this many pages is a manifest error: a browser start per
 * picture per width is the heaviest thing the forge does. */
const LOOKS_MAX = 3;
const LOOK_PATH_MAX = 200;

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
      looks: ["/"],
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
  const looks = looksField(app);
  if (!looks.ok) return looks;

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
    looks: looks.value,
  });
}

/**
 * `app.looks`: the pages worth a picture. Absent is `["/"]`, exactly as
 * before this field existed. Validated like any other boundary input — a
 * path beginning with `/`, no scheme, no host, no `..`, no control bytes,
 * capped in length — and capped in count, because a browser start per
 * picture per width is the heaviest thing the forge does.
 */
function looksField(app: Json): Result<readonly string[], ManifestError> {
  const value = app["looks"];
  if (value === undefined) return ok(["/"]);
  if (!Array.isArray(value))
    return invalid("forge.json: app.looks must be an array of paths");
  if (value.length > LOOKS_MAX)
    return invalid(`forge.json: app.looks may name at most ${LOOKS_MAX} paths`);
  if (value.length === 0) return ok(["/"]);
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item !== "string")
      return invalid("forge.json: app.looks entries must be strings");
    if (item.length > LOOK_PATH_MAX)
      return invalid(
        `forge.json: app.looks entries must be at most ${LOOK_PATH_MAX} characters`,
      );
    if (!item.startsWith("/") || item.startsWith("//"))
      return invalid(
        "forge.json: app.looks entries must be a path starting with / (no scheme, no host)",
      );
    if (item.includes(".."))
      return invalid("forge.json: app.looks entries must not contain ..");
    if (/[\x00-\x1f\x7f]/.test(item))
      return invalid(
        "forge.json: app.looks entries must not contain control characters",
      );
    paths.push(item);
  }
  return ok(paths);
}

/**
 * How a repository checks a change: `check` in `forge.json`, beside or
 * instead of `app`. Run on every push a pull or the default branch takes,
 * whether or not the repository is an app; an app's own `test` still runs
 * inside its deploy.
 */
export interface CheckManifest {
  /** The command; a non-zero exit fails the check. Run through `sh -c`. */
  readonly run: string;
  /** Runs first, in the checkout. `null` skips it. */
  readonly install: string | null;
  /** Seconds the check may take before it fails. */
  readonly timeout: number;
}

const CHECK_TIMEOUT_DEFAULT = 20 * 60;
const CHECK_TIMEOUT_MAX = 2 * 60 * 60;

/**
 * The check a commit declares, `undefined` when it declares none. Fails
 * closed like the app manifest: a `check` that is present and wrong is a
 * check that fails with the reason, never a commit that goes unchecked.
 */
export function parseCheck(
  forgeJson: string | undefined,
  packageJson: string | undefined,
): Result<CheckManifest | undefined, ManifestError> {
  if (forgeJson === undefined) return ok(undefined);
  const parsed = parseJson(forgeJson, "forge.json");
  if (!parsed.ok) return parsed;
  const check = parsed.value["check"];
  if (check === undefined) return ok(undefined);
  if (!isObject(check)) return invalid("forge.json: check must be an object");
  const run = command(check, "run", "check");
  if (!run.ok) return run;
  if (run.value === undefined || run.value === "")
    return invalid("forge.json: check.run is required");
  const install = command(check, "install", "check");
  if (!install.ok) return install;
  const pkg = packageJson === undefined ? undefined : readPackage(packageJson);
  if (pkg !== undefined && !pkg.ok) return pkg;
  const timeout = check["timeout"];
  if (
    timeout !== undefined &&
    (typeof timeout !== "number" ||
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      timeout > CHECK_TIMEOUT_MAX)
  )
    return invalid(
      `forge.json: check.timeout must be a whole number of seconds, 1–${CHECK_TIMEOUT_MAX}`,
    );
  return ok({
    run: run.value,
    install:
      install.value === undefined
        ? (pkg?.value.hasDeps ?? false)
          ? "bun install"
          : null
        : install.value || null,
    timeout: timeout ?? CHECK_TIMEOUT_DEFAULT,
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
  section: Json,
  key: string,
  name = "app",
): Result<string | undefined, ManifestError> {
  const value = section[key];
  if (value === undefined) return ok(undefined);
  if (typeof value !== "string")
    return invalid(`forge.json: ${name}.${key} must be a string`);
  if (value.length > COMMAND_MAX)
    return invalid(
      `forge.json: ${name}.${key} is longer than ${COMMAND_MAX} characters`,
    );
  if (value.includes("\0") || value.includes("\n"))
    return invalid(`forge.json: ${name}.${key} must be one line`);
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
