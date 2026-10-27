import { checkInput, flagRegistry, mayManageFlags } from "../../../core/flags.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "flag_set",
  doc: "`{ name, value?, clear? }`: set a declared flag's live value (`value` is `{ forge?, users?, roles?, percent? }`) or `clear` it to its default, with the Flags page's checks and refusals; a forge admin's (never an agent), an admin token; answers `{ name, value, says }`",
  description: "Set or clear a flag (admin).",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      value: { type: "object" },
      clear: { type: "boolean" },
    },
    required: ["name"],
  },
  writes: true,
  run(ctx, user, args) {
    if (!mayManageFlags(user)) return bad("forbidden", "Flags are set by a forge admin.");
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "setting a flag needs an admin token");
    const { name, value, clear } = args;
    const shape = "value is { forge?: boolean, users?: string[], roles?: string[], percent?: number }";
    if (typeof name !== "string" || (clear !== undefined && typeof clear !== "boolean"))
      return bad("invalid", "send a flag name, and value or clear");
    if (clear !== true && (typeof value !== "object" || value === null || Array.isArray(value)))
      return bad("invalid", "send a value object, or clear: true");
    const o = (clear === true ? {} : value) as Record<string, unknown>;
    const words = (x: unknown): string[] | undefined =>
      x === undefined
        ? []
        : Array.isArray(x) && x.every((w) => typeof w === "string" && !/[\s,]/.test(w))
          ? x
          : undefined;
    const users = words(o["users"]);
    const roles = words(o["roles"]);
    if (
      Object.keys(o).some((k) => !["forge", "users", "roles", "percent"].includes(k)) ||
      !(o["forge"] === undefined || typeof o["forge"] === "boolean") ||
      !(o["percent"] === undefined || typeof o["percent"] === "number") ||
      !users ||
      !roles
    )
      return bad("invalid", shape);
    const checked =
      clear === true
        ? ({ ok: true, value: undefined } as const)
        : checkInput({
            forge: o["forge"] === undefined ? "" : o["forge"] ? "on" : "off",
            users: users.join(","),
            roles: roles.join(","),
            percent: o["percent"] === undefined ? "" : String(o["percent"]),
          });
    if (!checked.ok) return bad("invalid", checked.message);
    const registry = flagRegistry();
    if (!registry.set(ctx.app.db, name, checked.value, user.id))
      return bad("not_found", "There is no such flag.");
    return good({
      name,
      value: registry.value(name as never) ?? null,
      says: `${name}: ${checked.value === undefined ? "cleared" : "saved"}.`,
    });
  },
};
