/**
 * The flags a forge admin sees (#7017): every declared flag as plain data —
 * name, why, default, the issue that owns removing it, and the live value.
 * One read for the page and the MCP to share; anyone `mayManageFlags` refuses
 * gets the same refusal the page uses.
 */

import { FLAGS_ADMIN_ONLY, flagRegistry, mayManageFlags, type FlagDecl, type FlagValue } from "../core/flags.ts";
import type { User } from "../core/users.ts";

export type FlagRow = {
  name: string;
  why: string;
  default: boolean;
  issue: number;
  /** The stored value; `undefined` when nothing is set and the default answers. */
  value: FlagValue | undefined;
};

export function readFlags(
  user: Pick<User, "isAdmin" | "kind"> | undefined,
): { ok: true; flags: FlagRow[] } | { ok: false; message: string } {
  if (!mayManageFlags(user)) return { ok: false, message: FLAGS_ADMIN_ONLY };
  const registry = flagRegistry();
  const decls: Record<string, FlagDecl> = registry.decls;
  const flags = Object.entries(decls).map(([name, d]) => ({
    name,
    why: d.why,
    default: d.default,
    issue: d.issue,
    value: registry.value(name),
  }));
  return { ok: true, flags };
}
