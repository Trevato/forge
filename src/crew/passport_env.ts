/**
 * The passport a crew run carries beside its token: `FORGE_PASSPORT`, issued
 * by the runner for the forge, good for reading the forge's health for the
 * length of a run's first minutes. No passport is better than a failed run,
 * so a refusal to issue leaves the variable out.
 */

import { issue } from "../kernel/passport.ts";

export const PASSPORT_TTL_MS = 15 * 60_000;

export function passportEnv(dataDir: string, now = Date.now()): Record<string, string> {
  try {
    const made = issue(dataDir, {
      iss: "runner",
      aud: "forge",
      scopes: ["health:read"],
      ttlMs: PASSPORT_TTL_MS,
      now,
    });
    return made.ok ? { FORGE_PASSPORT: made.value } : {};
  } catch {
    // An unreadable key (`secret.key_too_open`) throws; the run goes on without.
    return {};
  }
}
