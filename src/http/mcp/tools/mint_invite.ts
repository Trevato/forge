import { SPEND_WORDS } from "../../../actions/spend_words.ts";
import { inviteLink, mint as mintInviteLink } from "../../../actions/invites.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool, mayBoards } from "../shared.ts";

export const tool: Tool = {
  name: "mint_invite",
  doc: "`{ days? }`: mint a single-use invite link that expires in `days` (1–30, default 7) and is shown once; a person admin's, with an admin token",
  description:
    "Mint a one-use invite link, shown once, valid `days` (1–30, default 7). Person admins.",
  inputSchema: {
    type: "object",
    properties: {
      days: { type: "integer", minimum: 1, maximum: 30 },
    },
  },
  writes: true,
  run(ctx, user, args) {
    if (!mayBoards(user)) return bad("forbidden", "an invite is a forge admin's to mint");
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "an invite needs an admin token");
    const made = mintInviteLink(ctx.app, user, args["days"]);
    if (!made.ok) return bad("invalid", SPEND_WORDS.inviteDays);
    const origin = ctx.app.config.url ?? ctx.url.origin;
    return good({ ...made.value.invite, link: inviteLink(origin, made.value.token) });
  },
};
