/**
 * planSpawn: what a child forge is made of, as one validated value. Pure —
 * plain data in, plain data out, nothing read or written. The caller hands
 * in the viewer's catalogue (what they may read) and the parent's briefs and
 * subscription names; the plan copies only fields it names, so a secret
 * sitting on any input object cannot reach the plan. The same input always
 * gives the same plan: lists are sorted and nothing reads a clock.
 */

import { err, ok, type Result } from "../kernel/result.ts";
import { DEFAULT_MODE, type FollowMode } from "./chain.ts";
import { parseSize, type Size } from "./sizes.ts";
import { DEFAULT_TEMPLATE, parseTemplate } from "./templates.ts";

export const MAX_APPS = 50;
export const MAX_BRIEFS = 100;
export const MAX_SUBSCRIPTIONS = 200;
export const MAX_BRIEF_CHARS = 20_000;
/** The spawner's words for what the child is for: its direction. */
export const MAX_DIRECTION_CHARS = 2000;
/** Whom a child is for (a person, a client, an organisation): kept in the parent's ledger only. */
export const MAX_FOR_CHARS = 200;
/** The whole-life budget on a child's model key, in dollars. */
export const MIN_BUDGET_USD = 1;
/**
 * What a key's budget is, said plainly wherever a key is handed over: the
 * forge enforces it for a child it hosts (whose admin has no shell or
 * database), and only the provider's own limit binds a child on a machine
 * its owner controls.
 */
export const KEY_BUDGET_NOTE =
  "The budget holds while this forge hosts the child: its admin cannot raise it. On a machine the child's owner controls, only a spend limit set at the provider binds the key, so use a key from a workspace with its own spend limit.";
export const MAX_BUDGET_USD = 1000;

/** One line saying what a fresh app is. */
export const MAX_FRESH_CHARS = 200;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const PLAN_KEY = /^[a-z][a-z0-9-]{0,19}$/;
const APP_REF = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** An app the viewer can see, as the caller found it. */
export interface CatalogApp {
  readonly ref: string; // "owner/name"
  readonly readable: boolean;
  readonly bytes: number; // size of the repository with full history
  readonly forgeJsonBytes: number;
}

export interface CrewBrief {
  readonly agent: string;
  readonly text: string;
}

export interface SpawnInput {
  readonly name: unknown;
  readonly org: unknown;
  readonly apps: unknown;
  readonly carryBriefs: unknown;
  readonly carrySubscriptions: unknown;
  /** What the child is for, in the spawner's words; optional. */
  readonly direction?: unknown;
  /** Whether the spawner keeps owner access once the child is claimed; false unless true. */
  readonly keepAccess?: unknown;
  /** Whom the child is for, in the spawner's words; optional, never copied into the child. */
  readonly for?: unknown;
  /**
   * The whole-life budget on the child's model key, in dollars, when one is given.
   * The key itself never enters the plan: only that there is one, capped.
   */
  readonly budgetUsd?: unknown;
  /** One line describing a fresh app to start in the child, beside the forked ones; optional. */
  readonly fresh?: unknown;
  /** How the child follows the forge's code: `take-updates` (default) or `tell-me`. */
  readonly followMode?: unknown;
  /** How big the child is: `small`, `medium` or `large`; optional. */
  readonly size?: unknown;
  /** Which template the child's apps start from (`spawn/templates.ts`); optional. */
  readonly template?: unknown;
  /** The plan (`settings/plans.ts`) the child is on; optional. The door has already set `size` from it. */
  readonly plan?: unknown;
}

/** What the parent has to offer. Extra fields are ignored, never copied. */
export interface SpawnSource {
  readonly catalog: readonly CatalogApp[];
  readonly briefs: readonly CrewBrief[];
  readonly subscriptions: readonly string[];
}

export interface PlannedApp {
  readonly ref: string;
  readonly history: "full";
  readonly forgeJson: true;
  readonly bytes: number;
}

/** An app begun from a sentence, not forked from anything. */
export interface PlannedFresh {
  readonly name: string;
  readonly description: string;
}

export interface SpawnPlan {
  readonly name: string;
  readonly org: string;
  readonly apps: readonly PlannedApp[];
  readonly briefs: readonly CrewBrief[];
  readonly subscriptions: readonly string[];
  /** The child's direction; empty when the spawner wrote none. */
  readonly direction: string;
  /** Whether the spawner stays an owner after the claim; the claim page says which. */
  readonly keepAccess: boolean;
  /** The child's model key's whole-life budget in dollars; null when it gets no key. */
  readonly budgetUsd: number | null;
  /** Whom the child is for, for the parent's client list; absent when unsaid. */
  readonly forWhom?: string;
  /** A fresh app, present only when asked for. */
  readonly fresh?: PlannedFresh;
  /** How the child follows its parent's forge code; absent means `take-updates`. */
  readonly followMode?: FollowMode;
  /** The child's size, present only when chosen. */
  readonly size?: Size;
  /** The template the child starts from, present only when chosen and not `blank`. */
  readonly template?: string;
  /** The key of the plan the child is on, present only when one was chosen; its credit is read when the child is made. */
  readonly plan?: string;
}

export interface DryRun {
  readonly copied: readonly string[];
  readonly leftBehind: readonly string[];
  readonly bytes: number;
}

export type Refusal = { readonly field: string; readonly reason: string };

/** Never copied, whatever the input says. */
export const LEFT_BEHIND: readonly string[] = [
  "secrets",
  "tokens",
  "SSH keys",
  "agent credentials",
  "run ledger",
  "issues",
  "user accounts",
];

const refuse = (field: string, reason: string) => err<Refusal>({ field, reason });
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The repository name a sentence earns: its first words as a slug, never one of `taken`. */
export function freshName(description: string, taken: ReadonlySet<string>): string {
  let slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 30)
    .replace(/-+$/, "");
  if (slug === "") slug = "app";
  let name = slug;
  for (let i = 2; taken.has(name); i++) name = `${slug}-${i}`;
  return name;
}

export function planSpawn(
  input: SpawnInput,
  source: SpawnSource,
): Result<SpawnPlan, Refusal> {
  for (const field of ["name", "org"] as const) {
    const v = input[field];
    if (typeof v !== "string" || !NAME.test(v)) {
      return refuse(field, `${field} must be 1-39 characters of a-z, 0-9 and "-", not starting or ending with "-"`);
    }
  }
  const name = input.name as string;
  const org = input.org as string;

  if (!Array.isArray(input.apps)) return refuse("apps", "apps must be a list");
  if (input.apps.length > MAX_APPS) return refuse("apps", `at most ${MAX_APPS} apps`);
  if (typeof input.carryBriefs !== "boolean") return refuse("carryBriefs", "must be true or false");
  if (typeof input.carrySubscriptions !== "boolean") return refuse("carrySubscriptions", "must be true or false");

  const known = new Map(source.catalog.map((a) => [a.ref, a] as const));
  const seen = new Set<string>();
  const apps: PlannedApp[] = [];
  for (const ref of input.apps as unknown[]) {
    if (typeof ref !== "string" || !APP_REF.test(ref)) {
      return refuse("apps", "an app reference must look like owner/name");
    }
    if (seen.has(ref)) return refuse("apps", `${ref} is listed twice`);
    seen.add(ref);
    const app = known.get(ref);
    if (!app) return refuse("apps", `${ref} is not a known app`);
    if (!app.readable) return refuse("apps", `${ref} is not readable by you`);
    const bytes = Number.isFinite(app.bytes) && app.bytes >= 0 ? Math.floor(app.bytes) : 0;
    apps.push({ ref, history: "full", forgeJson: true, bytes });
  }
  apps.sort((a, b) => byText(a.ref, b.ref));

  let briefs: CrewBrief[] = [];
  if (input.carryBriefs) {
    if (source.briefs.length > MAX_BRIEFS) return refuse("briefs", `at most ${MAX_BRIEFS} briefs`);
    for (const b of source.briefs) {
      if (typeof b.agent !== "string" || typeof b.text !== "string") return refuse("briefs", "a brief is an agent and text");
      if (b.text.length > MAX_BRIEF_CHARS) return refuse("briefs", `a brief is at most ${MAX_BRIEF_CHARS} characters`);
    }
    briefs = source.briefs
      .map((b) => ({ agent: b.agent, text: b.text }))
      .sort((a, b) => byText(a.agent, b.agent) || byText(a.text, b.text));
  }

  let subscriptions: string[] = [];
  if (input.carrySubscriptions) {
    if (source.subscriptions.length > MAX_SUBSCRIPTIONS) return refuse("subscriptions", `at most ${MAX_SUBSCRIPTIONS} subscriptions`);
    if (source.subscriptions.some((s) => typeof s !== "string")) return refuse("subscriptions", "subscriptions are names");
    subscriptions = [...new Set(source.subscriptions)].sort(byText);
  }

  let direction = "";
  if (input.direction !== undefined) {
    if (typeof input.direction !== "string") return refuse("direction", "must be text");
    direction = input.direction.trim();
    if (direction.length > MAX_DIRECTION_CHARS)
      return refuse("direction", `at most ${MAX_DIRECTION_CHARS} characters`);
  }

  if (input.keepAccess !== undefined && typeof input.keepAccess !== "boolean")
    return refuse("keepAccess", "must be true or false");
  const keepAccess = input.keepAccess === true;

  let budgetUsd: number | null = null;
  if (input.budgetUsd !== undefined && input.budgetUsd !== null) {
    const cap = input.budgetUsd;
    if (typeof cap !== "number" || !Number.isFinite(cap) || cap < MIN_BUDGET_USD || cap > MAX_BUDGET_USD)
      return refuse("budgetUsd", `a budget from $${MIN_BUDGET_USD} to $${MAX_BUDGET_USD}, for the key's whole life`);
    budgetUsd = Math.round(cap * 100) / 100;
  }

  let forWhom = "";
  if (input.for !== undefined && input.for !== null) {
    if (typeof input.for !== "string") return refuse("for", "must be text");
    forWhom = input.for.trim();
    if (forWhom.length > MAX_FOR_CHARS) return refuse("for", `at most ${MAX_FOR_CHARS} characters`);
  }

  let fresh: PlannedFresh | undefined;
  if (input.fresh !== undefined && input.fresh !== null && input.fresh !== "") {
    if (typeof input.fresh !== "string") return refuse("fresh", "must be text");
    const description = input.fresh.trim();
    if (description === "") return refuse("fresh", "say in one line what the app is");
    if (description.length > MAX_FRESH_CHARS) return refuse("fresh", `at most ${MAX_FRESH_CHARS} characters`);
    if (/[\u0000-\u001f\u007f]/.test(description)) return refuse("fresh", "must be one line");
    // `forge` is the fixed name of the forge-code fork, so a fresh app never takes it.
    fresh = {
      name: freshName(description, new Set(["forge", ...apps.map((a) => a.ref.split("/")[1]!.toLowerCase())])),
      description,
    };
  }

  let followMode: FollowMode | undefined;
  if (input.followMode !== undefined && input.followMode !== null && input.followMode !== "") {
    if (input.followMode !== "tell-me" && input.followMode !== "take-updates")
      return refuse("followMode", "must be tell-me or take-updates");
    // Only a chosen mode is named, so a plan without one hashes as it always did.
    if (input.followMode !== DEFAULT_MODE) followMode = input.followMode;
  }

  // Checked last, so every older field's refusal comes first.
  let size: Size | undefined;
  if (input.size !== undefined && input.size !== null && input.size !== "") {
    const parsed = parseSize(input.size);
    if (!parsed.ok) return refuse("size", parsed.error);
    size = parsed.value;
  }

  // After size, for the same reason; `blank` is today's child, so it is never named.
  let template: string | undefined;
  if (input.template !== undefined && input.template !== null && input.template !== "") {
    const parsed = parseTemplate(input.template);
    if (!parsed.ok) return refuse("template", parsed.error);
    if (parsed.value !== DEFAULT_TEMPLATE) template = parsed.value;
  }

  // Last of all, so every older field's refusal comes first.
  let plan: string | undefined;
  if (input.plan !== undefined && input.plan !== null && input.plan !== "") {
    if (typeof input.plan !== "string" || !PLAN_KEY.test(input.plan)) return refuse("plan", "a plan key is 1-20 characters of a-z, 0-9 and \"-\"");
    plan = input.plan;
  }

  // `forWhom` only when said, so a plan without it hashes as it always did.
  return ok({
    name,
    org,
    apps,
    briefs,
    subscriptions,
    direction,
    keepAccess,
    budgetUsd,
    ...(forWhom === "" ? {} : { forWhom }),
    ...(fresh === undefined ? {} : { fresh }),
    ...(followMode === undefined ? {} : { followMode }),
    ...(size === undefined ? {} : { size }),
    ...(template === undefined ? {} : { template }),
    ...(plan === undefined ? {} : { plan }),
  });
}

const enc = new TextEncoder();

/** The studio's preview: what is copied, what stays, and how many bytes. */
export function dryRun(plan: SpawnPlan, source: SpawnSource): DryRun {
  const copied = [
    ...plan.apps.map((a) => `app ${a.ref} (full history, forge.json)`),
    ...(plan.fresh === undefined
      ? []
      : [`a fresh app ${plan.fresh.name}: ${plan.fresh.description}`]),
    ...plan.briefs.map((b) => `crew brief for ${b.agent}`),
    ...plan.subscriptions.map((s) => `subscription ${s} (name only)`),
    ...(plan.direction === "" ? [] : ["your words, as the child's direction"]),
    ...(plan.keepAccess ? ["your owner access, kept after the forge is taken over"] : []),
    ...(plan.budgetUsd === null
      ? []
      : [`its own model key (sealed, never shown again), with a $${plan.budgetUsd} budget it cannot raise`]),
  ];
  const bytes =
    plan.apps.reduce((n, a) => n + a.bytes, 0) +
    plan.briefs.reduce((n, b) => n + enc.encode(b.text).length, 0) +
    plan.subscriptions.reduce((n, s) => n + enc.encode(s).length, 0);
  return { copied, leftBehind: LEFT_BEHIND, bytes };
}
