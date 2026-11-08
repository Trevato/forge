/**
 * What an absorbed app's process is told at start: `FORGE_FEATURE=1`
 * and a `FORGE_SETTING_*` per declared setting, read from the commit being
 * started, so a pull that adds a setting previews with it. Nothing at all for
 * an app that is not absorbed. Kept apart from `actions/features.ts`, which
 * reaches the runtime, so the runtime can ask without a cycle.
 */

import type { Database } from "bun:sqlite";
import { featureEnv, parseFeature } from "./feature.ts";
import { featureSettings, getAbsorbed } from "../core/features.ts";

export function featureVarsAt(
  db: Database,
  appId: string,
  forgeJson: string | undefined,
): Record<string, string> {
  if (forgeJson === undefined || getAbsorbed(db, appId) === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(forgeJson);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const spec = parseFeature(parsed as Record<string, unknown>);
  if (!spec.ok || spec.value === undefined) return {};
  // The menu keeps the name and page the admin saw at absorb; a changed
  // declaration waits for an admin to accept it (`acceptDeclaration`).
  return featureEnv(spec.value, featureSettings(db, appId));
}

/** Only the names this feature owns: what `appEnv` lets through from `feature`. */
export const isFeatureVarName = (name: string): boolean => name === "FORGE_FEATURE" || /^FORGE_SETTING_[A-Z0-9_]+$/.test(name);
