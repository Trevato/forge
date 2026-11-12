import { changeBillingLinks, changeSignup, readSignup, readBillingLinks } from "../../../actions/signup.ts";
import { SIGNUP_MODES } from "../../../settings/signup.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool } from "../shared.ts";
import { BILLING_WORDS } from "../../../settings/billing.ts";
import { SIGNUP_WORDS } from "../../../core/arg_words.ts";

export const tool: Tool = {
  name: "signup",
  doc: "`{ mode?, billingLinks?, dryRun? }`: who may sign up: `open` (default), `invite` (only a person with an open invite link) or `closed` (no new accounts); without `mode` it reads the setting, with `mode` it plans first (`dryRun` is true unless `false`); `billingLinks` `{small?, medium?, large?}` (https URLs) sets the home page's buy links; applying needs an admin token",
  description:
    "Sign-ups: open (default); invite lets in only a person with an open invite link; closed refuses every new account",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: [...SIGNUP_MODES] },
      billingLinks: { type: "object" },
      dryRun: { type: "boolean" },
    },
  },
  writes: true,
  dryByDefault: true,
  run(ctx, user, args) {
    const read = readSignup(ctx.app, user);
    if (!read.ok) return bad("not_found", "no such tool here");
    if (args["billingLinks"] !== undefined) {
      if (args["dryRun"] !== false)
        return good({ says: "Would set the billing links. Send dryRun: false to change them." });
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
        return bad("forbidden", "changing billing links needs an admin-scope token");
      const set = changeBillingLinks(ctx.app, user, args["billingLinks"]);
      return set.ok ? good({ says: "Billing links saved.", billingLinks: set.value }) : bad(set.error, BILLING_WORDS);
    }
    if (args["mode"] === undefined) {
      const links = readBillingLinks(ctx.app, user);
      return links.ok ? good({ ...read.value, billingLinks: links.value }) : bad("not_found", "no such tool here");
    }
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
