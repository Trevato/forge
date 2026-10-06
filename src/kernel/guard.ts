/**
 * The platform's view of the forge, as the droplet's watchdog leaves it: a
 * ConfigMap (`forge-guard`) mounted read-only, no Kubernetes API needed.
 * `status.json` is `{ incidents: {key: message}, public, service }` and
 * `checkedAt` is an ISO time. Keys: `down`, `edge`, `stuck` (a rollout
 * cannot finish), `held` (the reconciler's preflight refused a release),
 * `oom:*`. Missing or empty means nothing is wrong; a view older than ten
 * minutes is said to be stale, never "all fine".
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { health } from "../http/health.ts";
import { running } from "./version.ts";

export const GUARD_STALE_MS = 10 * 60_000;
const MAX_INCIDENTS = 50;
const MAX_MESSAGE = 800;

export interface Incident {
  readonly key: string;
  readonly message: string;
}

export interface Guard {
  readonly incidents: Incident[];
  readonly checkedAt: string | null;
}

export interface Rollout {
  readonly state: "ok" | "blocked" | "held";
  readonly reason: string;
}

export interface ForgeHealth {
  readonly ok: boolean;
  /** What is running, as the build stamped it (`kernel/version.ts`). */
  readonly version: string;
  readonly commit: string | null;
  readonly draining: boolean;
  readonly rollout: Rollout;
  readonly incidents: Incident[];
  readonly stale: boolean;
  readonly checkedAt: string | null;
}

/** Where the ConfigMap is mounted. */
export function guardDir(): string {
  return process.env["FORGE_GUARD_DIR"] || "/etc/forge-guard";
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Parse the two keys; anything malformed is treated as absent. */
export function parseGuard(
  statusJson: string | null,
  checkedAtText: string | null,
): Guard {
  const incidents: Incident[] = [];
  if (statusJson) {
    try {
      const raw = (JSON.parse(statusJson) as { incidents?: unknown })
        .incidents;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [key, message] of Object.entries(raw)) {
          if (incidents.length >= MAX_INCIDENTS) break;
          if (!/^[a-z][a-z0-9:._-]{0,63}$/i.test(key)) continue;
          if (typeof message !== "string") continue;
          incidents.push({ key, message: message.trim().slice(0, MAX_MESSAGE) });
        }
      }
    } catch {
      // a half-written file reads as nothing
    }
  }
  const at = checkedAtText?.trim() ?? "";
  const checkedAt =
    at && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : null;
  return { incidents, checkedAt };
}

export function readGuard(dir: string = guardDir()): Guard {
  return parseGuard(
    readText(join(dir, "status.json")),
    readText(join(dir, "checkedAt")),
  );
}

/** The forge's view plus the platform's, as plain data. */
export function forgeHealth(
  guard: Guard = readGuard(),
  now: number = Date.now(),
): ForgeHealth {
  const stale =
    guard.checkedAt !== null && now - Date.parse(guard.checkedAt) > GUARD_STALE_MS;
  const find = (key: string) => guard.incidents.find((i) => i.key === key);
  const { version, commit } = running();
  const stuck = find("stuck");
  const held = find("held");
  const rollout: Rollout = stuck
    ? { state: "blocked", reason: stuck.message }
    : held
      ? { state: "held", reason: held.message }
      : stale
        ? {
            state: "ok",
            reason: "the platform's view is stale: its last check was " +
              `${guard.checkedAt}`,
          }
        : { state: "ok", reason: "" };
  return {
    ok:
      !health.draining && !stale && guard.incidents.length === 0,
    version,
    commit,
    draining: health.draining,
    rollout,
    incidents: guard.incidents,
    stale,
    checkedAt: guard.checkedAt,
  };
}

/** The status-line words for a rollout that is not simply fine, else null. */
export function rolloutLine(h: ForgeHealth): string | null {
  if (h.rollout.state === "blocked") return `rollout blocked: ${h.rollout.reason}`;
  if (h.rollout.state === "held") return `rollout held: ${h.rollout.reason}`;
  return h.stale ? h.rollout.reason : null;
}
