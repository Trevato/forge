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

import { isIP } from "node:net";
import { err, ok, type Result } from "../kernel/result.ts";
import { parseService, type ServiceSpec } from "./service.ts";
import type { DeclaredLimits } from "./contain.ts";
import { isPublicAddress } from "./egress.ts";
import { isLaunch, LAUNCHES, type Launch } from "../git/builds.ts";
import { parseAdapter, type AdapterSpec } from "./adapter.ts";
import { parseToolchain, type ToolchainPin } from "./toolchain.ts";
import { parseSchedules, type ScheduleSpec } from "./schedule_spec.ts";

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
  /**
   * `app.looksAsOwner`: the pages of `looks` whose phone and desktop
   * pictures are taken signed in as the owner, even of a public app —
   * the pages a stranger is shown nothing on (`looks/service.ts`). Unset
   * or empty is none, exactly as before this field existed.
   */
  readonly looksAsOwner?: readonly string[] | undefined;
  /** `app.pages`: paths the app serves as one self-contained page, offered to play and download. */
  readonly pages?: readonly string[] | undefined;
  /** `app.launch`: how this repository's demos open unless a pin says otherwise. */
  readonly launch?: Launch | undefined;
  /**
   * `app.always_on: true`: production never sleeps, whatever the profit
   * slider says (docs/PROFIT.md) — the one per-app exception. Previews
   * still follow the forge. Unset or false follows the slider.
   */
  readonly alwaysOn?: true | undefined;
  /**
   * Set when `app.kind` is `"service"`: declared TCP ports, always on,
   * a placement preference and synced volumes. `null` for an ordinary
   * HTTP app.
   */
  readonly service: ServiceSpec | null;
  /**
   * Hosts the app's processes may reach (`egress`, top level of
   * `forge.json`, shared with the check). Everything else is refused at the
   * cell's proxy (`apps/contain.ts`). Empty when nothing is declared.
   */
  readonly egress?: readonly string[] | undefined;
  /** `app.limits`: the app process's memory, CPU and disk, within the machine's maximum. */
  readonly limits?: DeclaredLimits | undefined;
  /**
   * `toolbar` (top level of `forge.json`): `false` keeps the forge's pill
   * out of the app's HTML pages. Unset is on.
   */
  readonly toolbar?: boolean | undefined;
  /**
   * `adapter` (top level of `forge.json`): the app is pulled from on a
   * schedule (`apps/adapter.ts`). Unset is not an adapter.
   */
  readonly adapter?: AdapterSpec | undefined;
  /** `toolchain` (top level of `forge.json`): pinned toolchain versions. Unset is none. */
  readonly toolchain?: ToolchainPin | undefined;
  /** `schedules` (top level of `forge.json`): calls the forge makes on a clock (`apps/schedule_spec.ts`). Unset is none. */
  readonly schedules?: readonly ScheduleSpec[] | undefined;
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
 * picture per width is the heaviest thing the forge does. Room for every
 * top-level page of the forge itself. */
const LOOKS_MAX = 24;
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
      service: null,
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
  const looksAsOwner = looksAsOwnerField(app, looks.value);
  if (!looksAsOwner.ok) return looksAsOwner;
  const pages = pagesField(app);
  if (!pages.ok) return pages;
  const launch = app["launch"];
  if (launch !== undefined && !isLaunch(launch))
    return invalid(`forge.json: app.launch must be one of ${LAUNCHES.map((l) => `"${l}"`).join(", ")}`);
  const alwaysOn = app["always_on"];
  if (alwaysOn !== undefined && typeof alwaysOn !== "boolean")
    return invalid("forge.json: app.always_on must be true or false");
  const egress = egressField(parsed.value);
  if (!egress.ok) return egress;
  const limits = limitsField(app, "app");
  if (!limits.ok) return limits;
  const toolbar = parsed.value["toolbar"];
  if (toolbar !== undefined && typeof toolbar !== "boolean")
    return invalid("forge.json: toolbar must be true or false");
  const adapter = parseAdapter(parsed.value["adapter"]);
  if (!adapter.ok) return invalid(adapter.error);
  const toolchain = parseToolchain(parsed.value["toolchain"]);
  if (!toolchain.ok) return invalid(toolchain.error);
  // Only `egress` opens a host (docs/ADAPTERS.md): a source host it does
  // not list would be refused by the proxy, so the block is invalid.
  const unopened = adapter.value?.source?.hosts.find(
    (h) => !(egress.value ?? []).some((e) => e.toLowerCase() === h),
  );
  if (unopened !== undefined)
    return invalid(`forge.json: adapter.source.hosts names ${unopened}, which egress does not list`);
  const schedules = parseSchedules(parsed.value["schedules"]);
  if (!schedules.ok) return invalid(schedules.error);
  const kind = app["kind"];
  if (kind !== undefined && kind !== "web" && kind !== "service")
    return invalid('forge.json: app.kind must be "web" or "service"');
  let service: ServiceSpec | null = null;
  if (kind === "service") {
    const spec = parseService(app);
    if (!spec.ok) return err({ kind: "invalid", message: spec.error.message });
    service = spec.value;
  }

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
    looksAsOwner: looksAsOwner.value,
    pages: pages.value,
    ...(launch === undefined ? {} : { launch }),
    ...(alwaysOn === true ? { alwaysOn: true as const } : {}),
    service,
    egress: egress.value,
    limits: limits.value,
    toolbar: toolbar ?? true,
    ...(adapter.value === undefined ? {} : { adapter: adapter.value }),
    ...(toolchain.value === undefined ? {} : { toolchain: toolchain.value }),
    ...(schedules.value.length === 0 ? {} : { schedules: schedules.value }),
  });
}

const EGRESS_MAX = 32;
const HOST_RE =
  /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?(:[1-9]\d{0,4})?$/;

/**
 * `egress`: the hosts this repository's code may reach — exact names, or
 * `*.example.com` for every name below one, on ports 80 and 443; a
 * `:port` suffix names one other port instead. Absent is none: the app
 * reaches the forge and nothing else; install steps also reach the npm
 * registry.
 */
function egressField(root: Json): Result<readonly string[], ManifestError> {
  const value = root["egress"];
  if (value === undefined) return ok([]);
  if (!Array.isArray(value))
    return invalid("forge.json: egress must be an array of host names");
  if (value.length > EGRESS_MAX)
    return invalid(`forge.json: egress may name at most ${EGRESS_MAX} hosts`);
  const hosts: string[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item.length > 253 ||
      !HOST_RE.test(item.toLowerCase()) ||
      Number(item.split(":")[1] ?? 1) > 65535
    )
      return invalid(
        "forge.json: egress entries must be host names (api.example.com, " +
          "*.example.com, or db.example.com:5432 for a port other than 80 " +
          "and 443); a private address is only ever one exact address:port " +
          "like 100.89.95.68:8101, never a range",
      );
    const entry = item.toLowerCase();
    const literal = (entry.split(":")[0] ?? "").replace(/^\*\./, "");
    const portless = entry.startsWith("*.") || !entry.includes(":");
    if (isIP(literal) === 4 && !isPublicAddress(literal) && portless)
      return invalid(
        `forge.json: egress "${item}" is a private address: name exactly ` +
          "one address and port (like 100.89.95.68:8101), not a wildcard " +
          "or an address without a port; a site admin then grants it",
      );
    hosts.push(entry);
  }
  return ok(hosts);
}

const LIMIT_FIELDS = {
  memory: { key: "memoryMiB", min: 64, max: 65536, unit: "MiB" },
  cpus: { key: "cpus", min: 0.1, max: 64, unit: "cores" },
  disk: { key: "diskMiB", min: 64, max: 1048576, unit: "MiB" },
  time: { key: "timeMs", min: 1, max: 3600, unit: "seconds a build step may take" },
} as const;

/** `app.limits` / `check.limits`: `{ memory, cpus, disk }`, each optional. */
function limitsField(
  section: Json,
  name: "app" | "check",
): Result<DeclaredLimits, ManifestError> {
  const value = section["limits"];
  if (value === undefined) return ok({});
  if (!isObject(value))
    return invalid(`forge.json: ${name}.limits must be an object`);
  const out: { memoryMiB?: number; cpus?: number; diskMiB?: number; timeMs?: number } = {};
  for (const [field, raw] of Object.entries(value)) {
    const rule = LIMIT_FIELDS[field as keyof typeof LIMIT_FIELDS];
    if (rule === undefined)
      return invalid(
        `forge.json: ${name}.limits takes memory, cpus, disk and time, not ${field}`,
      );
    if (field === "time" && name === "check")
      return invalid(
        "forge.json: check.limits.time is not read: a check's time is the forge's own; app.limits.time lowers the build steps",
      );
    if (typeof raw !== "number" || !(raw >= rule.min && raw <= rule.max))
      return invalid(
        `forge.json: ${name}.limits.${field} must be a number of ${rule.unit}, ${rule.min}–${rule.max}`,
      );
    out[rule.key] = rule.key === "timeMs" ? raw * 1000 : raw;
  }
  return ok(out);
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
  const paths = pathList(value, "app.looks");
  if (!paths.ok) return paths;
  return ok(paths.value.length === 0 ? ["/"] : paths.value);
}

/**
 * `app.looksAsOwner`: pages of `app.looks` to picture signed in as the
 * owner. Held to the same rules, and each must be a page `app.looks`
 * names — a page nobody pictures cannot be pictured as anyone.
 */
function looksAsOwnerField(
  app: Json,
  looks: readonly string[],
): Result<readonly string[], ManifestError> {
  const value = app["looksAsOwner"];
  if (value === undefined) return ok([]);
  const paths = pathList(value, "app.looksAsOwner");
  if (!paths.ok) return paths;
  const stray = paths.value.find((p) => !looks.includes(p));
  if (stray !== undefined)
    return invalid(
      `forge.json: app.looksAsOwner names ${stray}, which app.looks does not`,
    );
  return ok(paths.value);
}

/** How many pages a manifest may offer to play. */
export const PAGES_MAX = 20;

function pagesField(app: Json): Result<readonly string[], ManifestError> {
  const value = app["pages"];
  if (value === undefined) return ok([]);
  if (!Array.isArray(value) || value.length > PAGES_MAX)
    return invalid(`forge.json: app.pages must be an array of at most ${PAGES_MAX} paths`);
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !/^\/[A-Za-z0-9._-]*(\/[A-Za-z0-9._-]+)*$/.test(item) || item.length > 120 || item.includes(".."))
      return invalid('forge.json: app.pages entries are paths like "/" or "/spicy": letters, digits, dot, dash, underscore');
    if (!paths.includes(item)) paths.push(item);
  }
  return ok(paths);
}

/** A list of page paths, as `app.looks` and `app.looksAsOwner` take them. */
function pathList(
  value: unknown,
  field: string,
): Result<string[], ManifestError> {
  if (!Array.isArray(value))
    return invalid(`forge.json: ${field} must be an array of paths`);
  if (value.length > LOOKS_MAX)
    return invalid(`forge.json: ${field} may name at most ${LOOKS_MAX} paths`);
  const paths: string[] = [];
  for (const item of value) {
    if (typeof item !== "string")
      return invalid(`forge.json: ${field} entries must be strings`);
    if (item.length > LOOK_PATH_MAX)
      return invalid(
        `forge.json: ${field} entries must be at most ${LOOK_PATH_MAX} characters`,
      );
    if (!item.startsWith("/") || item.startsWith("//"))
      return invalid(
        `forge.json: ${field} entries must be a path starting with / (no scheme, no host)`,
      );
    if (item.includes(".."))
      return invalid(`forge.json: ${field} entries must not contain ..`);
    if (/[\x00-\x1f\x7f]/.test(item))
      return invalid(
        `forge.json: ${field} entries must not contain control characters`,
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
  /** The fast tier, run on every push to a pull. `null`: `run` is the only tier. */
  readonly fast: string | null;
  /** The full tier, run once when a pull lands. Defaults to `run`. */
  readonly full: string;
  /**
   * The verification after landing (#7786): the whole suite, run on the
   * default branch on a schedule, never as a landing's requirement. `null`:
   * nothing verifies main after it lands.
   */
  readonly verify: string | null;
  /** Seconds the check may take before it fails. */
  readonly timeout: number;
  /** Hosts its steps may reach besides the forge and the npm registry. */
  readonly egress: readonly string[];
  /** `check.limits`: memory, CPU and disk, within the machine's maximum. */
  readonly limits: DeclaredLimits;
}

const CHECK_TIMEOUT_DEFAULT = 20 * 60;
export const CHECK_TIMEOUT_MAX = 2 * 60 * 60;

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
  const fast = command(check, "fast", "check");
  if (!fast.ok) return fast;
  const full = command(check, "full", "check");
  if (!full.ok) return full;
  const verify = command(check, "verify", "check");
  if (!verify.ok) return verify;
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
  const egress = egressField(parsed.value);
  if (!egress.ok) return egress;
  const limits = limitsField(check, "check");
  if (!limits.ok) return limits;
  return ok({
    run: run.value,
    fast: fast.value || null,
    full: full.value || run.value,
    verify: verify.value || null,
    egress: egress.value,
    limits: limits.value,
    install:
      install.value === undefined
        ? (pkg?.value.hasDeps ?? false)
          ? "bun install"
          : null
        : install.value || null,
    timeout: timeout ?? CHECK_TIMEOUT_DEFAULT,
  });
}

/** The vendors a repository may name in `cloud.json`; a closed set. */
export const CLOUD_VENDORS = ["cloudflare", "fly", "hetzner", "s3", "github", "vercel", "digitalocean", "azure", "stripe"] as const;
/** What a vendor may be used for; a closed set. */
export const CLOUD_USES = ["compute", "storage", "backup", "dns", "cdn", "payments"] as const;
export type CloudVendor = (typeof CLOUD_VENDORS)[number];
export type CloudUse = (typeof CLOUD_USES)[number];

/** One declared use: which vendor, for what, and why. */
export interface CloudDeclaration {
  readonly vendor: CloudVendor;
  readonly use: CloudUse;
  readonly why: string;
}

const CLOUD_MAX = 32;
const WHY_MAX = 300;

/**
 * `cloud.json` beside `forge.json`: `{ "uses": [{ vendor, use, why }] }`.
 * Absent is no uses at all. Present and wrong is refused with one sentence.
 */
export function parseCloud(
  cloudJson: string | undefined,
): Result<readonly CloudDeclaration[], ManifestError> {
  if (cloudJson === undefined) return ok([]);
  const parsed = parseJson(cloudJson, "cloud.json");
  if (!parsed.ok) return parsed;
  const uses = parsed.value["uses"];
  if (!Array.isArray(uses) || uses.length > CLOUD_MAX)
    return invalid(
      `cloud.json: uses must be an array of at most ${CLOUD_MAX} entries`,
    );
  const out: CloudDeclaration[] = [];
  for (const item of uses) {
    if (!isObject(item))
      return invalid("cloud.json: each use must be an object {vendor, use, why}");
    const { vendor, use, why } = item;
    if (!(CLOUD_VENDORS as readonly unknown[]).includes(vendor))
      return invalid(`cloud.json: vendor must be one of ${CLOUD_VENDORS.join(", ")}`);
    if (!(CLOUD_USES as readonly unknown[]).includes(use))
      return invalid(`cloud.json: use must be one of ${CLOUD_USES.join(", ")}`);
    if (
      typeof why !== "string" ||
      why.trim() === "" ||
      why.length > WHY_MAX ||
      /[\x00-\x1f\x7f]/.test(why)
    )
      return invalid(
        `cloud.json: why must be one line of 1–${WHY_MAX} characters`,
      );
    out.push({
      vendor: vendor as CloudVendor,
      use: use as CloudUse,
      why: why.trim(),
    });
  }
  return ok(out);
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
