import { getUserByName, getUsersByIds } from "../../../core/users.ts";
import { chipsOf, isKindChip, setChip } from "../../../core/feed_chips.ts";
import { KIND_HAS_NO_CHIP } from "../../../actions/feed_words.ts";
import { good, bad, type Tool, str } from "../shared.ts";
import { HIDDEN_WORDS } from "../../../core/arg_words.ts";

export const tool: Tool = {
  name: "feed_chips",
  doc: "`{ kind?, value?, hidden? }`: the feed chips you switched off, which `feed` and `asks` leave out; with `kind` (`kind` or `person`), `value` and `hidden` it switches one off or on",
  description:
    "Feed chips you switched off. With `kind`, `value` and `hidden`, sets one.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["kind", "person"] },
      value: { type: "string", maxLength: 100 },
      hidden: { type: "boolean" },
    },
  },
  writes: true,
  readsWithout: "kind",
  run(ctx, user, args) {
    if (args["kind"] !== undefined) {
      const value = str(args["value"]);
      const hidden = args["hidden"];
      if (typeof hidden !== "boolean") return bad("invalid", HIDDEN_WORDS);
      if (args["kind"] === "kind") {
        if (!isKindChip(value)) return bad("invalid", KIND_HAS_NO_CHIP);
        setChip(ctx.app.db, user.id, { kind: "kind", value }, hidden);
      } else if (args["kind"] === "person") {
        const who = getUserByName(ctx.app.db, value);
        if (!who || who.kind === "org") return bad("not_found", "no such person");
        setChip(ctx.app.db, user.id, { kind: "person", value: who.id }, hidden);
      } else return bad("invalid", "kind is `kind` or `person`");
    }
    const chips = chipsOf(ctx.app.db, user.id);
    return good({
      kinds: [...chips.kinds].sort(),
      people: [...getUsersByIds(ctx.app.db, [...chips.people]).values()]
        .map((u) => u.username)
        .sort(),
    });
  },
};
