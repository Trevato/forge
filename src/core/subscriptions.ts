/**
 * Subscriptions: the Claude accounts the crew works on.
 *
 * An operator with a personal plan and a work plan keeps both here, sealed
 * at rest (`kernel/secret.ts`), and says which repositories and
 * organizations each one pays for — down to a single crew member. A run
 * takes its token from the nearest grant: the repository's, then the
 * owner's, an agent's own before the crew's. Nothing granted anywhere means
 * the forge's own token, as before.
 *
 * When the provider turns an account away, that account rests until the
 * provider says it is ready, and the next account on the same grant takes
 * the run. Two accounts on one grant therefore rotate: the one used longest
 * ago goes first, so neither carries the whole day.
 *
 * A token is opened only for the run's environment, never listed and never
 * shown again once added.
 *
 * The forge's own token is a subscription too: the row `PLATFORM`, shown as
 * `platform (env)`, with no sealed token — its credential is the forge's
 * environment. It is never granted; it is what a run gets when no grant
 * reaches it, and the ledger and the windows count it like any other. The
 * grants are each sealed account's scope, an allow-list: an account with
 * none is never offered to the crew (a person's own plan, kept apart).
 */

import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { open, seal } from "../kernel/secret.ts";
import { limitValue } from "../settings/limits.ts";

export type SubscriptionKind = "oauth" | "api_key";

export interface Subscription {
  readonly id: string;
  /** What the operator calls it: "personal", "work". Unique, case-blind. */
  readonly name: string;
  readonly kind: SubscriptionKind;
  /**
   * Anthropic-compatible API base URL (OpenRouter, etc.), or null for
   * Anthropic itself. Plain text — not a secret. Claude Code reads it as
   * `ANTHROPIC_BASE_URL` (without a trailing `/v1`; the SDK adds that).
   */
  readonly apiBase: string | null;
  /** Set while the provider's limit holds; the account is skipped until then. */
  readonly restingUntil: string | null;
  /** The provider's own words for why, one line. */
  readonly restingSaid: string;
  readonly lastUsedAt: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

interface Row {
  id: string;
  name: string;
  kind: string;
  api_base: string | null;
  resting_until: string | null;
  resting_said: string;
  last_used_at: string | null;
  created_by: string | null;
  created_at: string;
}

export const NAME_MAX = 40;
const TOKEN_MAX = 4096;

/** The forge's own token, from its environment: a row with no sealed token. */
export const PLATFORM = "platform";

/** Every crew member at a scope, as the grant's `agent_id`. */
export const EVERYONE = "";

export type SubscriptionError =
  | "invalid_name"
  | "name_taken"
  | "invalid_token"
  | "invalid_api_base";

/** How soon an account out of budget is looked at again. */
const BUDGET_RECHECK_MS = 3_600_000;
/** Less than this left on a budget is not worth starting a run on. */
export const MIN_RUN_USD = 0.25;

/**
 * What an account has committed, as SQL (`s` is the subscription row, `?4`
 * the run picking now): what it has ever spent — `s.spent_usd`, a counter
 * the run table's trigger only adds to, so deleting runs gives nothing back
 * — and, for each run still queued or running, the part of its reservation
 * it has not spent yet. Never the picking run's own reservation, which it is
 * about to make again.
 */
const COMMITTED = `(s.spent_usd + (SELECT COALESCE(SUM(
    MAX(0, COALESCE(r.budget_reserved_usd, 0) - r.cost_usd)), 0)
  FROM run r WHERE r.subscription_id = s.id
    AND r.state IN ('queued', 'running') AND r.id <> ?4))`;

/** An account's whole-life budget and what its runs have spent, in dollars. */
export interface Budget {
  readonly budgetUsd: number | null;
  readonly spentUsd: number;
  /** Set by whoever made this forge (a spawned child's starter key): not this forge's to raise. */
  readonly locked: boolean;
}

/** Every sealed account's budget and spend, by id, in one read. */
export function budgetsOf(db: Database): Map<string, Budget> {
  const rows = db
    .query<{ id: string; budget_usd: number | null; spent_usd: number; budget_locked: number }, []>(
      `SELECT s.id, s.budget_usd, s.budget_locked, s.spent_usd
       FROM subscription s WHERE s.id <> 'platform'`,
    )
    .all();
  return new Map(
    rows.map((r) => [r.id, { budgetUsd: r.budget_usd, spentUsd: r.spent_usd, locked: r.budget_locked === 1 }]),
  );
}

/** Why a budget change would be refused, in the words MCP and the terminal share. */
export type BudgetRefusal = { readonly code: "not_found" | "locked" | "invalid"; readonly says: string };

/**
 * The refusal for setting (or clearing, null) an account's budget, or
 * undefined when `setBudget` would take it. One rule for MCP, the terminal.
 */
export function budgetRefusal(db: Database, subscriptionId: string, usd: number | null): BudgetRefusal | undefined {
  const held = budgetsOf(db).get(subscriptionId);
  if (!held) return { code: "not_found", says: "no such account" };
  if (held.locked && (usd === null || !(usd < (held.budgetUsd ?? 0))))
    return {
      code: "locked",
      says: "This budget was set by whoever made this forge: it can be lowered, never raised or cleared.",
    };
  const max = limitValue(db, "subscription.budget_max_usd");
  if (usd !== null && !(Number.isFinite(usd) && usd > 0 && usd <= max))
    return { code: "invalid", says: `A budget is dollars from 1 to ${max}, or null for none.` };
  return undefined;
}

/**
 * Set or clear (null) an account's whole-life budget. False for no such
 * sealed account, a budget out of range, or a locked budget: one set by
 * whoever made this forge is never changed from inside it.
 */
export function setBudget(db: Database, subscriptionId: string, usd: number | null): boolean {
  if (usd !== null && !(Number.isFinite(usd) && usd > 0 && usd <= limitValue(db, "subscription.budget_max_usd"))) return false;
  const value = usd === null ? null : Math.round(usd * 100) / 100;
  // A locked budget may only come down: never up, never cleared.
  return (
    db
      .query(
        `UPDATE subscription SET budget_usd = ?1
         WHERE id = ?2 AND id <> 'platform'
           AND (budget_locked = 0 OR (?1 IS NOT NULL AND ?1 < budget_usd))`,
      )
      .run(value, subscriptionId).changes > 0
  );
}

/**
 * A budget that cannot be raised from inside this forge: what spawn puts on
 * a child's starter key, so the spawner's money ends where they said.
 */
export function lockBudget(db: Database, subscriptionId: string, usd: number): boolean {
  if (!(Number.isFinite(usd) && usd > 0 && usd <= limitValue(db, "subscription.budget_max_usd"))) return false;
  return (
    db
      .query(
        "UPDATE subscription SET budget_usd = ?1, budget_locked = 1 WHERE id = ?2 AND id <> 'platform'",
      )
      .run(Math.round(usd * 100) / 100, subscriptionId).changes > 0
  );
}

const toSubscription = (r: Row): Subscription => ({
  id: r.id,
  name: r.name,
  kind: r.kind === "oauth" ? "oauth" : "api_key",
  apiBase: r.api_base && r.api_base.trim() !== "" ? r.api_base : null,
  restingUntil: r.resting_until,
  restingSaid: r.resting_said,
  lastUsedAt: r.last_used_at,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

const aad = (subscriptionId: string): string =>
  `subscription:${subscriptionId}`;

/** What a sealed account's token is bound to, for opening it elsewhere. */
export const subscriptionAad = aad;

/** The variable Claude Code reads a token of this kind from. */
export const envNameOf = (kind: SubscriptionKind): string =>
  kind === "oauth" ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY";

/** Longest accepted Anthropic-compatible base URL. */
export const API_BASE_MAX = 200;

/**
 * A pasted key as the owner meant it: every whitespace character (a wrapped line, a trailing newline, a
 * non-breaking space from a web page) and a leading `Bearer ` are dropped. Keys never contain whitespace,
 * and a gateway may use any shape at all, so nothing else is judged.
 */
export function normalizeToken(raw: string): string {
  return raw.replace(/^\s*bearer\s+/i, "").replace(/[\s\u200b-\u200d\ufeff]+/g, "");
}

/**
 * What kind of token this is. A token from `claude setup-token` begins
 * `sk-ant-oat…` and is a person's own plan: it goes under
 * `CLAUDE_CODE_OAUTH_TOKEN` and never takes a base URL. Anything else that
 * could be a key — not empty once normalized, not absurdly long — is an API key:
 * Anthropic's `sk-ant-api…`, the `sk-ant-usr…` keys that come with a
 * subscription's API credits, OpenRouter's `sk-or-v1-…`, or whatever shape
 * a gateway hands out with its base URL. The forge keeps no list of shapes;
 * the provider answers a bad key on the first call, and the run says so.
 * Takes a token already through `normalizeToken`, so the kind and the stored
 * value are read from the same string; whitespace left in is refused.
 */
export function kindOfToken(token: string): SubscriptionKind | undefined {
  if (token === "" || token.length > TOKEN_MAX || /\s|\0/.test(token)) return undefined;
  if (/^sk-ant-oat\d*-/.test(token)) return "oauth";
  return "api_key";
}

/**
 * An Anthropic-compatible base URL for Claude Code: https, no credentials,
 * no query or hash. Trailing slashes and a trailing `/v1` are stripped — the
 * Anthropic SDK appends `/v1/messages` itself (OpenRouter wants
 * `https://openrouter.ai/api`, not `…/api/v1`).
 */
export function parseApiBase(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (trimmed.length > API_BASE_MAX) return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.search !== "" || url.hash !== "") return undefined;
  if (url.hostname === "") return undefined;
  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1")) path = path.slice(0, -3).replace(/\/+$/, "");
  return path === "" || path === "/"
    ? `https://${url.host}`
    : `https://${url.host}${path}`;
}

/** Hostname a run must be allowed to reach for this base URL, if any. */
export function hostOfApiBase(apiBase: string | null | undefined): string | undefined {
  if (apiBase === null || apiBase === undefined || apiBase.trim() === "")
    return undefined;
  try {
    return new URL(apiBase).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Environment variables a crew run needs for a picked account: the token
 * under the variable Claude Code reads, plus `ANTHROPIC_BASE_URL` (and
 * OpenRouter's `ANTHROPIC_AUTH_TOKEN` dance) when the account has a gateway.
 */
export function credentialEnvOf(
  picked: Extract<Pick, { kind: "ready" }>,
): Record<string, string> {
  const base = picked.apiBase;
  if (base === null || base === undefined || base === "") {
    return { [picked.envName]: picked.token };
  }
  const host = hostOfApiBase(base) ?? "";
  const openrouter =
    host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  if (openrouter) {
    // Claude Code + OpenRouter: AUTH_TOKEN carries the key; API_KEY must be
    // an empty string so Claude Code does not fall back to api.anthropic.com.
    return {
      ANTHROPIC_BASE_URL: base,
      ANTHROPIC_AUTH_TOKEN: picked.token,
      ANTHROPIC_API_KEY: "",
    };
  }
  return {
    ANTHROPIC_BASE_URL: base,
    [picked.envName]: picked.token,
  };
}

export function isSubscriptionName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= NAME_MAX &&
    /^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(name)
  );
}

export function addSubscription(
  db: Database,
  dataDir: string,
  input: {
    name: string;
    token: string;
    /** Anthropic-compatible gateway URL; empty/omitted = Anthropic. */
    apiBase?: string | undefined;
    createdBy?: string | undefined;
  },
): Result<Subscription, SubscriptionError> {
  const name = input.name.trim();
  if (!isSubscriptionName(name)) return err("invalid_name");
  const rawBase = (input.apiBase ?? "").trim();
  let apiBase: string | null = null;
  if (rawBase !== "") {
    const parsed = parseApiBase(rawBase);
    if (parsed === undefined) return err("invalid_api_base");
    apiBase = parsed;
  }
  const token = normalizeToken(input.token);
  const kind = kindOfToken(token);
  if (kind === undefined) return err("invalid_token");
  // A Claude subscription token is Anthropic's own plan — never a gateway.
  if (kind === "oauth" && apiBase !== null) return err("invalid_api_base");
  if (getSubscriptionByName(db, name) !== undefined) return err("name_taken");
  const subscriptionId = id();
  db.query(
    `INSERT INTO subscription (id, name, kind, token_enc, api_base, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).run(
    subscriptionId,
    name,
    kind,
    seal(dataDir, token, aad(subscriptionId)),
    apiBase,
    input.createdBy ?? null,
  );
  return ok(getSubscription(db, subscriptionId)!);
}

export function getSubscription(
  db: Database,
  subscriptionId: string,
): Subscription | undefined {
  const row = db
    .query<Row, [string]>(
      `SELECT id, name, kind, api_base, resting_until, resting_said, last_used_at, created_by, created_at
       FROM subscription WHERE id = ?1`,
    )
    .get(subscriptionId);
  return row ? toSubscription(row) : undefined;
}

export function getSubscriptionByName(
  db: Database,
  name: string,
): Subscription | undefined {
  const row = db
    .query<Row, [string]>(
      `SELECT id, name, kind, api_base, resting_until, resting_said, last_used_at, created_by, created_at
       FROM subscription WHERE name = ?1 COLLATE NOCASE`,
    )
    .get(name.trim());
  return row ? toSubscription(row) : undefined;
}

export function listSubscriptions(db: Database): Subscription[] {
  return db
    .query<Row, []>(
      `SELECT id, name, kind, api_base, resting_until, resting_said, last_used_at, created_by, created_at
       FROM subscription WHERE id <> 'platform' ORDER BY name COLLATE NOCASE`,
    )
    .all()
    .map(toSubscription);
}

/**
 * Every credential a run can use: the platform's first, then the sealed
 * pool. `listSubscriptions` is the pool alone — what can be granted,
 * removed or given a token.
 */
export function listCredentials(db: Database): Subscription[] {
  const platform = getSubscription(db, PLATFORM);
  return [...(platform === undefined ? [] : [platform]), ...listSubscriptions(db)];
}

/** Its grants go with it; runs that used it keep the id as history. */
export function deleteSubscription(
  db: Database,
  subscriptionId: string,
): boolean {
  return (
    db
      .query("DELETE FROM subscription WHERE id = ?1 AND id <> 'platform'")
      .run(subscriptionId).changes > 0
  );
}

/** The provider turned this account away; nothing uses it until `until`. */
export function restSubscription(
  db: Database,
  subscriptionId: string,
  until: string,
  said: string,
): void {
  db.query(
    `UPDATE subscription SET resting_until = ?2, resting_said = ?3 WHERE id = ?1`,
  ).run(subscriptionId, until, said.slice(0, 160));
}

/** An operator's word over the provider's: use it again now. */
export function wakeSubscription(db: Database, subscriptionId: string): void {
  db.query(
    `UPDATE subscription SET resting_until = NULL, resting_said = '' WHERE id = ?1`,
  ).run(subscriptionId);
}

function touchSubscription(
  db: Database,
  subscriptionId: string,
  now: Date,
): void {
  db.query(`UPDATE subscription SET last_used_at = ?2 WHERE id = ?1`).run(
    subscriptionId,
    now.toISOString(),
  );
}

// ---- grants ----

export interface Grant {
  /** A repository id or an owner's (organization's) user id. */
  readonly scopeId: string;
  /** An agent's user id, or `EVERYONE`. */
  readonly agentId: string;
  readonly subscriptionId: string;
}

export function listGrants(db: Database, scopeId: string): Grant[] {
  return db
    .query<
      { scope_id: string; agent_id: string; subscription_id: string },
      [string]
    >(
      `SELECT scope_id, agent_id, subscription_id FROM subscription_grant
       WHERE scope_id = ?1 ORDER BY agent_id, subscription_id`,
    )
    .all(scopeId)
    .map((r) => ({
      scopeId: r.scope_id,
      agentId: r.agent_id,
      subscriptionId: r.subscription_id,
    }));
}

/** Every grant on this forge, for the page that says where each account goes. */
export function listAllGrants(db: Database): Grant[] {
  return db
    .query<{ scope_id: string; agent_id: string; subscription_id: string }, []>(
      `SELECT scope_id, agent_id, subscription_id FROM subscription_grant
       ORDER BY subscription_id, scope_id, agent_id`,
    )
    .all()
    .map((r) => ({
      scopeId: r.scope_id,
      agentId: r.agent_id,
      subscriptionId: r.subscription_id,
    }));
}

/**
 * The set of accounts one agent (or everyone) may use at a scope, replaced
 * whole. An empty set removes the grant, and the wider one applies again.
 */
export function setGrants(
  db: Database,
  scopeId: string,
  agentId: string,
  subscriptionIds: readonly string[],
): void {
  const known = new Set(listSubscriptions(db).map((s) => s.id));
  const wanted = [...new Set(subscriptionIds)].filter((s) => known.has(s));
  db.transaction(() => {
    db.query(
      "DELETE FROM subscription_grant WHERE scope_id = ?1 AND agent_id = ?2",
    ).run(scopeId, agentId);
    for (const subscriptionId of wanted)
      db.query(
        `INSERT INTO subscription_grant (scope_id, agent_id, subscription_id)
         VALUES (?1, ?2, ?3)`,
      ).run(scopeId, agentId, subscriptionId);
  })();
}

/**
 * Where each sealed account may be used, by id: `owner/name` for a
 * repository, `@org` for an organization, with ` (agent)` when the grant
 * names one. An account absent here has an empty scope.
 */
export function scopesOf(db: Database): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const g of listGrantPlaceRows(db)) {
    const at = g.agent === undefined ? g.place : `${g.place} (${g.agent})`;
    out.set(g.subscriptionId, [...(out.get(g.subscriptionId) ?? []), at]);
  }
  return out;
}

export interface GrantPlace {
  readonly subscription: string;
  /** `owner/name` for a repository, `@org` for an organization. */
  readonly place: string;
  readonly href: string;
  /** The agent's username, or undefined for everyone on the crew. */
  readonly agent: string | undefined;
}

/** Every grant with its names on, for the page that says where each goes. */
export function listGrantPlaces(db: Database): GrantPlace[] {
  return listGrantPlaceRows(db).map(({ subscriptionId: _, ...g }) => g);
}

function listGrantPlaceRows(
  db: Database,
): (GrantPlace & { subscriptionId: string })[] {
  return db
    .query<
      {
        subscription_id: string;
        subscription: string;
        agent: string | null;
        repo_name: string | null;
        repo_owner: string | null;
        org: string | null;
      },
      []
    >(
      `SELECT s.id AS subscription_id, s.name AS subscription, a.username AS agent,
              r.name AS repo_name, ro.username AS repo_owner, o.username AS org
       FROM subscription_grant g
       JOIN subscription s ON s.id = g.subscription_id
       LEFT JOIN repo r ON r.id = g.scope_id
       LEFT JOIN user ro ON ro.id = r.owner_id
       LEFT JOIN user o ON o.id = g.scope_id
       LEFT JOIN user a ON a.id = g.agent_id
       ORDER BY s.name COLLATE NOCASE, repo_owner, repo_name, org, agent`,
    )
    .all()
    .map((r) => ({
      subscriptionId: r.subscription_id,
      subscription: r.subscription,
      place:
        r.repo_name !== null
          ? `${r.repo_owner}/${r.repo_name}`
          : r.org !== null
            ? `@${r.org}`
            : "a place that is gone",
      href:
        r.repo_name !== null
          ? `/${r.repo_owner}/${r.repo_name}/settings/crew`
          : r.org !== null
            ? `/${r.org}`
            : "/settings/subscriptions",
      agent: r.agent ?? undefined,
    }));
}

// ---- the pick ----

export type Pick =
  /** No grant reaches this run: the forge's own token, `PLATFORM`, from its environment. */
  | { readonly kind: "env" }
  /** No grant reaches this run and its owner is not a forge admin: the forge's token is not theirs to spend. */
  | { readonly kind: "none" }
  | {
      readonly kind: "ready";
      readonly subscription: Subscription;
      readonly envName: string;
      readonly token: string;
      /** Anthropic-compatible gateway URL, or null for Anthropic itself. */
      readonly apiBase: string | null;
      /** On a budgeted account: the most this run may spend, reserved for it. */
      readonly capUsd?: number;
    }
  /** Every account on the nearest grant is resting; the earliest to wake. */
  | {
      readonly kind: "resting";
      readonly until: string;
      readonly said: string;
      readonly names: readonly string[];
    };

export interface PickScope {
  readonly repoId: string;
  readonly ownerId: string;
  readonly agentId: string;
}

/**
 * The account a run works on. The nearest grant wins whole: a repository's
 * before its owner's, this agent's before everyone's — and a grant whose
 * accounts are all resting does not fall through to a wider one, because a
 * work repository must not quietly spend the personal plan. Within the
 * grant, the account used longest ago goes first.
 */
export function pickSubscription(
  db: Database,
  dataDir: string,
  scope: PickScope,
  now: Date,
  reserve?: { readonly runId: string; readonly usd: number },
): Pick {
  const rows = db
    .query<
      Row & {
        scope_id: string;
        agent_id: string;
        token_enc: string;
        budget_usd: number | null;
        spent_usd: number;
      },
      [string, string, string, string]
    >(
      `SELECT g.scope_id, g.agent_id, s.id, s.name, s.kind, s.token_enc, s.api_base, s.resting_until,
              s.resting_said, s.last_used_at, s.created_by, s.created_at, s.budget_usd,
              ${COMMITTED} AS spent_usd
       FROM subscription_grant g JOIN subscription s ON s.id = g.subscription_id
       WHERE g.scope_id IN (?1, ?2) AND g.agent_id IN (?3, '') AND s.id <> 'platform'
       ORDER BY (g.scope_id = ?1) DESC, (g.agent_id = ?3) DESC,
                s.last_used_at IS NOT NULL, s.last_used_at, s.name COLLATE NOCASE`,
    )
    .all(scope.repoId, scope.ownerId, scope.agentId, reserve?.runId ?? "");
  const first = rows[0];
  if (first === undefined) {
    const owner = db
      .query<{ is_admin: number }, [string]>("SELECT is_admin FROM user WHERE id = ?1")
      .get(scope.ownerId);
    return owner?.is_admin === 1 ? { kind: "env" } : { kind: "none" };
  }
  const grant = rows.filter(
    (r) => r.scope_id === first.scope_id && r.agent_id === first.agent_id,
  );
  // An account whose whole-life budget is spent is not offered again until
  // an admin raises it; looked at again within the hour, so a raise is felt.
  // Spent counts what other runs on it may still spend (their reservation)
  // as well as what every run has spent, so runs started together cannot
  // each pass a budget that only one of them fits in.
  const spent = (r: (typeof grant)[number]) =>
    r.budget_usd !== null && r.budget_usd - r.spent_usd < MIN_RUN_USD;
  const awake = grant.find(
    (r) =>
      !spent(r) &&
      (r.resting_until === null || r.resting_until <= now.toISOString()),
  );
  if (awake === undefined && grant.every(spent)) {
    const first = grant[0]!;
    return {
      kind: "resting",
      until: new Date(now.getTime() + BUDGET_RECHECK_MS).toISOString(),
      said: `its $${first.budget_usd} budget is spent; an admin can raise it`,
      names: grant.map((r) => r.name),
    };
  }
  if (awake === undefined) {
    const soonest = grant
      .filter((r) => !spent(r) && r.resting_until !== null)
      .map((r) => r.resting_until!)
      .sort()
      .at(0)!;
    return {
      kind: "resting",
      until: soonest,
      said: grant.find((r) => r.resting_until === soonest)!.resting_said,
      names: grant.map((r) => r.name),
    };
  }
  const opened = open(dataDir, awake.token_enc, aad(awake.id));
  // A token that will not open (a data directory restored under another
  // key) is a resting account with the reason on it, not a run that fails.
  if (!opened.ok) {
    restSubscription(
      db,
      awake.id,
      new Date(now.getTime() + 24 * 3_600_000).toISOString(),
      "its token would not open; add it again",
    );
    return pickSubscription(db, dataDir, scope, now);
  }
  const subscription = toSubscription(awake);
  touchSubscription(db, awake.id, now);
  // On a budgeted account the run may spend at most what is left, and that
  // much is reserved for it now, in the same synchronous step as the
  // choice, so the next pick already counts it.
  let capUsd: number | undefined;
  if (awake.budget_usd !== null && reserve !== undefined) {
    capUsd = Math.max(0, Math.min(reserve.usd, awake.budget_usd - awake.spent_usd));
    db.query(
      "UPDATE run SET subscription_id = ?1, budget_reserved_usd = ?2 WHERE id = ?3",
    ).run(awake.id, capUsd, reserve.runId);
  }
  return {
    kind: "ready",
    subscription: { ...subscription, lastUsedAt: now.toISOString() },
    envName: envNameOf(subscription.kind),
    token: opened.value,
    apiBase: subscription.apiBase,
    ...(capUsd === undefined ? {} : { capUsd }),
  };
}

/**
 * The accounts the crew on a repository works on, for pacing: the
 * repository's own grants if it has any, else its owner's — whichever
 * agent they name. Empty when none is granted (the forge's own token).
 */
export function grantedAccounts(
  db: Database,
  repoId: string,
  ownerId: string,
): { id: string; name: string }[] {
  const rows = db
    .query<{ id: string; name: string; scope_id: string }, [string, string]>(
      `SELECT DISTINCT s.id, s.name, g.scope_id
       FROM subscription_grant g JOIN subscription s ON s.id = g.subscription_id
       WHERE g.scope_id IN (?1, ?2) AND s.id <> 'platform'
       ORDER BY s.name COLLATE NOCASE`,
    )
    .all(repoId, ownerId);
  const own = rows.filter((r) => r.scope_id === repoId);
  return (own.length > 0 ? own : rows).map((r) => ({ id: r.id, name: r.name }));
}

/**
 * Whether the crew has any model credential to run on: a sealed account,
 * or a token or signed-in Claude config in the forge's own environment —
 * the places `credentialEnv` and the runner read. A spawned child starts
 * with none (its parent's credentials never travel), and its pages say so.
 */
export function crewHasCredential(
  db: Database,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (listSubscriptions(db).length > 0) return true;
  return ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "FORGE_CLAUDE_CONFIG_DIR"].some(
    (name) => (env[name] ?? "").trim() !== "",
  );
}

/** What MCP `subscriptions` and `GET /api/v1/admin/subscriptions` list: each account, never its token. */
export function subscriptionRows(db: Database) {
  const scopes = scopesOf(db);
  const budgets = budgetsOf(db);
  return listSubscriptions(db).map((s) => {
    const b = budgets.get(s.id);
    return {
      id: s.id,
      name: s.name,
      kind: s.kind,
      apiBase: s.apiBase,
      scopes: scopes.get(s.id) ?? [],
      budgetUsd: b?.budgetUsd ?? null,
      spentUsd: b?.spentUsd ?? 0,
      restingUntil: s.restingUntil,
      restingSaid: s.restingSaid,
      lastUsedAt: s.lastUsedAt,
    };
  });
}
