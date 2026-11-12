import { BILLING_WORDS, grantPlan, planGrant, readPlan } from "../../../actions/billing.ts";
import { CODE_ERRORS, makeCode, planCode, readCodes, revoke } from "../../../actions/codes.ts";
import { publicOrigin } from "../../../core/public_origin.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { clientRows } from "../../../spawn/clients.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "forges",
  doc: "an admin's list of the forges sent from here: name, address, whom for, apps, claimed, stage (sent/opened/signed in/last tell; resend true when unopened 3 days: claim_link), last activity, reachable, size, use; `{ forge, plan?, dryRun? }` reads a forge's plan (small|medium|large, status, source, changes) or, with `plan`, grants it by hand; gift codes: `codes` true lists, `code` {plan, uses?, note?, expires?} makes (shown once), `revoke` id; planned unless `dryRun` is false",
  description:
    "Forges sent from here (admin; a stage says when to resend), or one forge's plan to read or grant.",
  inputSchema: { type: "object", properties: { forge: { type: "string" }, plan: { type: "string" }, codes: { type: "boolean" }, code: { type: "object" }, revoke: { type: "string" }, dryRun: { type: "boolean" } } },
  writes: true,
  dryByDefault: true,
  readsWithout: ["forge", "plan", "code", "revoke"],
  async run(ctx, user, args) {
    if (!user.isAdmin)
      return bad("forbidden", "only an admin of this forge sees the forges it sent");
    if (args["codes"] === true || args["code"] !== undefined || args["revoke"] !== undefined) {
      const no = (e: string) => (e === "not_found" ? bad("not_found", "Not found.") : bad("invalid", CODE_ERRORS[e as keyof typeof CODE_ERRORS] ?? e));
      if (args["code"] === undefined && args["revoke"] === undefined) {
        const read = readCodes(ctx.app, user);
        return read.ok ? good(read.value) : no(read.error);
      }
      const live = args["dryRun"] === false;
      if (live && !scopeAllows(ctx.auth.scope ?? "ro", "admin")) return bad("forbidden", "gift codes need an admin token");
      if (args["revoke"] !== undefined) {
        if (!live) return good({ says: "This would revoke the code; nothing changed. Send dryRun: false to do it." });
        const done = revoke(ctx.app, user, args["revoke"]);
        return done.ok ? good(done.value) : no(done.error);
      }
      const input = typeof args["code"] === "object" && args["code"] !== null ? (args["code"] as Record<string, unknown>) : {};
      if (!live) {
        const planned = planCode(ctx.app, user, input);
        return planned.ok ? good({ plan: planned.value, says: "This is the code; nothing was made. Send dryRun: false to make it." }) : no(planned.error);
      }
      const made = makeCode(ctx.app, user, input, publicOrigin(ctx.app.config.url, ctx.url.origin));
      return made.ok ? good({ code: made.value.code, link: made.value.link, says: "Shown once: the plain code is not kept." }) : no(made.error);
    }
    if (args["forge"] !== undefined || args["plan"] !== undefined) {
      const refuse = (e: string) => (e === "not_found" ? bad("not_found", "Not found.") : bad("invalid", BILLING_WORDS[e as keyof typeof BILLING_WORDS] ?? e));
      if (args["plan"] === undefined) {
        const read = readPlan(ctx.app, user, String(args["forge"]));
        return read.ok ? good(read.value) : refuse(read.error);
      }
      if (args["dryRun"] !== false) {
        const planned = planGrant(ctx.app, user, args["forge"], args["plan"]);
        return planned.ok ? good({ ...planned.value, says: "This is the plan; nothing changed. Send dryRun: false to grant it." }) : refuse(planned.error);
      }
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin")) return bad("forbidden", "granting a plan needs an admin token");
      const set = grantPlan(ctx.app, user, args["forge"], args["plan"]);
      return set.ok ? good(set.value) : refuse(set.error);
    }
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
