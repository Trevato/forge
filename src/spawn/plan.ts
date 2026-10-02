/**
 * planSpawn: what a child forge is made of, as one validated value. Pure —
 * plain data in, plain data out, nothing read or written. The caller hands
 * in the viewer's catalogue (what they may read) and the parent's briefs and
 * subscription names; the plan copies only fields it names, so a secret
 * sitting on any input object cannot reach the plan. The same input always
 * gives the same plan: lists are sorted and nothing reads a clock.
 */

import { err, ok, type Result } from "../kernel/result.ts";

export const MAX_APPS = 50;
export const MAX_BRIEFS = 100;
export const MAX_SUBSCRIPTIONS = 200;
export const MAX_BRIEF_CHARS = 20_000;

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
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

export interface SpawnPlan {
  readonly name: string;
  readonly org: string;
  readonly apps: readonly PlannedApp[];
  readonly briefs: readonly CrewBrief[];
  readonly subscriptions: readonly string[];
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

  return ok({ name, org, apps, briefs, subscriptions });
}

const enc = new TextEncoder();

/** The studio's preview: what is copied, what stays, and how many bytes. */
export function dryRun(plan: SpawnPlan, source: SpawnSource): DryRun {
  const copied = [
    ...plan.apps.map((a) => `app ${a.ref} (full history, forge.json)`),
    ...plan.briefs.map((b) => `crew brief for ${b.agent}`),
    ...plan.subscriptions.map((s) => `subscription ${s} (name only)`),
  ];
  const bytes =
    plan.apps.reduce((n, a) => n + a.bytes, 0) +
    plan.briefs.reduce((n, b) => n + enc.encode(b.text).length, 0) +
    plan.subscriptions.reduce((n, s) => n + enc.encode(s).length, 0);
  return { copied, leftBehind: LEFT_BEHIND, bytes };
}
