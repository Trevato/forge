/** What a maintenance duty is (#11204): a name, an interval and a handler; plain data in, plain data out. */

import type { Database } from "bun:sqlite";
import type { EventBus } from "../core/events.ts";
import type { App } from "../app.ts";

/** The number a finding rests on and when it was read: a query's result or a measurement. */
export interface Probe {
  readonly kind: "query" | "measurement";
  /** The SQL, or what was measured. */
  readonly what: string;
  readonly number: number;
  /** ISO time the number was read. */
  readonly at: string;
}

export interface Finding {
  readonly summary: string;
  readonly probe?: Probe | undefined;
}

export interface DutyResult {
  readonly findings: readonly Finding[];
  /** What the duty did about it, one line each. */
  readonly actions: readonly string[];
}

export interface DutyContext {
  readonly db: Database;
  /** The forge's event bus, for a duty that files an issue. */
  readonly bus: EventBus;
  readonly now: Date;
  /** The running app, for a duty that files or comments through the same actions a person uses. */
  readonly app?: App | undefined;
}

export interface Duty {
  /** Lowercase words and dashes; the row's `duty`. */
  readonly name: string;
  readonly intervalMs: number;
  readonly run: (ctx: DutyContext) => DutyResult | Promise<DutyResult>;
}

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_TEXT = 500;

export const validName = (name: string): boolean => NAME.test(name);

/** Why a probe is no probe, or undefined when it is one. */
export function probeFault(p: Probe | undefined): string | undefined {
  if (p === undefined || p === null) return "no probe";
  if (p.kind !== "query" && p.kind !== "measurement") return "probe kind is neither query nor measurement";
  if (typeof p.what !== "string" || p.what.trim() === "") return "probe says nothing of what was read";
  if (typeof p.number !== "number" || !Number.isFinite(p.number)) return "probe has no number";
  if (typeof p.at !== "string" || Number.isNaN(Date.parse(p.at))) return "probe has no time";
  return undefined;
}

/** The first finding refused, as a sentence; undefined when every finding stands on a probe. */
export function refusal(findings: readonly Finding[]): string | undefined {
  for (const f of findings) {
    if (typeof f?.summary !== "string" || f.summary.trim() === "") return "refused: a finding says nothing";
    const fault = probeFault(f.probe);
    if (fault !== undefined) return `refused: finding "${f.summary.slice(0, 80)}" has ${fault}`;
  }
  return undefined;
}

export const clip = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);
