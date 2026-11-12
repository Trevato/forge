import { scopeAllows } from "../../../core/tokens.ts";
import { snapshotsOf } from "../../../snapshot/service.ts";
import { good, bad, type Tool, mayBoards } from "../shared.ts";

export const tool: Tool = {
  name: "restore_drill",
  doc: "no input: restore the newest snapshot as a drill and answer `{ verdict, failedStep?, says }`, worded as the Backups page's button; no store, a failure or a red drill is an answer, not an error; a forge admin's, with an admin token",
  description: "Drill-restore the newest snapshot.",
  inputSchema: { type: "object", properties: {} },
  writes: true,
  adminOnly: true,
  async run(ctx, user) {
    if (!mayBoards(user)) return bad("forbidden", "a restore drill is a forge admin's to run");
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "a drill needs an admin token");
    const svc = snapshotsOf(ctx.app);
    if (svc === undefined || svc.store === undefined)
      return good({ verdict: "none", says: "This forge has no snapshots to drill." });
    try {
      const d = await svc.drill();
      const answer =
        d.verdict === "green"
          ? good({ verdict: "green", says: "The drill restored green." })
          : good({ verdict: "red", failedStep: d.failedStep, says: `The drill failed at ${d.failedStep}.` });
      return { ...answer, card: { at: d.at } };
    } catch (error) {
      return good({ verdict: "none", says: `The drill could not run: ${String(error)}` });
    }
  },
};
