import { flagRegistry, mayManageFlags } from "../../../core/flags.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "flags",
  doc: "no input: every declared flag with why it exists, its default, the issue that owns removing it and its live value (`null` when unset); read-only, a forge admin's and never an agent's; setting stays on `/settings/flags`",
  description: "Declared flags: why, default, owner issue, live value.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  run(_ctx, user) {
    if (!mayManageFlags(user)) return bad("forbidden", "Flags are set by a forge admin.");
    const flags = flagRegistry()
      .entries()
      .map(({ name, decl, value }) => ({
        name,
        why: decl.why,
        default: decl.default,
        issue: decl.issue,
        live: value ?? null,
      }));
    return good({ flags });
  },
};
