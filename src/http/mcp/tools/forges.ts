import { clientRows } from "../../../spawn/clients.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "forges",
  doc: "an admin's list of the forges sent from here: name, address, whom for, apps, claimed or not, last activity, whether each public address answers",
  description:
    "Forges sent from here (admin): name, address, apps, claimed, spendTodayUsd, ceilingUsd.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  async run(ctx, user) {
    if (!user.isAdmin)
      return bad("forbidden", "only an admin of this forge sees the forges it sent");
    const forges = await clientRows(ctx.app);
    return good({
      says:
        forges.length === 0
          ? "This forge has sent no forges yet."
          : `${forges.length} forge${forges.length === 1 ? "" : "s"} sent from here.`,
      forges,
    });
  },
};
