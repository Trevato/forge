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

export type SubscriptionKind = "oauth" | "api_key";

export interface Subscription {
  readonly id: string;
  /** What the operator calls it: "personal", "work". Unique, case-blind. */
  readonly name: string;
  readonly kind: SubscriptionKind;
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
  resting_until: string | null;
  resting_said: string;
  last_used_at: string | null;
  created_by: string | null;
  created_at: string;
}

export const NAME_MAX = 40;
const TOKEN_MAX = 512;

/** The forge's own token, from its environment: a row with no sealed token. */
export const PLATFORM = "platform";

/** Every crew member at a scope, as the grant's `agent_id`. */
export const EVERYONE = "";

export type SubscriptionError = "invalid_name" | "name_taken" | "invalid_token";

const toSubscription = (r: Row): Subscription => ({
  id: r.id,
  name: r.name,
  kind: r.kind === "oauth" ? "oauth" : "api_key",
  restingUntil: r.resting_until,
  restingSaid: r.resting_said,
  lastUsedAt: r.last_used_at,
  createdBy: r.created_by,
  createdAt: r.created_at,
});

const aad = (subscriptionId: string): string =>
  `subscription:${subscriptionId}`;

/** The variable Claude Code reads a token of this kind from. */
export const envNameOf = (kind: SubscriptionKind): string =>
  kind === "oauth" ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY";

/**
 * What kind of token this is, from its shape alone. A token from
 * `claude setup-token` begins `sk-ant-oat…`; an API key `sk-ant-api…`.
 * Anything else is not a Claude credential and is refused rather than sealed.
 */
export function kindOfToken(token: string): SubscriptionKind | undefined {
  if (token.length > TOKEN_MAX || /\s|\0/.test(token)) return undefined;
  if (/^sk-ant-oat\d*-/.test(token)) return "oauth";
  if (/^sk-ant-api\d*-/.test(token)) return "api_key";
  return undefined;
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
  input: { name: string; token: string; createdBy?: string | undefined },
): Result<Subscription, SubscriptionError> {
  const name = input.name.trim();
  if (!isSubscriptionName(name)) return err("invalid_name");
  const kind = kindOfToken(input.token);
  if (kind === undefined) return err("invalid_token");
  if (getSubscriptionByName(db, name) !== undefined) return err("name_taken");
  const subscriptionId = id();
  db.query(
    `INSERT INTO subscription (id, name, kind, token_enc, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).run(
    subscriptionId,
    name,
    kind,
    seal(dataDir, input.token, aad(subscriptionId)),
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
      `SELECT id, name, kind, resting_until, resting_said, last_used_at, created_by, created_at
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
      `SELECT id, name, kind, resting_until, resting_said, last_used_at, created_by, created_at
       FROM subscription WHERE name = ?1 COLLATE NOCASE`,
    )
    .get(name.trim());
  return row ? toSubscription(row) : undefined;
}

export function listSubscriptions(db: Database): Subscription[] {
  return db
    .query<Row, []>(
      `SELECT id, name, kind, resting_until, resting_said, last_used_at, created_by, created_at
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
  | {
      readonly kind: "ready";
      readonly subscription: Subscription;
      readonly envName: string;
      readonly token: string;
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
): Pick {
  const rows = db
    .query<
      Row & { scope_id: string; agent_id: string; token_enc: string },
      [string, string, string]
    >(
      `SELECT g.scope_id, g.agent_id, s.id, s.name, s.kind, s.token_enc, s.resting_until,
              s.resting_said, s.last_used_at, s.created_by, s.created_at
       FROM subscription_grant g JOIN subscription s ON s.id = g.subscription_id
       WHERE g.scope_id IN (?1, ?2) AND g.agent_id IN (?3, '') AND s.id <> 'platform'
       ORDER BY (g.scope_id = ?1) DESC, (g.agent_id = ?3) DESC,
                s.last_used_at IS NOT NULL, s.last_used_at, s.name COLLATE NOCASE`,
    )
    .all(scope.repoId, scope.ownerId, scope.agentId);
  const first = rows[0];
  if (first === undefined) return { kind: "env" };
  const grant = rows.filter(
    (r) => r.scope_id === first.scope_id && r.agent_id === first.agent_id,
  );
  const awake = grant.find(
    (r) => r.resting_until === null || r.resting_until <= now.toISOString(),
  );
  if (awake === undefined) {
    const soonest = grant
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
  return {
    kind: "ready",
    subscription: { ...subscription, lastUsedAt: now.toISOString() },
    envName: envNameOf(subscription.kind),
    token: opened.value,
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
