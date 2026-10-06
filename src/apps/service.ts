/**
 * The `service` kind: an app that is the opposite of a sleeping HTTP child —
 * it listens on declared TCP ports, stays up, prefers a kind of body, and
 * keeps durable volumes synced on a cadence. This module only reads and
 * validates the declaration (`app.kind: "service"` in `forge.json`); running
 * it is the runtime's business. Fail closed, like the rest of the manifest.
 */

import { err, ok, type Result } from "../kernel/result.ts";

export type Placement = "metal" | "cloud";

export interface ServicePort {
  readonly port: number;
  readonly protocol: "tcp";
}

export interface ServiceVolume {
  /** Relative path under the app's data directory. */
  readonly path: string;
  /** Seconds between syncs to object storage. */
  readonly sync: number;
}

export interface ServiceSpec {
  readonly ports: readonly ServicePort[];
  /** Never put to sleep. Defaults to true: that is the point of a service. */
  readonly alwaysOn: boolean;
  /** Where it would rather run; `null` leaves it to the forge. */
  readonly placement: Placement | null;
  readonly volumes: readonly ServiceVolume[];
}

const PORTS_MAX = 8;
const VOLUMES_MAX = 8;
const PATH_MAX = 200;
const SYNC_MIN = 10;
const SYNC_MAX = 24 * 60 * 60;
const SYNC_DEFAULT = 300;

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const invalid = (message: string): Result<never, { message: string }> =>
  err({ message: `forge.json: ${message}` });

/** Read the service fields of an `app` section. */
export function parseService(app: Json): Result<ServiceSpec, { message: string }> {
  const rawPorts = app["ports"];
  if (!Array.isArray(rawPorts) || rawPorts.length === 0)
    return invalid("app.ports must list at least one TCP port for a service");
  if (rawPorts.length > PORTS_MAX)
    return invalid(`app.ports may name at most ${PORTS_MAX} ports`);
  const ports: ServicePort[] = [];
  for (const p of rawPorts) {
    if (typeof p !== "number" || !Number.isInteger(p) || p < 1024 || p > 65535)
      return invalid("app.ports entries must be whole numbers, 1024–65535");
    if (ports.some((q) => q.port === p))
      return invalid(`app.ports names ${p} twice`);
    ports.push({ port: p, protocol: "tcp" });
  }

  const alwaysOn = app["always_on"];
  if (alwaysOn !== undefined && typeof alwaysOn !== "boolean")
    return invalid("app.always_on must be true or false");
  if (alwaysOn === false)
    return invalid("app.always_on cannot be false for a service");

  const placement = app["placement"];
  if (placement !== undefined && placement !== "metal" && placement !== "cloud")
    return invalid('app.placement must be "metal" or "cloud"');

  const rawVolumes = app["volumes"] ?? [];
  if (!Array.isArray(rawVolumes))
    return invalid("app.volumes must be an array");
  if (rawVolumes.length > VOLUMES_MAX)
    return invalid(`app.volumes may name at most ${VOLUMES_MAX} volumes`);
  const volumes: ServiceVolume[] = [];
  for (const v of rawVolumes) {
    if (!isObject(v)) return invalid("app.volumes entries must be objects");
    const path = v["path"];
    if (
      typeof path !== "string" ||
      path === "" ||
      path.length > PATH_MAX ||
      path.startsWith("/") ||
      path.split("/").some((s) => s === ".." || s === "") ||
      !/^[\w.\/-]+$/.test(path)
    )
      return invalid(
        "app.volumes path must be a relative path of letters, digits, . _ - and /, without ..",
      );
    if (volumes.some((w) => w.path === path))
      return invalid(`app.volumes names ${path} twice`);
    const sync = v["sync"] ?? SYNC_DEFAULT;
    if (
      typeof sync !== "number" ||
      !Number.isInteger(sync) ||
      sync < SYNC_MIN ||
      sync > SYNC_MAX
    )
      return invalid(
        `app.volumes sync must be a whole number of seconds, ${SYNC_MIN}–${SYNC_MAX}`,
      );
    volumes.push({ path, sync });
  }

  return ok({
    ports,
    alwaysOn: true,
    placement: placement ?? null,
    volumes,
  });
}
