/**
 * What the operator decides about the credentials people connect, read from
 * the environment on each call: the guard.
 *
 * On a guarded host — one the operator registered an OAuth application for
 * (`FORGE_ORIGIN_CLIENT_ID`), or one a push rule covers
 * (`FORGE_ORIGIN_DENY_PUSH`) — a credential is checked before it is stored,
 * after each OAuth refresh, and daily (`origins/credential.ts`). An account
 * that administers the instance is refused, and so is an account that can
 * push to a repository `FORGE_ORIGIN_DENY_PUSH` protects. The risk is the
 * account the person authorized, not who owns this forge: a forge holds its
 * credential where agents run.
 *
 * A leaf module: parsing and one check over a `Provider`, no database.
 */

import { err, ok, type Result } from "../kernel/result.ts";
import type { Provider, RemoteIdentity, RemoteRepo } from "./types.ts";

type Env = Record<string, string | undefined>;

/** `git.example` from `https://git.example:8443/api/v1`: lower-case, no port. */
export function hostnameOf(url: string): string {
  // A bare `host:port` parses as a URL whose scheme is the host.
  const parsed = URL.parse(url.includes("://") ? url : `https://${url}`);
  return parsed === null ? "" : parsed.hostname.toLowerCase();
}

/**
 * The hostnames the operator registered an OAuth application for, in the
 * order it named them — the same entries `operatorClientId` reads.
 */
export function operatorHosts(env: Env = process.env): string[] {
  const out: string[] = [];
  for (const entry of (env.FORGE_ORIGIN_CLIENT_ID ?? "").split(",")) {
    const at = entry.indexOf("=");
    if (at === -1) continue;
    const host = entry.slice(0, at).trim().toLowerCase();
    if (host !== "" && entry.slice(at + 1).trim() !== "" && !out.includes(host))
      out.push(host);
  }
  return out;
}

/**
 * One entry of a list keyed by host: `host:owner/name` or `owner/name`.
 * The host is everything before the last `:` ahead of the first `/`, so a
 * port (`git.example:8443:owner/name`) survives; it is matched by hostname.
 */
function splitHost(entry: string): { host: string | null; rest: string } {
  const slash = entry.indexOf("/");
  const head = slash === -1 ? entry : entry.slice(0, slash);
  const colon = head.lastIndexOf(":");
  if (colon === -1) return { host: null, rest: entry };
  return {
    host: hostnameOf(entry.slice(0, colon)) || null,
    rest: entry.slice(colon + 1),
  };
}

// ---- the push guard ----

export interface DenyRule {
  /** The hostname it covers, or null for every origin. */
  readonly host: string | null;
  /** `owner/name`, `*` for any run of characters within one part. */
  readonly pattern: string;
  /** No wildcard: one repository, asked about by name. */
  readonly exact: boolean;
  readonly matches: (fullName: string) => boolean;
}

const PART = /^[A-Za-z0-9._*-]+$/;

/**
 * `FORGE_ORIGIN_DENY_PUSH`: comma-separated `owner/name` patterns, `*` for
 * any run of characters inside one part (`system/*`, `acme/app-*`). A bare
 * `owner` means `owner/*`. A `host:` in front limits an entry to that host;
 * without one it covers every origin. Case does not matter, as on Forgejo.
 */
export function denyPushRules(env: Env = process.env): DenyRule[] {
  const out: DenyRule[] = [];
  for (const raw of (env.FORGE_ORIGIN_DENY_PUSH ?? "").split(",")) {
    const entry = raw.trim();
    if (entry === "") continue;
    const { host, rest } = splitHost(entry);
    const parts = rest.split("/");
    const [owner, name = "*"] = parts;
    if (parts.length > 2 || owner === undefined) continue;
    if (!PART.test(owner) || !PART.test(name)) continue;
    const pattern = `${owner}/${name}`.toLowerCase();
    const re = new RegExp(
      `^${pattern
        .split("*")
        .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*")}$`,
    );
    out.push({
      host,
      pattern,
      exact: !pattern.includes("*"),
      matches: (fullName) => re.test(fullName.toLowerCase()),
    });
  }
  return out;
}

/** The rules that cover one host. */
export function rulesForHost(
  rules: readonly DenyRule[],
  host: string,
): DenyRule[] {
  return rules.filter((r) => r.host === null || r.host === host);
}

/**
 * Whether the operator protects this repository on this origin
 * (`FORGE_ORIGIN_DENY_PUSH`). Such a repository is never pushed to from
 * this forge, whatever the credential could do: a change to it is proposed
 * from the account's own fork (`origins/fork-route.ts`), whose pulls run the
 * base's workflows without its secrets.
 */
export function denied(
  origin: { apiUrl: string; webUrl: string },
  fullName: string,
  env: Env = process.env,
): boolean {
  const rules = denyPushRules(env);
  return hostsOf(origin).some((h) =>
    rulesForHost(rules, h).some((r) => r.matches(fullName)),
  );
}

/** The hostnames an origin answers to: its web host and its API host. */
const hostsOf = (origin: { apiUrl: string; webUrl: string }): string[] =>
  [...new Set([hostnameOf(origin.webUrl), hostnameOf(origin.apiUrl)])].filter(
    (h) => h !== "",
  );

/**
 * Whether the guard covers this origin: the operator registered an
 * application for its host, or a push rule covers it. Anywhere else a
 * person connects what they like, as before.
 */
export function guarded(
  origin: { apiUrl: string; webUrl: string },
  env: Env = process.env,
): boolean {
  const hosts = hostsOf(origin);
  const operator = operatorHosts(env);
  if (hosts.some((h) => operator.includes(h))) return true;
  const rules = denyPushRules(env);
  return hosts.some((h) => rulesForHost(rules, h).length > 0);
}

export type GuardError = "admin_account" | "can_push" | "guard_unchecked";

/** Why a credential was refused, in one sentence a person can act on. */
export interface GuardRefusal {
  readonly error: GuardError;
  readonly message: string;
  /** For `can_push`: the protected repositories it can push to. */
  readonly repos: readonly string[];
}

export interface GuardPass {
  /**
   * The repositories the account can see, when the walk ran (every guarded
   * host): the picker's cache, filled for free.
   */
  readonly listed: readonly RemoteRepo[] | null;
  /** The guard covered this host and the account passed it. */
  readonly checked: boolean;
}

/** Pages of the account's repositories the check walks: 20 × the page size. */
export const GUARD_MAX_PAGES = 20;
/**
 * Repositories named outright are asked about this many at a time. Every
 * one is asked about: a rule past some count is never skipped.
 */
const EXACT_AT_ONCE = 4;

const forgeName = (kind: Provider["kind"]): string =>
  kind === "github" ? "GitHub" : kind === "gitea" ? "Gitea" : "Forgejo";

function named(repos: readonly string[]): string {
  const shown = repos.slice(0, 3).join(", ");
  return repos.length > 3 ? `${shown} and ${repos.length - 3} more` : shown;
}

const unchecked = (): GuardRefusal => ({
  error: "guard_unchecked",
  message:
    "This forge could not check which repositories this account can push to. Try again in a minute.",
  repos: [],
});

const pause = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * Check a credential: before it is stored, after each OAuth refresh, and on
 * the daily sweep of stored origins (`origins/credential.ts`). `identity` is
 * what `whoami` just said about it; `provider` is built on the same
 * credential. `pauseMs` spaces the requests out — the sweep's, so a forge
 * re-checking its origins never leans on the origin it checks.
 *
 * The push check asks the origin for `permissions.push` — the account's
 * real rights, whatever scopes the token claims. A repository named outright
 * is asked about by name (`GET /repos/{o}/{r}`), every one of them; a
 * wildcard walks every repository the account can see (`walkRepos`), which
 * on Forgejo is every repository it owns, collaborates on or reaches through
 * a team — every way to push. The walk is ordered so nothing moves under it,
 * bounded, and counted; one that fails or does not finish refuses the
 * account rather than waving it through: the guard fails closed.
 */
export async function checkCredential(
  provider: Provider,
  identity: RemoteIdentity,
  env: Env = process.env,
  options: { pauseMs?: number } = {},
): Promise<Result<GuardPass, GuardRefusal>> {
  if (!guarded(provider, env)) return ok({ listed: null, checked: false });
  const host = hostnameOf(provider.webUrl);
  if (identity.siteAdmin)
    return err({
      error: "admin_account",
      message: `${identity.login} is an administrator of ${host}. Sign in to ${forgeName(provider.kind)} with your everyday non-admin account and try again.`,
      repos: [],
    });

  const rules = hostsOf(provider).flatMap((h) =>
    rulesForHost(denyPushRules(env), h),
  );
  const pushable = new Set<string>();
  const pauseMs = options.pauseMs ?? 0;
  // A confirmed hit is the answer, whatever else could not be read: an
  // account that can push to one protected repository is refused for that,
  // never let off as "could not check" because another lookup failed.
  const hit = (): Result<GuardPass, GuardRefusal> => {
    const repos = [...pushable].sort();
    return err({
      error: "can_push",
      message: `${identity.login} can push to ${named(repos)}. This forge does not accept an account that can push there. Connect an account without that access.`,
      repos,
    });
  };

  const exact = [...new Set(rules.filter((r) => r.exact).map((r) => r.pattern))];
  let failed = false;
  for (let at = 0; at < exact.length; at += EXACT_AT_ONCE) {
    if (at > 0) await pause(pauseMs);
    const answers = await Promise.all(
      exact.slice(at, at + EXACT_AT_ONCE).map((name) => provider.getRepo(name)),
    );
    for (const found of answers) {
      if (found.ok) {
        if (found.value.permissions.push) pushable.add(found.value.fullName);
        continue;
      }
      // A repository the account cannot see is one it cannot push to.
      if (found.error.error === "not_found" || found.error.error === "forbidden")
        continue;
      failed = true;
    }
    if (pushable.size > 0) return hit();
  }

  // The walk runs on every guarded host: it is the person's list of
  // repositories too, which the picker shows the moment they are back.
  // Only a wildcard rule needs it whole, so only then does a short or failed
  // walk refuse the account — after any hit in what it did read.
  const needed = rules.some((r) => !r.exact);
  if (needed) await pause(exact.length > 0 ? pauseMs : 0);
  const walked = await provider.walkRepos({
    maxPages: GUARD_MAX_PAGES,
    pauseMs,
  });
  if (needed && walked.ok)
    for (const repo of walked.value.repos)
      if (repo.permissions.push && rules.some((r) => r.matches(repo.fullName)))
        pushable.add(repo.fullName);
  if (pushable.size > 0) return hit();
  if (failed) return err(unchecked());
  if (needed) {
    if (!walked.ok) return err(unchecked());
    if (!walked.value.complete)
      return err(
        walked.value.why === "too_many"
          ? {
              error: "guard_unchecked",
              message:
                "This account can see more repositories than this forge can check. Connect an account with access to fewer repositories.",
              repos: [],
            }
          : unchecked(),
      );
  }

  return ok({
    listed: walked.ok && walked.value.complete ? [...walked.value.repos] : null,
    checked: true,
  });
}
