import { usesByVendor, type VendorUse } from "../../../cloud/declared.ts";
import { cloudOverview } from "../../../cloud/overview.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "cloud_accounts",
  doc: "the forge's cloud accounts, each attached provider token with its use, verification, write permission and today's calls; a forge admin only (counted as a write so a `ro` token never lists them)",
  description:
    "Cloud accounts (admin): each token's use.",
  inputSchema: { type: "object", properties: {} },
  // A read, but marked a write so a `ro` token never lists the accounts; it
  // is a forge admin's and the audit rows name every vendor call.
  writes: true,
  async run(ctx, user) {
    if (!user.isAdmin) return bad("not_found", "no such tool here");
    const uses = await usesByVendor(ctx.app.db, ctx.app.reposRoot, user).catch(() => new Map<string, VendorUse[]>());
    const seen = cloudOverview(ctx.app, user, uses);
    if (!seen.ok) return bad("not_found", "no such tool here");
    return good(seen.value);
  },
};
