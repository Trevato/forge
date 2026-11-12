/**
 * Variants: a branch of an app kept running as its own environment, with
 * values of its own (docs/features/variants.md). A person who can write the
 * repository may register a branch, set the values it carries, retire it,
 * or ask for it to become main. Never an agent: the crew proposes, a person
 * chooses what runs and what lands (docs/APPS.md rule 1).
 *
 * The values are `variant.json` on the branch, committed here, so they are
 * versioned like the rest of the branch. Registering, saving and retiring
 * are announced on the outbox. "Make this main" opens an ordinary pull from
 * the branch to the default branch and hands it back: the merge stays the
 * pull's, with its checks and its person.
 */

import type { App } from "../app.ts";
import { appsRuntime } from "../apps/runtime.ts";
import { parseValueLines, readLastOutput, VARIANT_FILE, variantFileText, parseVariantFile } from "../apps/variant_file.ts";
import { envDataDir, variantEnv } from "../apps/data.ts";
import { getAppByRepo, type AppRecord } from "../core/apps.ts";
import { commitIdentity } from "../core/commit_identity.ts";
import { listPulls, type Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import {
  addVariant,
  getVariant,
  isVariantLabel,
  labelFor,
  listVariants,
  removeVariant,
  type AddVariantError,
  type Variant,
} from "../core/variants.ts";
import { getQuota } from "../settings/quotas.ts";
import { commitFiles } from "../git/write.ts";
import { isSafeRef } from "../git/guard.ts";
import { readerFor } from "../git/read.ts";
import { repoDir } from "../git/repos.ts";
import { resolveOid } from "../git/merge.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { isMirror } from "../origins/write-through.ts";
import { requireWriter, type AccessError } from "./access.ts";
import { openPull } from "./pulls.ts";

export type VariantError =
  | AccessError
  | AddVariantError
  | "mirrored"
  | "no_branch"
  | "default_branch"
  | "not_a_variant"
  | "bad_values"
  | "failed";

export function variantRefusalText(error: string, detail?: string): string {
  switch (error) {
    case "unauthorized":
    case "forbidden":
      return "Only a person with write access can change an app's variants.";
    case "mirrored":
      return "This repository mirrors another: keep variants in a fork of it.";
    case "no_branch":
      return "That branch does not exist in this repository.";
    case "default_branch":
      return "The default branch is production, not a variant.";
    case "invalid_label":
      return "A label is 1 to 16 lowercase letters and digits.";
    case "label_taken":
      return "Another variant already has that label.";
    case "branch_taken":
      return "That branch is already a variant.";
    case "too_many":
      return "This app keeps as many variants as it may; retire one first.";
    case "not_a_variant":
      return "That is not one of this app's variants.";
    case "bad_values":
      return detail ?? "Those values are not allowed.";
    case "not_found":
      return "This repository has no app.";
    default:
      return "That could not be done.";
  }
}

/** The writer who is a person, on an app, not a mirror: the floor every change here shares. */
function mayChange(app: App, actor: User | undefined, repo: Repo): Result<{ user: User; record: AppRecord }, VariantError> {
  const writer = requireWriter(app, actor, repo);
  if (!writer.ok) return writer;
  if (writer.value.kind === "agent") return err("forbidden");
  if (isMirror(app, repo)) return err("mirrored");
  const record = getAppByRepo(app.db, repo.id);
  if (record === undefined) return err("not_found");
  return ok({ user: writer.value, record });
}

/** Register `branch` as a variant (label defaults from its name) and start it. */
export async function registerVariant(
  app: App,
  actor: User | undefined,
  repo: Repo,
  input: { branch: string; label?: string },
): Promise<Result<Variant, VariantError>> {
  const may = mayChange(app, actor, repo);
  if (!may.ok) return may;
  const branch = input.branch.trim();
  if (!isSafeRef(branch) || branch.startsWith("refs/")) return err("no_branch");
  if (branch === repo.defaultBranch) return err("default_branch");
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  if ((await resolveOid(dir, `refs/heads/${branch}`)) === undefined) return err("no_branch");
  const label = (input.label ?? "").trim() === "" ? labelFor(branch) : (input.label ?? "").trim();
  if (!isVariantLabel(label)) return err("invalid_label");
  const added = addVariant(app.db, { appId: may.value.record.id, label, branch, createdBy: may.value.user.id });
  if (!added.ok) return added;
  app.bus.append({
    kind: "app.variant_added",
    repoId: repo.id,
    actorId: may.value.user.id,
    payload: { label, branch },
  });
  await appsRuntime(app)?.deployVariant(may.value.record, repo, label, may.value.user.id);
  return added;
}

/** The values a variant's branch carries now, from `variant.json` at its tip. */
export async function variantValues(app: App, repo: Repo, variant: Variant): Promise<Record<string, string>> {
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const file = await readerFor(dir).object(`refs/heads/${variant.branch}:${VARIANT_FILE}`);
  if (!file.ok || file.value.type !== "blob") return {};
  const parsed = parseVariantFile(new TextDecoder().decode(file.value.body));
  return parsed.ok ? parsed.value : {};
}

/** Commit `NAME=value` lines as the branch's `variant.json`; the push redeploys the variant. */
export async function setVariantValues(
  app: App,
  actor: User | undefined,
  repo: Repo,
  label: string,
  lines: string,
): Promise<Result<Record<string, string>, VariantError | { kind: "bad_values"; message: string }>> {
  const may = mayChange(app, actor, repo);
  if (!may.ok) return may;
  const variant = getVariant(app.db, may.value.record.id, label);
  if (variant === undefined) return err("not_a_variant");
  const values = parseValueLines(lines);
  if (!values.ok) return err({ kind: "bad_values", message: values.error });
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const tip = await resolveOid(dir, `refs/heads/${variant.branch}`);
  if (tip === undefined) return err("no_branch");
  const committed = await commitFiles(dir, {
    branch: variant.branch,
    message: `Variant ${label}: set its values\n\nSet from the app page by ${may.value.user.username}.`,
    files: [{ path: VARIANT_FILE, content: variantFileText(values.value) }],
    expectTip: tip,
    author: commitIdentity(app.config, may.value.user),
  });
  if (!committed.ok) return err("failed");
  app.bus.append({
    kind: "app.variant_values",
    repoId: repo.id,
    actorId: may.value.user.id,
    payload: { label, names: Object.keys(values.value).sort() },
  });
  // The commit moved the branch without a hook: the variant follows it from here.
  await appsRuntime(app)?.deployVariant(may.value.record, repo, label, may.value.user.id);
  return ok(values.value);
}

/** Stop keeping a variant running; the branch and its file stay. */
export async function retireVariant(app: App, actor: User | undefined, repo: Repo, label: string): Promise<Result<true, VariantError>> {
  const may = mayChange(app, actor, repo);
  if (!may.ok) return may;
  if (!removeVariant(app.db, may.value.record.id, label)) return err("not_a_variant");
  app.bus.append({ kind: "app.variant_removed", repoId: repo.id, actorId: may.value.user.id, payload: { label } });
  await appsRuntime(app)?.teardown(may.value.record, variantEnv(label));
  return ok(true);
}

/**
 * "Make this main": the open pull from the variant's branch to the default
 * branch, opened if there is none. The merge is the pull's.
 */
export async function makeMain(
  app: App,
  actor: User | undefined,
  repo: Repo,
  label: string,
): Promise<Result<Pull, VariantError>> {
  const may = mayChange(app, actor, repo);
  if (!may.ok) return may;
  const variant = getVariant(app.db, may.value.record.id, label);
  if (variant === undefined) return err("not_a_variant");
  const existing = listPulls(app.db, repo.id, { sealed: true, state: "open", limit: 200 }).find(
    (p) => !p.crossRepo && p.headBranch === variant.branch && p.baseBranch === repo.defaultBranch,
  );
  if (existing !== undefined) return ok(existing);
  const opened = await openPull(app, may.value.user, repo, {
    title: `Make the ${label} variant main`,
    body: `Opened from the variants board: merging this makes the ${label} variant (branch \`${variant.branch}\`) the app.`,
    baseBranch: repo.defaultBranch,
    headBranch: variant.branch,
  });
  return opened.ok ? ok(opened.value) : err(opened.error === "unauthorized" || opened.error === "not_found" ? opened.error : "failed");
}

/** One variant as the board shows it: plain data. */
export interface VariantCard {
  readonly label: string;
  readonly branch: string;
  readonly values: Readonly<Record<string, string>>;
  readonly env: string;
  readonly state: string;
  readonly url: string | undefined;
  readonly output: { readonly title: string; readonly path: string } | undefined;
}

/** What the board shows: every variant, its values from the branch, its output from the environment's data. */
export async function variantBoard(app: App, repo: Repo): Promise<{ cards: VariantCard[]; live: number; max: number | null } | undefined> {
  const record = getAppByRepo(app.db, repo.id);
  if (record === undefined) return undefined;
  const runtime = appsRuntime(app);
  const cards: VariantCard[] = [];
  for (const variant of listVariants(app.db, record.id)) {
    const env = variantEnv(variant.label);
    const status = runtime?.envStatus(record, env);
    cards.push({
      label: variant.label,
      branch: variant.branch,
      values: await variantValues(app, repo, variant),
      env,
      state: status === undefined ? "not running" : status.dormant !== undefined ? "asleep" : status.state,
      url: runtime?.urlFor(record, env),
      output: readLastOutput(envDataDir(app.config.dataDir, record.id, env)),
    });
  }
  const live = (runtime?.status(record) ?? []).filter((e) => e.env !== "production" && e.state === "running").length;
  return { cards, live, max: getQuota(app.db, "previews") };
}
