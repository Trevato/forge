import { readFlags } from "../../../actions/flags_view.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "flags",
  doc: "no input: every declared flag with why it exists, its default, the issue that owns removing it and its live `value` (absent when unset), as `readFlags` answers; read-only, a forge admin's and never an agent's; setting is `flag_set`",
  description: "Declared flags: why, default, owner issue, live value.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  run(_ctx, user) {
    const out = readFlags(user);
    return out.ok ? good({ flags: out.flags }) : bad("forbidden", out.message);
  },
};
