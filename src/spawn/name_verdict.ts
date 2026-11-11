/**
 * Whether the home page's Start my forge would take a name: free, taken,
 * invalid (not a name's shape) or reserved (one of the forge's own words).
 * One answer for `GET /forges/name/<name>` and for `spawnDoor`, so "free" is
 * never a lie. Plain data in, plain data out.
 */
import { isSystemName } from "../core/reserved.ts";
import { NAME } from "./plan.ts";

export type NameVerdict = {
  readonly verdict: "free" | "taken" | "invalid" | "reserved";
  readonly why: string;
};

/** What the name alone says: invalid or reserved, or undefined when it passes both. */
export function nameShapeVerdict(name: string): NameVerdict | undefined {
  if (!NAME.test(name))
    return { verdict: "invalid", why: 'name must be 1-39 characters of a-z, 0-9 and "-", not starting or ending with "-"' };
  if (isSystemName(name)) return { verdict: "reserved", why: `${name} is one of the forge's own words` };
  return undefined;
}

/** The verdict for `name`; `exists` says whether a child of that name is in the ledger or being made. */
export function nameVerdict(name: string, exists: boolean): NameVerdict {
  const shape = nameShapeVerdict(name);
  if (shape !== undefined) return shape;
  if (exists) return { verdict: "taken", why: `a forge named ${name} already exists` };
  return { verdict: "free", why: `${name} is free` };
}
