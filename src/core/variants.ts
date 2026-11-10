/**
 * Variants — the rows. A variant is a branch of an app kept running as an
 * environment of its own, beside production and the previews of pulls: it
 * does not end when a pull does, and it sleeps on production's schedule.
 * The row only says which branch is a variant and what to call it; the
 * values it carries are `variant.json` on the branch (`apps/variant_file.ts`).
 * Pure data: no authz, no events.
 */

import type { Database } from "bun:sqlite";
import { VARIANT_LABEL } from "../apps/data.ts";
import { err, ok, type Result } from "../kernel/result.ts";

/** Most variants one app keeps: each is a running environment against the app's budget. */
export const VARIANTS_MAX = 6;

export interface Variant {
  readonly appId: string;
  readonly label: string;
  readonly branch: string;
  readonly createdAt: string;
}

interface Row {
  app_id: string;
  label: string;
  branch: string;
  created_at: string;
}

const toVariant = (r: Row): Variant => ({ appId: r.app_id, label: r.label, branch: r.branch, createdAt: r.created_at });

/** The label a branch name suggests: lowercase letters and digits, at most 16. */
export function labelFor(branch: string): string {
  const label = branch.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16);
  return label === "" ? "variant" : label;
}

export const isVariantLabel = (value: string): boolean => VARIANT_LABEL.test(value);

export function listVariants(db: Database, appId: string): Variant[] {
  return db
    .query<Row, [string]>("SELECT app_id, label, branch, created_at FROM app_variant WHERE app_id = ? ORDER BY created_at, label")
    .all(appId)
    .map(toVariant);
}

export function getVariant(db: Database, appId: string, label: string): Variant | undefined {
  const row = db
    .query<Row, [string, string]>("SELECT app_id, label, branch, created_at FROM app_variant WHERE app_id = ? AND label = ?")
    .get(appId, label);
  return row === null ? undefined : toVariant(row);
}

export function variantOfBranch(db: Database, appId: string, branch: string): Variant | undefined {
  const row = db
    .query<Row, [string, string]>("SELECT app_id, label, branch, created_at FROM app_variant WHERE app_id = ? AND branch = ?")
    .get(appId, branch);
  return row === null ? undefined : toVariant(row);
}

export type AddVariantError = "invalid_label" | "label_taken" | "branch_taken" | "too_many";

export function addVariant(
  db: Database,
  input: { appId: string; label: string; branch: string; createdBy: string },
): Result<Variant, AddVariantError> {
  if (!isVariantLabel(input.label)) return err("invalid_label");
  return db
    .transaction((): Result<Variant, AddVariantError> => {
      if (getVariant(db, input.appId, input.label) !== undefined) return err("label_taken");
      if (variantOfBranch(db, input.appId, input.branch) !== undefined) return err("branch_taken");
      if (listVariants(db, input.appId).length >= VARIANTS_MAX) return err("too_many");
      db.query("INSERT INTO app_variant (app_id, label, branch, created_by) VALUES (?, ?, ?, ?)").run(
        input.appId,
        input.label,
        input.branch,
        input.createdBy,
      );
      return ok(getVariant(db, input.appId, input.label)!);
    })
    .immediate();
}

export function removeVariant(db: Database, appId: string, label: string): boolean {
  return db.query("DELETE FROM app_variant WHERE app_id = ? AND label = ?").run(appId, label).changes > 0;
}
