import { changeSignup, readSignup } from "../../../actions/signup.ts";
import { SIGNUP_MODES } from "../../../settings/signup.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool } from "../shared.ts";
import { SIGNUP_WORDS } from "../../../core/arg_words.ts";

export const tool: Tool = {
  name: "signup",
  doc: "`{ mode?, dryRun? }`: who may sign up: `open` (default), `invite` (only a person with an open invite link) or `closed` (no new accounts); without `mode` it reads the setting, with `mode` it plans first (`dryRun` is true unless `false`), and applying needs an admin token",
  description:
    "Sign-ups: open (default); invite lets in only a person with an open invite link; closed refuses every new account",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: [...SIGNUP_MODES] },
      dryRun: { type: "boolean" },
    },
  },
  writes: true,
  dryByDefault: true,
  run(ctx, user, args) {
    const read = readSignup(ctx.app, user);
    if (!read.ok) return bad("not_found", "no such tool here");
    if (args["mode"] === undefined) return good(read.value);
    if (!(SIGNUP_MODES as readonly unknown[]).includes(args["mode"]))
      return bad("invalid_signup", SIGNUP_WORDS);
    if (args["dryRun"] !== false)
      return good({
        says: `Would set signup from ${read.value.signup} to ${String(args["mode"])}. Send dryRun: false to change it.`,
      });
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "changing the forge's signup needs an admin-scope token");
    const changed = changeSignup(ctx.app, user, args["mode"]);
    if (!changed.ok) return bad(changed.error, SIGNUP_WORDS);
    return good({
      says: `signup: ${read.value.signup} → ${changed.value}.`,
      signup: changed.value,
    });
  },
};
