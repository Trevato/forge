/**
 * A business, described in words, as a map of what to build (#439): Atlas
 * answers a description with one value — the apps (one per capability), the
 * adapters (one per external system) and what waits for what — and this
 * module checks that value, shows it as the issues it would open, and opens
 * them through the planner's own path (`actions/plan.ts`), all or nothing.
 *
 * A plan, not code: nothing here runs a model or assigns anyone. The issues
 * open unassigned; a person picks who builds them. The same value can seed a
 * spawn plan (`spawn/plan.ts`), so the business can ship as its own forge.
 *
 * Every plan carries a stamp (a hash of its canonical form) in each issue it
 * opens, so confirming the same plan twice answers with the issues the first
 * confirm opened and opens nothing more.
 */

import { createHash } from "node:crypto";
import type { App } from "../app.ts";
import { MAX_TITLE, getIssue } from "../core/issues.ts";
import { isCrew } from "../core/agents.ts";
import { canRead, canWrite, type Repo } from "../core/repos.ts";
import { findPillar, pillarsOf } from "../core/pillars.ts";
import { transact } from "../kernel/db.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { MAX_DIRECTION_CHARS, MAX_FRESH_CHARS } from "../spawn/plan.ts";
import { openPlan, PLAN_MAX, proposePlan, type PlanItem, type Planned, type Proposed } from "./plan.ts";

/** The description, in words: long enough for a business, short enough to read. */
export const DESCRIPTION_MAX = 4_000;
/** One sentence for what an app is for, or what data an adapter moves. */
export const LINE_MAX = 300;
/** Apps and adapters together open one issue each: no more than one plan holds. */
export const PARTS_MAX = PLAN_MAX;
export const EDGES_MAX = 60;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const SYSTEM_MAX = 60;

export interface BusinessApp {
  readonly slug: string;
  readonly purpose: string;
}

export interface BusinessAdapter {
  /** The external system, by name ("Stripe", "the shop's POS"). */
  readonly system: string;
  /** What data it moves, in one sentence. */
  readonly data: string;
}

/** `from` waits for `waitsFor`; both name an app slug or an adapter system. */
export interface BusinessEdge {
  readonly from: string;
  readonly waitsFor: string;
}

export interface BusinessPlan {
  readonly description: string;
  readonly apps: readonly BusinessApp[];
  readonly adapters: readonly BusinessAdapter[];
  readonly edges: readonly BusinessEdge[];
}

export interface BusinessRefusal {
  readonly error: string;
  readonly message: string;
}

const refuse = (error: string, message: string) => err<BusinessRefusal>({ error, message });

/** One line of text, trimmed and with its runs of space folded, or why not. */
function line(raw: unknown, at: string, max: number): Result<string, BusinessRefusal> {
  if (typeof raw !== "string") return refuse("invalid", `${at} must be text`);
  const text = raw.trim().replace(/\s+/g, " ");
  if (text === "") return refuse("invalid", `${at} is empty`);
  if (text.length > max) return refuse("too_long", `${at} is over ${max} characters`);
  return ok(text);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** The value Atlas answered with, checked into a plan, or the first thing wrong with it. */
export function parseBusinessPlan(raw: unknown): Result<BusinessPlan, BusinessRefusal> {
  if (!isObject(raw)) return refuse("invalid", "plan must be an object");
  const d = raw["description"];
  if (typeof d !== "string" || d.trim() === "") return refuse("invalid", "description is the business, in words");
  const description = d.trim();
  if (description.length > DESCRIPTION_MAX)
    return refuse("too_long", `description is over ${DESCRIPTION_MAX} characters`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(description))
    return refuse("invalid", "description holds control characters");

  const rawApps = raw["apps"] ?? [];
  const rawAdapters = raw["adapters"] ?? [];
  const rawEdges = raw["edges"] ?? [];
  if (!Array.isArray(rawApps)) return refuse("invalid", "apps must be a list");
  if (!Array.isArray(rawAdapters)) return refuse("invalid", "adapters must be a list");
  if (!Array.isArray(rawEdges)) return refuse("invalid", "edges must be a list");
  const parts = rawApps.length + rawAdapters.length;
  if (parts === 0) return refuse("invalid", "a plan names at least one app or adapter");
  if (parts > PARTS_MAX) return refuse("too_many", `a plan is at most ${PARTS_MAX} apps and adapters together`);
  if (rawEdges.length > EDGES_MAX) return refuse("too_many", `a plan is at most ${EDGES_MAX} edges`);

  // Names are one space: an edge says which part it means without saying which kind.
  const names = new Set<string>();
  const apps: BusinessApp[] = [];
  for (const [i, a] of rawApps.entries()) {
    const at = `apps[${i}]`;
    if (!isObject(a)) return refuse("invalid", `${at} must be an object`);
    const slug = a["slug"];
    if (typeof slug !== "string" || !SLUG.test(slug))
      return refuse("invalid", `${at}: slug is 1-39 characters of a-z, 0-9 and "-"`);
    if (names.has(slug.toLowerCase())) return refuse("duplicate", `${at}: "${slug}" is named twice`);
    names.add(slug.toLowerCase());
    const purpose = line(a["purpose"], `${at}: purpose`, LINE_MAX);
    if (!purpose.ok) return purpose;
    apps.push({ slug, purpose: purpose.value });
  }
  const adapters: BusinessAdapter[] = [];
  for (const [i, a] of rawAdapters.entries()) {
    const at = `adapters[${i}]`;
    if (!isObject(a)) return refuse("invalid", `${at} must be an object`);
    const system = line(a["system"], `${at}: system`, SYSTEM_MAX);
    if (!system.ok) return system;
    const key = system.value.toLowerCase();
    if (names.has(key)) return refuse("duplicate", `${at}: "${system.value}" is named twice`);
    names.add(key);
    const data = line(a["data"], `${at}: data`, LINE_MAX);
    if (!data.ok) return data;
    adapters.push({ system: system.value, data: data.value });
  }

  const edges: BusinessEdge[] = [];
  const seenEdge = new Set<string>();
  for (const [i, e] of rawEdges.entries()) {
    const at = `edges[${i}]`;
    if (!isObject(e)) return refuse("invalid", `${at} must be an object`);
    const from = e["from"];
    const waitsFor = e["waitsFor"];
    if (typeof from !== "string" || typeof waitsFor !== "string")
      return refuse("invalid", `${at}: from and waitsFor name an app or an adapter`);
    for (const n of [from, waitsFor])
      if (!names.has(n.trim().toLowerCase())) return refuse("unknown", `${at}: "${n.slice(0, 60)}" is not in this plan`);
    const f = from.trim().toLowerCase();
    const w = waitsFor.trim().toLowerCase();
    if (f === w) return refuse("cycle", `${at}: "${from.trim()}" cannot wait for itself`);
    if (seenEdge.has(`${f}\n${w}`)) continue;
    seenEdge.add(`${f}\n${w}`);
    edges.push({ from: f, waitsFor: w });
  }
  const loop = loopIn(edges);
  if (loop !== undefined) return refuse("cycle", `"${loop}" is on a loop: nothing on it could be built first`);
  return ok({ description, apps, adapters, edges });
}

/** A name on a loop of `waitsFor`, if the edges hold one. */
function loopIn(edges: readonly BusinessEdge[]): string | undefined {
  const out = new Map<string, string[]>();
  for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.waitsFor]);
  const state = new Map<string, "walking" | "done">();
  const visit = (n: string): string | undefined => {
    if (state.get(n) === "done") return undefined;
    if (state.get(n) === "walking") return n;
    state.set(n, "walking");
    for (const next of out.get(n) ?? []) {
      const hit = visit(next);
      if (hit !== undefined) return hit;
    }
    state.set(n, "done");
    return undefined;
  };
  for (const n of out.keys()) {
    const hit = visit(n);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** The plan's stamp: the same plan, however spaced or ordered on the wire, has one stamp. */
export function stampOf(plan: BusinessPlan): string {
  const canonical = JSON.stringify({
    d: plan.description,
    a: plan.apps.map((a) => [a.slug.toLowerCase(), a.purpose]).sort(),
    x: plan.adapters.map((a) => [a.system.toLowerCase(), a.data]).sort(),
    e: plan.edges.map((e) => [e.from, e.waitsFor]).sort(),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/** The line each opened issue ends with, which a second confirm finds. */
export const stampLine = (stamp: string): string => `Atlas plan \`${stamp}\``;

const titled = (head: string, rest: string): string => {
  const t = `${head} — ${rest}`;
  return t.length <= MAX_TITLE ? t : `${t.slice(0, MAX_TITLE - 1)}…`;
};

/** The plan as the planner's items: an issue per app and per adapter, linked by its edges. */
export function businessItems(plan: BusinessPlan, pillar?: string): PlanItem[] {
  const stamp = stampOf(plan);
  const keyOf = new Map<string, string>();
  plan.apps.forEach((a, i) => keyOf.set(a.slug.toLowerCase(), `app${i + 1}`));
  plan.adapters.forEach((a, i) => keyOf.set(a.system.toLowerCase(), `adapter${i + 1}`));
  const waits = (name: string): string[] =>
    plan.edges.filter((e) => e.from === name).map((e) => keyOf.get(e.waitsFor)!);
  const context = `**The business:** ${plan.description}`;
  const purpose = pillar === undefined ? {} : { pillar };
  return [
    ...plan.apps.map((a) => ({
      key: keyOf.get(a.slug.toLowerCase())!,
      title: titled(`App ${a.slug}`, a.purpose),
      body: `An app for one capability: ${a.purpose}\n\n${context}\n\n${stampLine(stamp)}`,
      blockedBy: waits(a.slug.toLowerCase()),
      ...purpose,
    })),
    ...plan.adapters.map((a) => ({
      key: keyOf.get(a.system.toLowerCase())!,
      title: titled(`Adapter for ${a.system}`, a.data),
      body: `An adapter to ${a.system}, which moves: ${a.data}\n\n${context}\n\n${stampLine(stamp)}`,
      blockedBy: waits(a.system.toLowerCase()),
      ...purpose,
    })),
  ];
}

/**
 * What the plan gives a spawn plan (`spawn/plan.ts`): the description as the
 * child's direction and its first app as the fresh app it starts with. The
 * caller adds the name, the organisation and what to carry.
 */
export function spawnSeed(plan: BusinessPlan): { direction: string; fresh?: string } {
  const clipTo = (t: string, max: number) => (t.length <= max ? t : `${t.slice(0, max - 1)}…`);
  const first = plan.apps[0];
  return {
    direction: clipTo(plan.description, MAX_DIRECTION_CHARS),
    ...(first ? { fresh: clipTo(`${first.slug}: ${first.purpose}`, MAX_FRESH_CHARS) } : {}),
  };
}

/** The largest body either door reads: a description, twelve parts and their edges, with room. */
export const ATLAS_BODY_MAX = 64 * 1024;

/**
 * The issues an earlier confirm of this plan opened here, by number. The
 * stamp line is matched only where `businessItems` puts it, at the very end
 * of the body, so an issue that merely quotes it is not taken for one.
 */
function openedBefore(app: App, repo: Repo, stamp: string): number[] {
  const tail = `\n\n${stampLine(stamp)}`;
  const rows = app.db
    .query<{ number: number }, [string, string]>(
      `SELECT number FROM issue
        WHERE repo_id = ?1 AND length(body) >= length(?2) AND substr(body, -length(?2)) = ?2
        ORDER BY number`,
    )
    .all(repo.id, tail);
  return rows.map((r) => r.number).filter((n) => getIssue(app.db, repo.id, n)?.kind === "issue");
}

/** A proposal of this plan still waiting for its nod here, if one is. */
function pendingProposal(app: App, repo: Repo, stamp: string): string | undefined {
  // Each item's body, as JSON keeps it, ends with the stamp line and its quote.
  const tail = `\\n\\n${stampLine(stamp)}"`;
  return (
    app.db
      .query<{ id: string }, [string, string]>(
        `SELECT id FROM plan_proposal WHERE repo_id = ?1 AND state = 'pending' AND instr(issues, ?2) > 0
          ORDER BY created_at LIMIT 1`,
      )
      .get(repo.id, tail)?.id ?? undefined
  );
}

/**
 * The pillar a plan says it serves, checked against this repository's
 * pillars: absent is fine, anything else must name one of them.
 */
export function checkPillar(app: App, repo: Repo, pillar: unknown): Result<string | undefined, BusinessRefusal> {
  if (pillar === undefined) return ok(undefined);
  if (typeof pillar !== "string" || pillar.trim() === "" || pillar.length > 100)
    return refuse("invalid", "pillar is the name of a pillar");
  const { pillars } = pillarsOf(app.db, repo);
  const found = findPillar(pillars, pillar);
  if (found === undefined)
    return refuse(
      "unknown_pillar",
      pillars.length === 0
        ? "this repository has no pillars to serve"
        : `"${pillar.trim()}" is not a pillar here; they are ${pillars.map((p) => p.short).join(", ")}`,
    );
  return ok(found.short);
}

export type Confirmed =
  | ({ readonly status: "opened"; readonly stamp: string } & Planned)
  | { readonly status: "already"; readonly stamp: string; readonly numbers: number[] }
  | { readonly status: "already-proposed"; readonly stamp: string; readonly id: string }
  | ({ readonly stamp: string } & Proposed);

/**
 * Confirming: the plan's issues and links, opened through `openPlan` (or kept
 * as a proposal where plans need a nod). A plan already confirmed here opens
 * (or proposes) nothing and says what the earlier confirm made. The look for
 * an earlier confirm and the opening run in one write transaction, so two
 * confirms at once — even from two processes on the same data — open once.
 */
export function confirmBusinessPlan(
  app: App,
  actor: User | undefined,
  repo: Repo,
  plan: BusinessPlan,
  pillar?: string,
): Result<Confirmed, BusinessRefusal> {
  const stamp = stampOf(plan);
  const items = businessItems(plan, pillar);
  // Only someone who may open the plan learns what an earlier confirm opened.
  if (!actor || !canRead(app.db, repo, actor))
    return refuse("not_found", "no such app or repository (owner/name)");
  if (!canWrite(app.db, repo, actor) && !isCrew(app.db, repo.id, actor.id))
    return refuse("forbidden", "you need write access to plan here");
  return transact(app.db, (): Result<Confirmed, BusinessRefusal> => {
    const before = openedBefore(app, repo, stamp);
    if (before.length > 0) return ok({ status: "already", stamp, numbers: before });
    if (repo.plansNeedNod) {
      const waiting = pendingProposal(app, repo, stamp);
      if (waiting !== undefined) return ok({ status: "already-proposed", stamp, id: waiting });
      const proposed = proposePlan(app, actor, repo, items, {
        title: "Atlas: a map of apps and adapters",
        why: plan.description,
      });
      return proposed.ok ? ok({ ...proposed.value, stamp }) : proposed;
    }
    const planned = openPlan(app, actor, repo, items);
    return planned.ok ? ok({ status: "opened", stamp, ...planned.value }) : planned;
  });
}
