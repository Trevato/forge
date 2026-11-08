/**
 * What an absorbed app's process is told at start: `FORGE_FEATURE=1`
 * and a `FORGE_SETTING_*` per declared setting, read from the commit being
 * started, so a pull that adds a setting previews with it. Nothing at all for
 * an app that is not absorbed. Kept apart from `actions/features.ts`, which
 * reaches the runtime, so the runtime can ask without a cycle.
 */

import type { Database } from "bun:sqlite";
import { featureEnv, parseFeature, type FeatureSpec } from "./feature.ts";
import { featureSettings, getAbsorbed } from "../core/features.ts";
import { open, seal } from "../kernel/secret.ts";

/** A secret setting is kept sealed, bound to its app and name, so a copied row opens nowhere else. */
const aad = (appId: string, key: string): string => `feature-setting:${appId}:${key}`;

/** A secret's value sealed for keeping. */
export const sealSetting = (dataDir: string, appId: string, key: string, plain: string): string =>
  seal(dataDir, plain, aad(appId, key));

/**
 * The settings kept for an app as the process reads them: secrets opened.
 * One that will not open (key lost, row altered) is left out, so it falls
 * back to its empty default rather than to ciphertext.
 */
export function keptSettings(db: Database, dataDir: string, appId: string, spec: FeatureSpec): Map<string, string> {
  const kept = featureSettings(db, appId);
  for (const s of spec.settings) {
    const sealed = kept.get(s.key);
    if (s.type !== "secret" || sealed === undefined) continue;
    const opened = open(dataDir, sealed, aad(appId, s.key));
    if (opened.ok) kept.set(s.key, opened.value);
    else kept.delete(s.key);
  }
  return kept;
}

export function featureVarsAt(
  db: Database,
  dataDir: string,
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
  return featureEnv(spec.value, keptSettings(db, dataDir, appId, spec.value));
}

/** Only the names this feature owns: what `appEnv` lets through from `feature`. */
export const isFeatureVarName = (name: string): boolean => name === "FORGE_FEATURE" || /^FORGE_SETTING_[A-Z0-9_]+$/.test(name);
