/**
 * Billing in the terminal, a forge admin's who is a person: each forge's plan
 * and the hand grant, through the same `readBilling` and `grantPlan` the page
 * and API use. `s`, `m` or `l` grants the forge under the cursor that plan
 * after a yes/no; the change is kept in the audit trail like any other.
 * `c` connects Stripe with a pasted key (shown as dots), `w` saves a webhook
 * signing secret, `x` disconnects after a yes/no: the same actions as the page.
 */

import { grantPlan, readBilling, connectStripe, disconnectStripe, saveSigningSecret, BILLING_WORDS, STRIPE_WORDS } from "../../actions/billing.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { fill, len, split } from "../ui/layout.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { emptyState } from "../ui/widgets.ts";
import { ListState, confirmScreen, drawList, promptScreen, yesNo, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const isAdmin = (f: Session): boolean => f.user?.isAdmin === true && f.user.kind !== "agent";
const stripeWords = (e: keyof typeof STRIPE_WORDS | "not_found" | "no_such_forge" | "bad_plan"): string =>
  e === "not_found" ? "Not found." : e in STRIPE_WORDS ? `${STRIPE_WORDS[e as keyof typeof STRIPE_WORDS]}.` : `${BILLING_WORDS[e as keyof typeof BILLING_WORDS]}.`;
const PLANS: Record<string, string> = { s: "small", m: "medium", l: "large" };

export function billingRows(f: Session): ListRow[] {
  const read = readBilling(f.app, f.user);
  if (!read.ok) return [];
  return read.value.forges.map((e) => ({ title: e.forge, secondary: e.plan, meta: `${e.status} · ${e.source}` }));
}

export function billingScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";
  const screen: Screen = {
    title: "Billing",
    keys: [binding(["j", "k"], "move cursor"), binding(["s", "m", "l"], "grant small, medium, large"), binding(["c"], "connect Stripe"), binding(["w"], "signing secret"), binding(["x"], "disconnect Stripe"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const rows = billingRows(f);
      state.clamp(rows.length);
      const sc = readBilling(f.app, f.user);
      const stripe = sc.ok && sc.value.stripe ? `Stripe ${sc.value.stripe.mode}, ${sc.value.stripe.signed ? "signed" : "no signing secret"}` : "Stripe not connected";
      const ev = sc.ok ? sc.value.events : undefined;
      const events = ev === undefined ? "" : `Last event: ${ev.last === undefined ? "No event yet" : `${ev.last.type} ${ev.last.at.slice(0, 16).replace("T", " ")} UTC`}. Refused today: ${ev.refusedToday}`;
      if (rows.length === 0) {
        emptyState(s, area, c, { title: "No forge has been sent from here.", body: note === "" ? `Billing has nothing to grant yet. ${stripe}. ${events}.` : note });
        return;
      }
      const [head, evHead, body] = split(area, "v", [len(1), len(1), fill(1)]);
      s.text(evHead!.x, evHead!.y, truncate(events, evHead!.w), style(c.mutedFg, c.bg), evHead!.x + evHead!.w);
      const line = note === "" ? `${stripe} (c connect, w secret, x disconnect)` : note;
      s.text(head!.x, head!.y, truncate(line, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, body!, c, state, rows);
    },
    key(e) {
      if (isAdmin(f) && (e.key === "c" || e.key === "w")) {
        const connect = e.key === "c";
        ctx.push(
          promptScreen(ctx, screen, {
            title: connect ? "Connect Stripe" : "Webhook signing secret",
            label: connect ? "Stripe secret or restricted key" : "Signing secret (whsec_…)",
            mask: true,
            onSubmit: async (value) => {
              const done = connect ? await connectStripe(f.app, f.user, value, "") : saveSigningSecret(f.app, f.user, value);
              note = done.ok ? (connect ? "Stripe is connected." : "Signing secret saved.") : stripeWords(done.error);
              ctx.invalidate();
            },
          }),
        );
        return true;
      }
      if (isAdmin(f) && e.key === "x") {
        const go = (i: number): void => {
          if (i !== 0) return;
          void disconnectStripe(f.app, f.user).then((r) => {
            note = r.ok ? "Stripe is disconnected." : stripeWords(r.error);
            ctx.invalidate();
          });
        };
        ctx.push(yesNo(ctx, confirmScreen(ctx, screen, { title: "Disconnect Stripe", body: ["Remove the webhook and forget the key?"], actions: [{ label: "Disconnect" }, { label: "Cancel" }], onChoose: go }), go));
        return true;
      }
      const plan = PLANS[e.key];
      const rows = billingRows(f);
      const target = rows[state.index];
      if (plan !== undefined && target !== undefined) {
        const grant = (i: number): void => {
          if (i !== 0) return;
          const set = grantPlan(f.app, f.user, target.title, plan);
          note = set.ok ? `${target.title} is on ${plan}.` : set.error === "not_found" ? "Not found." : `${BILLING_WORDS[set.error]}.`;
          ctx.invalidate();
        };
        const ask = confirmScreen(ctx, screen, {
          title: "Grant a plan",
          body: [`Put ${target.title} on ${plan}?`],
          actions: [{ label: "Grant" }, { label: "Cancel" }],
          onChoose: grant,
        });
        ctx.push(yesNo(ctx, ask, grant));
        return true;
      }
      return state.key(e, rows.length);
    },
  };
  return screen;
}

/** Each forge's plan, and the grant. */
export const entry: PaletteEntry = {
  id: "billing",
  title: "Billing",
  hint: "each forge's plan, and grant one by hand",
  offered: isAdmin,
  run: (session, ctx) => ctx.push(billingScreen(session, ctx)),
};
