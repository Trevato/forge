/**
 * What the forge's agent asks before doing (#7650): outward-facing and
 * hard-to-undo actions — release and rollback, archive and delete, money,
 * secrets, tokens, SSH keys, and every admin-scope tool — are kept as a
 * confirm in the person's conversation and done only on their yes, a
 * same-origin POST from their own session (`http/api.ts`). One list, so a
 * reviewer reads in one place what the agent may never do on its own.
 *
 * Plain data in, plain data out: the door that holds a call is
 * `http/mcp/shared.ts` (`askedFirst`), the store is `core/fence.ts`.
 */

import { HELD_TTL_MS } from "../core/fence.ts";

type Args = Record<string, unknown>;

export interface Asking {
  /** What it does, as the start of a sentence: "roll the forge back to a kept release". */
  readonly does: string;
  /** Which calls ask; absent, every call that writes. */
  readonly asks?: (args: Args) => boolean;
  /** How it is undone, when it can be: said on the result turn. */
  readonly undo?: (args: Args) => string | undefined;
  /** Set when its result is shown once and never kept (a link, a credential): what the turn says instead. */
  readonly once?: string;
}

/** Ten minutes: a yes later than this is refused, and the agent asks again. */
export const CONFIRM_TTL_MS = HELD_TTL_MS;

/** Asks unless `arg` (absent: the tool's default, `reads[0]`) is one of `reads`. */
const not =
  (arg: string, ...reads: string[]) =>
  (args: Args) =>
    !reads.includes(String(args[arg] ?? reads[0]));

/** Every tool that asks first, by name. A tool with `needsAdminScope` must be here (test/conversation-confirm.test.ts). */
export const ASKING: Readonly<Record<string, Asking>> = {
  // Release and rollback.
  rollback: { does: "roll the forge back to a kept release", undo: () => "`rollback` to the release that was live rolls it forward again" },
  release_hold: {
    does: "hold or lift the release keeper",
    undo: (a) => (a["reason"] !== undefined ? "`release_hold` with `lift` and the hold's id lifts it" : undefined),
  },
  // Archive and delete.
  archive: {
    does: "archive or wake a repository",
    undo: (a) => `\`archive\` with \`archived: ${a["archived"] === false}\` turns it back`,
  },
  board_delete: { does: "delete a board" },
  subscription_delete: { does: "remove a Claude subscription and its grants" },
  // Money: subscriptions, budgets, grants and limits.
  subscription_add: { does: "add a Claude login to the crew's pool", undo: () => "`subscription_delete` with its id removes it" },
  subscription_budget: { does: "set a subscription's lifetime budget", undo: () => "`subscription_budget` with the old `usd` sets it back" },
  subscription_headroom: { does: "set the share of each window the crew leaves for people" },
  subscription_wake: { does: "use a resting subscription again now" },
  model_grant: { does: "give an account a monthly model grant", undo: () => "`model_grant` with `usdPerMonth: 0` takes it back" },
  model_ceiling: { does: "cap an account's model spend", undo: () => "`model_ceiling` with both `null` clears it" },
  limits: { does: "change one of the forge's limits", undo: () => "`limits` with `value: \"\"` restores the default" },
  // Secrets and credentials.
  secrets: { does: "set or remove a sealed secret", asks: not("action", "list") },
  app_env: { does: "set or unset an app's variable", asks: not("action", "list") },
  proposal_tokens: {
    does: "mint or revoke a child forge's propose-only credential",
    asks: not("verb", "list"),
    once: "The credential was shown once, to you, and is not kept here.",
  },
  mint_invite: { does: "mint a single-use invite link", once: "The invite link was shown once, to you, and is not kept here." },
  claim_link: {
    does: "make a new claim link for a child forge, ending the old one",
    once: "The claim link was shown once, to you, and is not kept here.",
  },
  ssh_keys: {
    does: "add or remove one of your SSH keys",
    asks: not("action", "list"),
    undo: (a) => (a["action"] === "add" ? "`ssh_keys` with `action: \"remove\"` and its id removes it" : undefined),
  },
  // Every admin-scope tool.
  agent: { does: "create, change or remove a crew agent" },
  app_domains: { does: "add, check or remove an app's domain" },
  backups_destination: { does: "set or forget where snapshots go" },
  backups_test: { does: "test the snapshot destination" },
  hooks: { does: "add or remove a repository's webhook" },
  mirror_now: { does: "bring the off-box snapshot mirror level now" },
  mirror_set: { does: "set or forget the off-box snapshot mirror" },
  org_teams: { does: "create, fill or remove an organization's team" },
  prompts: { does: "add, run or remove an app's prompt source" },
  repo_settings: {
    does: "change a repository's description or visibility",
    undo: () => "`repo_settings` with the old values sets them back",
  },
  sessions: { does: "list your sign-ins or sign a browser out" },
  telemetry_grant: {
    does: "grant or take back an agent's telemetry:read",
    undo: (a) => `\`telemetry_grant\` with \`on: ${a["on"] === false}\` turns it back`,
  },
};

/** Whether this call of `tool` asks first, scope aside. */
export function asksFirst(tool: string, args: Args): boolean {
  const asking = ASKING[tool];
  return asking !== undefined && (asking.asks?.(args) ?? true);
}

/** Argument names whose values are never repeated in a sentence or turn. */
const SECRET = /token|secret|key|value|password/i;

/** Control, format and line-breaking characters: an argument the agent wrote cannot start a new line or reorder the sentence. */
const UNSAID = /[\p{Cc}\p{Cf}\u2028\u2029]+/gu;

/** A string as said back: on one line, plain, cut to 60. */
const plain = (v: string): string => {
  const one = v.replace(UNSAID, " ").trim();
  return one.length > 60 ? `${one.slice(0, 60)}…` : one;
};

/** One argument as said back: scalars as written (strings plain, cut to 60), a secret hidden, anything else counted. */
function said(k: string, v: unknown): string {
  const name = plain(k);
  if (SECRET.test(k) && k !== "id") return `${name} (hidden)`;
  if (typeof v === "string") return `${name} ${plain(v)}`;
  if (typeof v === "number" || typeof v === "boolean" || v === null) return `${name} ${String(v)}`;
  return Array.isArray(v) ? `${name} (${v.length})` : `${name} (…)`;
}

/** The one sentence the person reads before saying yes. */
export function confirmSentence(tool: string, args: Args): string {
  const does = ASKING[tool]?.does ?? `call \`${tool}\``;
  const given = Object.entries(args)
    .filter(([k]) => k !== "dryRun")
    .map(([k, v]) => said(k, v));
  return `This will ${does} (\`${tool}\`${given.length === 0 ? "" : `: ${given.join(", ")}`}) as you, once you say yes within 10 minutes.`;
}

/** Undos of writes that do not ask first but may be held by the fence and done on a yes. */
const UNDONE: Readonly<Record<string, (args: Args) => string | undefined>> = {
  close: (a) => (a["state"] === "open" ? undefined : "`close` with `state: \"open\"` reopens it"),
  merge: () => "`take_back` opens the pull that reverts it",
};

/** What the result turn keeps of a done call: a sentence in place of a result shown only once. */
export const keptOf = (tool: string, value: unknown): unknown => ASKING[tool]?.once ?? value;

/** How a done call is undone, or undefined when it has no undo. */
export const undoOf = (tool: string, args: Args): string | undefined =>
  ASKING[tool]?.undo?.(args) ?? UNDONE[tool]?.(args);
