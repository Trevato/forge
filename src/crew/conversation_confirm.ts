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

import { HELD_TTL_MS, type Work } from "../core/fence.ts";

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
  // One action over every row a fleet query selects (#450); only `apply: true` writes.
  flow: {
    does: "apply a fleet operation to every row its query selects",
    undo: () => "`limb` with `action: undo` and the receipt's id reverts it for 24 hours",
  },
  subscription_delete: { does: "remove a Claude subscription and its grants" },
  // Money: subscriptions, budgets, grants and limits.
  subscription_add: { does: "add a Claude login to the crew's pool", undo: () => "`subscription_delete` with its id removes it" },
  subscription_budget: { does: "set a subscription's lifetime budget", undo: () => "`subscription_budget` with the old `usd` sets it back" },
  subscription_headroom: { does: "set the share of each window the crew leaves for people" },
  subscription_wake: { does: "use a resting subscription again now" },
  model_grant: { does: "give an account a monthly model grant", undo: () => "`model_grant` with `usdPerMonth: 0` takes it back" },
  model_ceiling: { does: "cap an account's model spend", undo: () => "`model_ceiling` with both `null` clears it" },
  limits: { does: "change one of the forge's limits", undo: () => "`limits` with `value: \"\"` restores the default" },
  // Closing the Later gate's unchosen ideas in one go; reading its proposal asks nothing.
  held: {
    does: "close the issues the Later gate review proposed to close",
    asks: (a) => a["apply"] !== undefined,
    undo: () => "`lift` on each issue revives it",
  },
  // Secrets and credentials.
  secrets: { does: "set or remove a sealed secret", asks: not("action", "list") },
  app_env: { does: "set or unset an app's variable", asks: not("action", "list") },
  // Absorbing restarts the app and changes the forge's menu for its readers.
  features: {
    does: "absorb or un-absorb an app as a forge feature, or change its settings",
    asks: (a) => a["absorb"] !== undefined || a["settings"] !== undefined,
    undo: (a) =>
      a["absorb"] === true
        ? "`features` with `absorb: false` puts it back; its settings are kept"
        : a["absorb"] === false
          ? "`features` with `absorb: true` absorbs it again, with its settings"
          : "`features` with the old values sets them back",
  },
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
  // Reach and trust: who may see, enter, deploy, stop or be linked to (#8230).
  land_past_gate: { does: "land a pull past a broken gate" },
  share: { does: "share a feed item with followers or the app's crew" },
  invites: { does: "revoke an invite link", asks: (a) => a["action"] !== "list" },
  egress_grants: { does: "grant or revoke an app's private destination", asks: not("op", "list") },
  sever: { does: "unlink a spawned forge from its parent" },
  parent_unlink: { does: "unlink parent-forge sign-in" },
  quotas: { does: "change an account's quotas" },
  spawn: { does: "spawn a child forge" },
  app_deploy: { does: "redeploy or stop an app's production or preview" },
  stop: { does: "stop a crew run" },
  converge: { does: "have a fork's crew merge the parent's updates" },
  forges: { does: "grant a forge a plan by hand", asks: (a) => a["plan"] !== undefined && a["dryRun"] === false },
  origins: { does: "sync an origin or replace the internal hosts one may live on", asks: not("action", "list", "repos") },
  cloud_account: { does: "change a cloud account" },
  pinned_forge: { does: "deploy, update or roll back a pinned forge on the owner's cloud", asks: not("verb", "list") },
  outsiders: { does: "let non-writers direct an app's crew, or stop them" },
  seal: { does: "seal or unseal an issue or pull" },
  migrate: { does: "bring a repository in from a public address" },
  account_suspend: { does: "suspend an account or lift its suspension" },
  account_role: { does: "make a person a member or a guest" },
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

/**
 * The other list (#9401): ordinary work, undone in a click, that the fence
 * lets go in a repository the person may write once their newest words ask
 * for it or answer the proposal that named it. Nothing on `ASKING` is here
 * (test/conversation-holds.test.ts): that list always asks. A write on
 * neither must be named whole (`core/fence.ts`, `named`) or is held.
 */
export const UNDOABLE: Readonly<Record<string, Work & { readonly only?: (args: Args) => boolean }>> = {
  // A sentence that becomes an issue.
  tell: {
    ask: [
      /(?<![a-z0-9])(open|file|create|make|raise|log|start|write|add|put)\s+(\S+\s+){0,4}?(issue|ticket)(?![a-z0-9])/g,
      /(?<![a-z0-9])(tell|ask|have)\s+(the\s+)?crew(?![a-z0-9])/g,
    ],
    composed: new Set(["text", "from", "context"]),
  },
  // A comment on an issue or a pull.
  say: {
    ask: [
      /(?<![a-z0-9])(comment|reply|respond)\s+(on|to|in|under|back)(?![a-z0-9])/g,
      /(?<![a-z0-9])(leave|post|add|write|drop)\s+(\S+\s+){0,3}?(comment|note|reply)(?![a-z0-9])/g,
      /(?<![a-z0-9])say\s/g,
    ],
    composed: new Set(["text"]),
    only: (a) => a["repo"] !== undefined && a["number"] !== undefined,
  },
  branches: {
    ask: [/(?<![a-z0-9])(create|make|open|start|cut|add)\s+(\S+\s+){0,3}?branch(?![a-z0-9])/g],
    composed: new Set(["name", "from", "action", "kind"]),
    only: (a) => a["action"] === "create",
  },
  labels: {
    ask: [
      /(?<![a-z0-9])(label|tag)\s+(#?\d|it|that|this|them|the|issue|pull)/g,
      /(?<![a-z0-9])(add|set|put|apply)\s+(\S+\s+){0,3}?labels?(?![a-z0-9])/g,
    ],
    composed: new Set(["action"]),
  },
  assign: {
    ask: [/(?<![a-z0-9])(re)?assign(?![a-z0-9])/g, /(?<![a-z0-9])(give|hand)\s+(\S+\s+){0,3}?to(?![a-z0-9])/g],
    composed: new Set(["kind"]),
  },
};

/** The work this call of `tool` is, when it is on the undoable list. */
export function undoableWork(tool: string, args: Args): Work | undefined {
  const work = UNDOABLE[tool];
  return work === undefined || work.only?.(args) === false ? undefined : work;
}

/** Whether this call of `tool` asks first, scope aside. */
export function asksFirst(tool: string, args: Args): boolean {
  const asking = ASKING[tool];
  return asking !== undefined && (asking.asks?.(args) ?? true);
}

/**
 * Argument names whose values are secrets, never repeated in a sentence,
 * turn or the full view: at any depth, any tool. `key` and `value` are not
 * among them, for they are most often what the person must read to say yes
 * (the public key `ssh_keys` grants, the value `limits` sets).
 */
const SECRET = /token|secret|password|credential/i;

/** Top-level `value`s that are secrets, by tool: a sealed secret, an app variable, a cloud token. */
const SECRET_VALUE: ReadonlySet<string> = new Set(["secrets", "app_env", "cloud_account"]);

/** Whether argument `k` of `tool` is a secret; `top` when it is a top-level argument. */
const secretArg = (tool: string, k: string, top: boolean): boolean =>
  SECRET.test(k) || (top && k === "value" && SECRET_VALUE.has(tool));

/** Control, format and line-breaking characters: an argument the agent wrote cannot start a new line or reorder the sentence. */
const UNSAID = /[\p{Cc}\p{Cf}\u2028\u2029]+/gu;

/** A string as said back: on one line, plain, cut to 60. */
const plain = (v: string): string => {
  const one = v.replace(UNSAID, " ").trim();
  return one.length > 60 ? `${one.slice(0, 60)}…` : one;
};

/** One argument as said back: scalars as written (strings plain, cut to 60), a secret hidden, anything else counted. */
function said(tool: string, k: string, v: unknown): string {
  const name = plain(k);
  if (secretArg(tool, k, true)) return `${name} (hidden)`;
  if (typeof v === "string") return `${name} ${plain(v)}`;
  if (typeof v === "number" || typeof v === "boolean" || v === null) return `${name} ${String(v)}`;
  return Array.isArray(v) ? `${name} (${v.length})` : `${name} (…)`;
}

/** Most keys an object may hold, and how long one key, in a call that asks first. */
const KEYS_MAX = 30;
const KEY_CHARS_MAX = 100;

/** Most characters of arguments a person is asked to approve; more is refused unkept. */
export const ARGS_CHARS_MAX = 8000;

/** Whether the person could not read these arguments whole: too many keys, a long key, or too much text. */
export function tooBigToApprove(args: Args): boolean {
  let over = false;
  const walk = (v: unknown, depth: number): void => {
    if (over || v === null || typeof v !== "object") return;
    if (depth > 6) over = true;
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v);
    if (entries.length > KEYS_MAX * 10 || (!Array.isArray(v) && entries.length > KEYS_MAX)) over = true;
    for (const [k, x] of entries) {
      if (k.length > KEY_CHARS_MAX) over = true;
      walk(x, depth + 1);
    }
  };
  walk(args, 0);
  return over || (JSON.stringify(args) ?? "").length > ARGS_CHARS_MAX;
}

/** Control and format characters written out, so what is shown is what runs. */
const escaped = (text: string): string =>
  text.replace(/[^\P{Cc}\n]|[\p{Cf}\u2028\u2029]+/gu, (m) => Array.from(m, (c) => `\\u${c.codePointAt(0)!.toString(16).padStart(4, "0")}`).join(""));

/** Every argument, whole, as the call will run: a secret hidden at any depth, invisible characters written out. */
export function argumentsShown(tool: string, args: Args): string {
  const hide = (v: unknown, top: boolean): unknown => {
    if (Array.isArray(v)) return v.map((x) => hide(x, false));
    if (v === null || typeof v !== "object") return v;
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, secretArg(tool, k, top) ? "(hidden)" : hide(x, false)]),
    );
  };
  return escaped(JSON.stringify(hide(args, true), null, 2) ?? "{}");
}

/** The one sentence the person reads before saying yes. */
export function confirmSentence(tool: string, args: Args): string {
  const does = ASKING[tool]?.does ?? `call \`${tool}\``;
  const given = Object.entries(args)
    .filter(([k]) => k !== "dryRun")
    .map(([k, v]) => said(tool, k, v));
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
