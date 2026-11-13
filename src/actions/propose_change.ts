/**
 * Send a change back without git: a patch or a set of files, in one call.
 *
 * An agent in a chat sandbox has a working copy and no push credential. It
 * sends the change as text; the forge forks the repository to the sender
 * (the guest fork limits apply, as for `fork`), writes a branch there with
 * the sender as the commit's author, and opens a pull from that fork. Nothing
 * here runs the change: a guest's pull waits for a person's approval before
 * any check (`core/pull_trust.ts`), and its check then runs as any check does. The checks the sender says it ran are written
 * into the pull's description as the sender's word, never as a verdict.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { App } from "../app.ts";
import { getForkOf, getRepoById, type Repo } from "../core/repos.ts";
import { getPull, type Pull } from "../core/pulls.ts";
import type { GuestRefusal } from "../core/contribute.ts";
import type { User } from "../core/users.ts";
import { runGit } from "../git/env.ts";
import { isSafeRef, isSafeTreePath } from "../git/guard.ts";
import { repoDir } from "../git/repos.ts";
import { MAX_PATCH_BYTES, patchToFiles, type PatchError } from "../git/patch_files.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { editFiles, type EditFile } from "./contents.ts";
import { guestWaits } from "../origins/guest.ts";
import { openPull } from "./pulls.ts";
import { forkRepo } from "./repos.ts";

/** Bounds of one call: a proposal by text is small; a large change goes by git. */
export const MAX_FILES_SENT = 50;
export const MAX_FILES_BYTES = 512 * 1024;
export const MAX_TITLE = 200;
export const MAX_BODY = 8_000;
export const MAX_CHECKS = 10;

export interface ReportedCheck {
  readonly name: string;
  readonly result: "pass" | "fail" | "skipped";
  readonly detail?: string;
}

/** A file as sent: whole text, or `null` to delete it. */
export interface SentFile {
  readonly path: string;
  readonly content: string | null;
}

/** `raw` as files, or `invalid`: at most `MAX_FILES_SENT`, each a safe path and text or null, in `MAX_FILES_BYTES` together. */
export function validFiles(raw: unknown): Result<SentFile[], "invalid"> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_FILES_SENT) return err("invalid");
  const out: SentFile[] = [];
  let bytes = 0;
  for (const f of raw) {
    if (typeof f !== "object" || f === null) return err("invalid");
    const { path, content } = f as Record<string, unknown>;
    if (typeof path !== "string" || !isSafeTreePath(path)) return err("invalid");
    if (content !== null && typeof content !== "string") return err("invalid");
    bytes += content === null ? 0 : Buffer.byteLength(content, "utf8");
    if (bytes > MAX_FILES_BYTES) return err("invalid");
    out.push({ path, content });
  }
  return ok(out);
}

export interface ProposeChangeInput {
  readonly title: string;
  readonly body?: string;
  readonly base?: string;
  readonly branch?: string;
  readonly files?: readonly SentFile[];
  readonly patch?: string;
  readonly checks?: readonly ReportedCheck[];
}

export interface Proposed {
  readonly pull: Pull;
  readonly fork: Repo;
  readonly branch: string;
  readonly commit: string;
  readonly waitsForApproval: boolean;
}

export type ProposeChangeError =
  | "invalid"
  | "not_found"
  | "unknown_base"
  | "branch_exists"
  | { kind: "patch"; reason: PatchError }
  | { kind: "fork"; reason: string }
  | { kind: "edit"; reason: string }
  | { kind: "pull"; reason: string; branch: string; fork: string };

/** What the sender says it ran, as lines for the pull's description. */
export function checksBlock(checks: readonly ReportedCheck[]): string {
  if (checks.length === 0) return "";
  const lines = checks.map((c) => `- ${c.name}: ${c.result}${c.detail ? ` (${c.detail})` : ""}`);
  return `\n\nChecks the sender says it ran before sending (its word; the forge runs its own):\n${lines.join("\n")}`;
}

export function validChecks(raw: unknown): Result<ReportedCheck[], "invalid"> {
  if (raw === undefined) return ok([]);
  if (!Array.isArray(raw) || raw.length > MAX_CHECKS) return err("invalid");
  const out: ReportedCheck[] = [];
  for (const c of raw) {
    if (typeof c !== "object" || c === null) return err("invalid");
    const { name, result, detail } = c as Record<string, unknown>;
    if (typeof name !== "string" || name.trim() === "" || name.length > 60) return err("invalid");
    if (result !== "pass" && result !== "fail" && result !== "skipped") return err("invalid");
    if (detail !== undefined && (typeof detail !== "string" || detail.length > 200)) return err("invalid");
    out.push({ name: name.replace(/\s+/g, " ").trim(), result, ...(detail === undefined || detail === "" ? {} : { detail: detail.replace(/\s+/g, " ") }) });
  }
  return ok(out);
}

/** Why a fork could not be made, as this action's own error: the fork's own words for the few that are ours, the refusal itself otherwise. */
function forkFailure(e: Awaited<ReturnType<typeof forkRepo>> extends infer R ? (R extends { ok: false; error: infer E } ? E : never) : never): ProposeChangeError | GuestRefusal | "unverified" | "unauthorized" | "repository_limit" | "storage_limit" | "refused" | "not_member" {
  switch (e) {
    case "invalid_name":
    case "name_taken":
    case "already_forked":
    case "fork_failed":
    case "limit":
      return { kind: "fork", reason: e.replace(/_/g, " ") };
    case "not_found":
      return "not_found";
    default:
      return e;
  }
}

export async function proposeChange(
  app: App,
  user: User,
  upstream: Repo,
  input: ProposeChangeInput,
): Promise<Result<Proposed, ProposeChangeError | GuestRefusal | "unverified" | "unauthorized" | "repository_limit" | "storage_limit" | "refused" | "not_member">> {
  const title = input.title.trim();
  if (title === "" || title.length > MAX_TITLE) return err("invalid");
  const body = input.body ?? "";
  if (body.length > MAX_BODY) return err("invalid");
  const hasFiles = input.files !== undefined && input.files.length > 0;
  const hasPatch = input.patch !== undefined && input.patch !== "";
  if (hasFiles === hasPatch) return err("invalid");
  if (hasFiles) {
    if (!validFiles(input.files).ok) return err("invalid");
  } else if (Buffer.byteLength(input.patch!, "utf8") > MAX_PATCH_BYTES) return err({ kind: "patch", reason: "too_large" });
  const base = (input.base ?? "").trim() || upstream.defaultBranch;
  const branch = (input.branch ?? "").trim() || `change-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  if (!isSafeRef(base) || !isSafeRef(branch) || branch.startsWith("refs/")) return err("invalid");

  const upstreamDir = repoDir(app.reposRoot, upstream.ownerName, upstream.name);
  const baseOid = await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${base}^{commit}`], { cwd: upstreamDir });
  if (!baseOid.ok) return err("unknown_base");

  let fork = getForkOf(app.db, user.id, upstream.id);
  if (fork === undefined) {
    const made = await forkRepo(app, user, upstream);
    if (!made.ok) return err(forkFailure(made.error));
    fork = made.value;
  }
  const forkDir = repoDir(app.reposRoot, fork.ownerName, fork.name);
  // A fork made months ago is a snapshot: bring the base up to the upstream's
  // when that is a fast-forward, and start from the upstream's commit either way.
  await runGit(["fetch", "--no-tags", upstreamDir, `refs/heads/${base}:refs/forge-upstream/${base}`], { cwd: forkDir });
  const fresh = await runGit(["rev-parse", "--verify", "--quiet", `refs/forge-upstream/${base}^{commit}`], { cwd: forkDir });
  if (!fresh.ok) return err({ kind: "fork", reason: "the fork could not read the base" });
  const start = fresh.value;

  let files: readonly EditFile[];
  if (hasFiles) files = input.files!;
  else {
    const scratch = join(app.config.dataDir, "scratch");
    await mkdir(scratch, { recursive: true });
    const made = await patchToFiles(forkDir, start, input.patch!, scratch);
    if (!made.ok) return err({ kind: "patch", reason: made.error });
    files = made.value;
  }

  const edited = await editFiles(app, user, fork, { newBranch: branch, base: start, files, message: title });
  if (!edited.ok) {
    const e = edited.error;
    if (typeof e === "object" && e.kind === "branch_failed" && e.reason === "exists") return err("branch_exists");
    return err({ kind: "edit", reason: typeof e === "string" ? e : e.kind });
  }
  const opened = await openPull(app, user, upstream, {
    title,
    body: `${body}${checksBlock(input.checks ?? [])}`,
    baseBranch: base,
    headBranch: branch,
    headRepo: fork,
  });
  if (!opened.ok) return err(typeof opened.error === "string" ? { kind: "pull", reason: opened.error, branch, fork: `${fork.ownerName}/${fork.name}` } : { kind: "pull", reason: "refused", branch, fork: `${fork.ownerName}/${fork.name}` });
  const pull = getPull(app.db, upstream.id, opened.value.number) ?? opened.value;
  return ok({
    pull,
    fork: getRepoById(app.db, fork.id) ?? fork,
    branch,
    commit: edited.value.commit.commitOid,
    waitsForApproval: guestWaits(app.db, pull),
  });
}
