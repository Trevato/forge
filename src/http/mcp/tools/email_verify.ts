import { resendVerification } from "../../../actions/verify.ts";
import { verifyWords } from "../../../actions/verify_words.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "email_verify",
  doc: "no input: send the caller a new verification email, with the API's rate limit and errors; the answer never carries the link",
  description: "Send yourself a new verification link.",
  inputSchema: { type: "object", properties: {} },
  writes: true,
  async run(ctx, user) {
    const sent = await resendVerification(ctx.app, user);
    if (sent.ok) return good({ outcome: sent.value, says: verifyWords(sent.value) });
    return bad(sent.error, verifyWords(sent.error));
  },
};
