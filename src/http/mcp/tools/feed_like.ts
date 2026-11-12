import { readInteraction } from "../../../feed/interact.ts";
import { likeLedger, parseLedgerBefore, setLike } from "../../../feed/likes.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "feed_like",
  doc: "`{ item, act, app?, before? }`: `act` like or unlike writes one row to the like ledger (who, what, when), as the card's Like does; liking a liked item is a no-op that answers the same; `act` history reads the item's ledger, newest first, 50 a page (`before` = a seq to read older rows; `more` says some remain); answers `{ likes, liked }` or `{ ledger: [{ seq, who, act, at }], more }`",
  description: "Like or unlike a feed item as a ledger row, or read its ledger.",
  inputSchema: {
    type: "object",
    properties: {
      item: { type: "string" },
      act: { type: "string", enum: ["like", "unlike", "history"] },
      app: { type: "string" },
      before: { type: "number" },
    },
    required: ["item", "act"],
  },
  writes: true,
  run(ctx, user, args) {
    const act = args["act"];
    if (act !== "like" && act !== "unlike" && act !== "history")
      return bad("invalid_kind", "act is one of like, unlike, history");
    // `kind` is the door's own for a like; the caller names `act`.
    const checked = readInteraction(ctx.app.db, user, { ...args, kind: "liked" }, ["liked"] as const);
    if (!checked.ok) return bad(checked.error.code, checked.error.message);
    const { itemId, target } = checked.value;
    if (act === "history") {
      const before = parseLedgerBefore(args["before"]);
      if (before === null) return bad("invalid_before", "before is a ledger seq, a positive whole number");
      const page = likeLedger(ctx.app.db, itemId, before);
      return good({ ledger: page.rows, more: page.more });
    }
    const now = setLike(ctx.app.db, user.id, itemId, target.repoId, act);
    return good(now);
  },
};
