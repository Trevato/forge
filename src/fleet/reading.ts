/**
 * What a typed value means to a verb, for the doors that take text (the web
 * form, the terminal prompt): nothing, a flag, a number, or the text itself,
 * whichever the verb accepts first.
 */

import type { App } from "../app.ts";
import type { FleetValue } from "../core/fleet_ops.ts";
import { VERBS } from "./verbs.ts";

/** The readings of a text, most specific first. */
export function valuesOf(text: string): FleetValue[] {
  const t = text.trim();
  if (t === "") return [null];
  const out: FleetValue[] = [];
  if (t === "true" || t === "false") out.push(t === "true");
  else if (/^-?\d+(\.\d+)?$/.test(t)) out.push(Number(t));
  out.push(t);
  return out;
}

/** The action for a verb and a text: the first reading the verb accepts. */
export function actionOf(app: App, verb: string, text: string): { verb: string; value: FleetValue } {
  const known = Object.hasOwn(VERBS, verb) ? VERBS[verb] : undefined;
  const options = valuesOf(text);
  const value =
    known === undefined
      ? options[0]!
      : (options.find((v) => known.parse(app, v).ok) ?? options[0]!);
  return { verb, value: value ?? null };
}
