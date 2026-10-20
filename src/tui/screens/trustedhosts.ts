/**
 * Trusted internal hosts in the terminal, a forge admin's: the list Settings →
 * Origins edits, read and saved through the page's own `updateTrustedHosts`,
 * so a save is audited and live at once. Anyone else is not offered it.
 */

import { editableHosts, envHosts, mayEditTrustedHosts, rejectedSentence, updateTrustedHosts } from "../../origins/trusted-hosts.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Session } from "../session.ts";
import { promptScreen } from "./common.ts";

export function trustedHostsPrompt(f: Session, ctx: Ctx, parent: Screen): Screen {
  const fixed = envHosts();
  return promptScreen(ctx, parent, {
    title: "Trusted internal hosts",
    label: "host names, space separated",
    value: mayEditTrustedHosts(f.user) ? editableHosts().join(" ") : "",
    hint: fixed.length > 0 ? `from the environment: ${fixed.join(" ")}` : "origins on these may resolve privately",
    onSubmit: (text) => {
      const saved = updateTrustedHosts(f.db, f.user, text);
      if (!saved.ok) return saved.error === "forbidden" ? "Only a forge admin sets this." : rejectedSentence(saved.rejected);
      ctx.toast(saved.hosts.length === 0 ? "No trusted internal hosts." : `Trusted: ${saved.hosts.join(", ")}.`);
      return undefined;
    },
  });
}
