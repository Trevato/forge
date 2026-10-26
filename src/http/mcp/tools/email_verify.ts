import { resendVerification } from "../../../actions/verify.ts";
import { CAPPED_WORDS } from "../../../actions/mail.ts";
import { VERIFY_WORDS } from "../../../actions/verify_words.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "email_verify",
  doc: "no input: send the caller a new verification email, with the API's rate limit and errors; the answer never carries the link",
  description: "Send yourself a new verification link.",
  inputSchema: { type: "object", properties: {} },
  writes: true,
  async run(ctx, user) {
    const sent = await resendVerification(ctx.app, user);
    if (sent.ok)
      return good({
        outcome: sent.value,
        says: sent.value === "sent" ? "A new verification email is on its way." : "Your email is already verified.",
      });
    if (sent.error === "too_soon")
      return bad("too_soon", VERIFY_WORDS.too_soon);
    if (sent.error === "no_mail")
      return bad("no_mail", VERIFY_WORDS.no_mail);
    if (sent.error === "capped") return bad("capped", CAPPED_WORDS);
    if (sent.error === "unauthorized") return bad("unauthorized", "sign in first");
    return bad("failed", VERIFY_WORDS.failed);
  },
};
