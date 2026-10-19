/**
 * The probe: how the forge's own release machinery asks a forge what it
 * runs without being an admin or a stranger (#2917). A stranger asking
 * `/api/v1/health` or `/healthz` learns that the forge is up; the release
 * that swaps in its successor, the launcher that boots an image, and the
 * proof that reads the public URL need its version and commit too.
 *
 * Each of those holds the data directory the forge answers from, so the
 * credential is derived from that directory's `secret.key` (HKDF, purpose
 * "probe") and sent as `X-Forge-Probe`. A process that can read the key
 * already owns the forge; nothing else can produce the value. It never
 * reuses the key that seals tokens or signs passports.
 */

import { hkdfSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadKey } from "./secret.ts";

export const PROBE_HEADER = "x-forge-probe";

/** The probe a key derives. `release/launch.ts` repeats these lines: it imports nothing of the forge's. */
export function probeOfKey(key: Uint8Array): string {
  return Buffer.from(hkdfSync("sha256", key, "", "forge probe v1", 32)).toString("base64url");
}

const probes = new Map<string, { key: Buffer; probe: string }>();

/** The probe the forge answering from `dataDir` honours: its own key's. */
export function probeFor(dataDir: string): string {
  const key = loadKey(dataDir);
  const hit = probes.get(dataDir);
  // Keyed on the loaded key, as passports are: a rotation picks up a new probe.
  if (hit?.key.equals(key)) return hit.probe;
  const probe = probeOfKey(key);
  probes.set(dataDir, { key, probe });
  return probe;
}

/** The header the forge on `dataDir` sends when it probes itself (its public URL). */
export function ownProbeHeaders(dataDir: string): Record<string, string> {
  return { [PROBE_HEADER]: probeFor(dataDir) };
}

/**
 * The header a caller sends to be answered as a probe of the forge on
 * `dataDir`. Read fresh and never written: a caller polls a child that
 * creates its key as it boots, and two processes each creating one would
 * leave them disagreeing for good. No key yet is no header.
 */
export function probeHeaders(dataDir: string): Record<string, string> {
  let key: Buffer;
  try {
    key = readFileSync(join(dataDir, "secret.key"));
  } catch {
    return {};
  }
  return key.length === 32 ? { [PROBE_HEADER]: probeOfKey(key) } : {};
}

/** Whether `request` carries this forge's probe; a missing or wrong one is false. */
export function isProbe(request: Request, dataDir: string): boolean {
  const said = request.headers.get(PROBE_HEADER);
  if (said === null || said === "") return false;
  const want = Buffer.from(probeFor(dataDir));
  const got = Buffer.from(said);
  return got.length === want.length && timingSafeEqual(got, want);
}
