/**
 * The git half of a mirror: pulling the origin's refs down, and pushing our
 * refs back up. Two commands, and a great deal of care about their arguments.
 *
 * **Never `clone --mirror`.** It sets `remote.origin.fetch = +refs/*:refs/*`,
 * which on GitHub drags in every `refs/pull/<n>/head` and `/merge` — 3,523 of
 * them against 3 branches on one measured repo — and it sets
 * `remote.origin.mirror = true`, whose only other reader is `git push`, where
 * it silently means `--mirror`: force-update everything under `refs/`, and
 * **delete upstream any ref missing locally**. A stale mirror would then wipe
 * branches nobody here has ever seen. So: a plain bare repo, explicit
 * refspecs passed on every fetch, `remote.origin.mirror` pinned false, and a
 * push helper that cannot be called without a refspec.
 *
 * **Never a bare `--force-with-lease`.** Its expected value is the
 * remote-tracking ref, which *our own background fetcher advances* — the
 * documented worst case for that flag is precisely a cronjob fetching in the
 * background, and we are the cronjob. Every forced push here asserts the
 * explicit `<ref>:<oid>` form, using the old oid git itself just handed us.
 */

import { isSafeOid, isSafeRef } from "../git/guard.ts";
import { runGitCapture, type RunOptions } from "../git/env.ts";
import { listRefs } from "../git/read.ts";
import { ZERO_OID } from "../git/hooks.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { trustedHosts } from "./trusted-hosts.ts";
import { operatorAllowed } from "./discover.ts";
import { vetHost, type OutboundOptions } from "../kernel/outbound.ts";
import { pinFor, remoteGitEnv } from "../git/remote-env.ts";
import { redact, safeRemoteUrl, secretsIn } from "./credentials.ts";

/** A mirror fetch can be genuinely slow; Forgejo allows its own 300s. */
const FETCH_TIMEOUT_MS = 300_000;
const PUSH_TIMEOUT_MS = 120_000;

/**
 * What a mirror fetches. Branches and tags, forced (an upstream rebase must
 * not wedge the mirror forever), and nothing else — pull refs are the
 * avalanche, and `refs/remotes/*` and `refs/notes/*` are not ours to hold.
 */
export const MIRROR_REFSPECS = [
  "+refs/heads/*:refs/heads/*",
  "+refs/tags/*:refs/tags/*",
] as const;

let outbound: OutboundOptions = {};

/** Test seam: what `vetHost` is told (resolver, exempt addresses). Never read from the environment. */
export function provideMirrorOutboundForTest(options: OutboundOptions): void {
  outbound = options;
}

/** Test seam: what `vetHost` is told now, so a test that changes it can put it back. */
export const mirrorOutboundForTest = (): OutboundOptions => outbound;

export const MIRROR_REFUSED = "refused: the remote's host is a private address";
export const MIRROR_UNRESOLVED = "the remote's host could not be resolved";

/**
 * Vet the clone URL's host and return git's environment pinned to the
 * address that passed — or the one sentence that ends the sync.
 */
export async function vettedEnv(
  url: string,
  authEnv: Record<string, string>,
  protocols?: string,
): Promise<Result<Record<string, string>, GitMirrorError>> {
  const host = new URL(url).hostname;
  // A host the operator vouched for as an origin (`FORGE_ORIGIN_ALLOW`) is
  // trusted for that origin's git as an admin-trusted host is: by name, and
  // pinned to the answer that passed. Otherwise it connects and can never
  // be mirrored. An address literal named there is not trusted: trust is by
  // name, never by address (`origins/trusted-hosts.ts`).
  const trusted = operatorAllowed(url) ? [...trustedHosts(), host] : trustedHosts();
  const vetted = await vetHost(host, { ...outbound, trusted });
  if (!vetted.ok)
    return err({
      message: vetted.error === "refused" ? MIRROR_REFUSED : MIRROR_UNRESOLVED,
    });
  return ok(remoteGitEnv(authEnv, pinFor(url, vetted.value[0]!), protocols));
}

export interface RefSnapshot {
  /** ref name → object id. */
  readonly refs: ReadonlyMap<string, string>;
}

export interface RefChange {
  readonly ref: string;
  readonly oldOid: string;
  readonly newOid: string;
}

/** Every branch and tag this repo holds right now. */
export async function snapshotRefs(dir: string): Promise<RefSnapshot> {
  const refs = new Map<string, string>();
  for (const prefix of ["refs/heads/", "refs/tags/"]) {
    const listed = await listRefs(dir, prefix);
    if (!listed.ok) continue;
    for (const ref of listed.value) refs.set(ref.name, ref.oid);
  }
  return { refs };
}

const ZERO = "0".repeat(40);

/** What moved between two snapshots, in the shape a push event carries. */
export function refsChanged(
  before: RefSnapshot,
  after: RefSnapshot,
): RefChange[] {
  const changes: RefChange[] = [];
  for (const [ref, newOid] of after.refs) {
    const oldOid = before.refs.get(ref);
    if (oldOid !== newOid)
      changes.push({ ref, oldOid: oldOid ?? ZERO, newOid });
  }
  for (const [ref, oldOid] of before.refs) {
    if (!after.refs.has(ref)) changes.push({ ref, oldOid, newOid: ZERO });
  }
  return changes.sort((a, b) => a.ref.localeCompare(b.ref));
}

export interface GitMirrorError {
  readonly message: string;
}

/**
 * Where this bare repo fetches from, as `configureMirror` wrote it, or ""
 * for one that has no remote. What a detached mirror still knows of its
 * origin when the page it came from was never remembered.
 */
export async function mirrorRemoteUrl(dir: string): Promise<string> {
  const run = await runGitCapture(["config", "--get", "remote.origin.url"], {
    cwd: dir,
  });
  return run.code === 0 ? run.stdout.trim() : "";
}

/**
 * Configure a bare repo as a mirror of `cloneUrl`. The URL is stored
 * credential-free — the token rides in the environment, per invocation — so
 * `cat`ing the data directory never yields a secret and a `tar` of it is not
 * an exfiltration.
 */
export async function configureMirror(
  dir: string,
  cloneUrl: string,
): Promise<Result<void, GitMirrorError>> {
  const url = safeRemoteUrl(cloneUrl);
  if (url === undefined)
    return err({ message: `refusing an unusable clone URL` });

  const steps: string[][] = [
    ["remote", "add", "origin", url],
    ["config", "--replace-all", "remote.origin.fetch", MIRROR_REFSPECS[0]],
    ["config", "--add", "remote.origin.fetch", MIRROR_REFSPECS[1]],
    // Pinned false even though we never set it: this is the flag that turns
    // an ordinary `git push origin` into a destructive `push --mirror`.
    ["config", "remote.origin.mirror", "false"],
    ["config", "core.logAllRefUpdates", "true"],
  ];
  for (const args of steps) {
    const run = await runGitCapture(args, { cwd: dir });
    // `remote add` on an already-configured mirror is a re-run, not a failure.
    if (run.code !== 0 && args[0] === "remote") {
      const setUrl = await runGitCapture(["remote", "set-url", "origin", url], {
        cwd: dir,
      });
      if (setUrl.code !== 0)
        return err({ message: redact(setUrl.stderr.trim()) });
      continue;
    }
    if (run.code !== 0) return err({ message: redact(run.stderr.trim()) });
  }
  return ok();
}

export interface FetchResult {
  readonly changes: readonly RefChange[];
}

/**
 * Fetch the origin's branches and tags. The refspecs are passed explicitly
 * on every call rather than trusted to config, so this is correct even
 * against a repo somebody reconfigured by hand.
 *
 * `--prune` deletes refs the origin dropped; because the tag refspec is
 * explicit, that covers tags too and `--prune-tags` adds nothing (and is
 * outright dangerous on a non-mirror remote, where it deletes local tags
 * that never came from there).
 */
export async function fetchMirror(
  dir: string,
  cloneUrl: string,
  authEnv: Record<string, string>,
): Promise<Result<FetchResult, GitMirrorError>> {
  const url = safeRemoteUrl(cloneUrl);
  if (url === undefined)
    return err({ message: "refusing an unusable clone URL" });

  const pinned = await vettedEnv(url, authEnv);
  if (!pinned.ok) return pinned;
  const before = await snapshotRefs(dir);
  const run = await runGitCapture(
    [
      "fetch",
      "--prune",
      "--no-write-fetch-head",
      "--no-recurse-submodules",
      "--quiet",
      url,
      ...MIRROR_REFSPECS,
    ],
    { cwd: dir, env: pinned.value, timeoutMs: FETCH_TIMEOUT_MS },
  );
  if (run.code !== 0) {
    return err({
      message:
        redact(run.stderr.trim(), ...secretsIn(authEnv)) || "fetch failed",
    });
  }
  const after = await snapshotRefs(dir);
  return ok({ changes: refsChanged(before, after) });
}

/**
 * Fetch ONE ref from a remote we are not a mirror of, and say where it
 * landed.
 *
 * The contribute flow needs this: the branch it is about to propose has to
 * start from the *upstream's* base, and the workbench it commits in is the
 * mirror of a fork — a different repository, on the same forge, that may be
 * hundreds of commits behind. `git/merge.ts`'s `fetchInto` does the same job
 * between two local directories; this is the version that crosses a network
 * and therefore needs the origin's credential in the environment.
 *
 * Nothing is written under `refs/` here. The fetched tip comes back as an
 * object id and the caller decides what, if anything, to name it — a fetch
 * that quietly moved a branch would be a push-through the origin never saw.
 */
export async function fetchRefFrom(
  dir: string,
  cloneUrl: string,
  srcRef: string,
  authEnv: Record<string, string>,
): Promise<Result<string, GitMirrorError>> {
  const url = safeRemoteUrl(cloneUrl);
  if (url === undefined)
    return err({ message: "refusing an unusable clone URL" });
  if (!isSafeRef(srcRef))
    return err({ message: `refusing an unsafe ref: ${srcRef}` });

  const pinned = await vettedEnv(url, authEnv);
  if (!pinned.ok) return pinned;
  const run = await runGitCapture(
    [
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--quiet",
      url,
      // A bare source ref: the objects arrive and FETCH_HEAD names the tip,
      // without any local ref moving.
      srcRef,
    ],
    { cwd: dir, env: pinned.value, timeoutMs: FETCH_TIMEOUT_MS },
  );
  if (run.code !== 0) {
    return err({
      message:
        redact(run.stderr.trim(), ...secretsIn(authEnv)) ||
        `could not fetch ${srcRef}`,
    });
  }
  const tip = await runGitCapture(["rev-parse", "FETCH_HEAD"], { cwd: dir });
  const oid = tip.stdout.trim();
  if (tip.code !== 0 || !isSafeOid(oid))
    return err({ message: `no such ref upstream: ${srcRef}` });
  return ok(oid);
}

export interface PushUpdate {
  readonly ref: string;
  /** The oid the origin is expected to hold; zeros for a ref being created. */
  readonly oldOid: string;
  /** Zeros to delete the ref upstream. */
  readonly newOid: string;
}

/**
 * Push ref updates to the origin. Every update names an explicit refspec and
 * an explicit lease, so this can neither mirror-push nor blind-force.
 *
 * The lease is the three-part `--force-with-lease=<ref>:<expect>` form — the
 * only one git considers non-experimental, and the only one immune to our
 * own background fetcher. An empty `<expect>` (a ref being created) means
 * "must not already exist", which is exactly the check we want.
 */
export async function pushToOrigin(
  dir: string,
  cloneUrl: string,
  updates: readonly PushUpdate[],
  authEnv: Record<string, string>,
  options: RunOptions = {},
): Promise<Result<void, GitMirrorError>> {
  // A push with no refspec is the `--mirror` accident waiting to happen;
  // refuse it here so no caller can construct one.
  if (updates.length === 0)
    return err({ message: "refusing a push with no refspec" });

  const url = safeRemoteUrl(cloneUrl);
  if (url === undefined)
    return err({ message: "refusing an unusable clone URL" });

  // --atomic: an origin that would take one ref and refuse another takes
  // neither, so a rejected push leaves both sides exactly where they were.
  const args: string[] = ["push", "--porcelain", "--atomic"];
  const refspecs: string[] = [];
  for (const update of updates) {
    if (!isSafeRef(update.ref))
      return err({ message: `refusing an unsafe ref: ${update.ref}` });
    const deleting = ZERO_OID.test(update.newOid);
    if (!deleting && !isSafeOid(update.newOid))
      return err({ message: `refusing an unsafe object id` });
    if (!ZERO_OID.test(update.oldOid) && !isSafeOid(update.oldOid))
      return err({ message: `refusing an unsafe object id` });

    // Creating a ref leases the empty string: "must not already exist".
    const expect = ZERO_OID.test(update.oldOid) ? "" : update.oldOid;
    args.push(`--force-with-lease=${update.ref}:${expect}`);
    refspecs.push(
      deleting ? `:${update.ref}` : `${update.newOid}:${update.ref}`,
    );
  }
  args.push(url, ...refspecs);

  const run = await runGitCapture(args, {
    ...options,
    env: { ...authEnv, ...(options.env ?? {}) },
    cwd: dir,
    timeoutMs: options.timeoutMs ?? PUSH_TIMEOUT_MS,
  });
  if (run.code !== 0) {
    // The origin's own words are what the pusher needs to see — scrubbed of
    // anything that could carry a credential. Its message arrives as
    // `remote:` lines on stderr; porcelain's own reason ("pre-receive hook
    // declined") is the fallback when the remote said nothing.
    const detail =
      remoteSaid(run.stderr) ||
      pickRejection(run.stdout) ||
      run.stderr.trim() ||
      `git push exited ${run.code}`;
    return err({ message: redact(detail) });
  }
  return ok();
}

/** What the far end printed, without git's `remote:` prefix. */
function remoteSaid(stderr: string): string {
  const said: string[] = [];
  for (const line of stderr.split("\n")) {
    const match = /^remote:\s?(.*)$/.exec(line.trimEnd());
    const text = match?.[1]?.trim();
    if (text) said.push(text);
  }
  return said.join("; ");
}

/**
 * The reason line out of `push --porcelain` output. Porcelain marks a
 * refused ref with `!` and puts the origin's reason in parentheses, which is
 * far more useful than "failed to push some refs".
 */
function pickRejection(stdout: string): string {
  const reasons: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("!")) continue;
    const parts = line.split("\t");
    const detail = parts[2]?.trim();
    if (detail) reasons.push(detail.replace(/^\[|\]$/g, ""));
  }
  return reasons.join("; ");
}

/** Point HEAD at the origin's default branch, if we have it. */
export async function adoptDefaultBranch(
  dir: string,
  branch: string,
): Promise<boolean> {
  if (!isSafeRef(branch)) return false;
  const exists = await runGitCapture(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: dir },
  );
  if (exists.code !== 0) return false;
  const set = await runGitCapture(
    ["symbolic-ref", "HEAD", `refs/heads/${branch}`],
    { cwd: dir },
  );
  return set.code === 0;
}
