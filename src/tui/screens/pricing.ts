/**
 * `/pricing` in the terminal (#11369): the plans, a name and an email, then
 * **Enter** places the order through `placeOrder` (the same rules as the web
 * form), counted under this SSH client's address bucket. The provider's
 * checkout is a hosted page, so it is printed as text to open anywhere; **r**
 * asks `reconcileOrder` whether it was paid, and once the forge is made the
 * claim link is shown by the same ticket the order was placed with (held here
 * in memory, as the web holds it in a cookie), once, through `deliverLink`.
 * Free is not sold here: its door is Start my forge / New forge.
 */

import { deliverLink, mayView, NO_PROVIDER, placeOrder, reconcileOrder } from "../../actions/order.ts";
import { checkoutOf } from "../../billing/checkout.ts";
import { publicOrigin } from "../../core/public_origin.ts";
import { bucketOf } from "../../http/peer.ts";
import { takeDoorAt } from "../../http/strangers.ts";
import { sizeWords } from "../../settings/billing.ts";
import { FREE, getPlans, type Plan } from "../../settings/plans.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate, wrap } from "../term/width.ts";
import { field } from "../ui/widgets.ts";
import type { Session } from "../session.ts";

/** Text cut into rows of at most `w` characters, for an address that has no spaces to wrap at. */
const chunks = (text: string, w: number): string[] => {
  const out: string[] = [];
  const n = Math.max(1, w);
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
  return out;
};

type Stage =
  | { kind: "form" }
  | { kind: "placed"; id: string; ticket: string; address: string; name: string; says: string }
  | { kind: "done"; name: string; says: string; link?: string };

export function pricingScreen(f: Session, ctx: Ctx): Screen {
  const plans = (): Plan[] => getPlans(f.app.db);
  const paid = (): Plan[] => plans().filter((p) => p.key !== FREE && p.priceUsd > 0);
  const bucket = bucketOf(f.identity.remoteAddress ?? "unknown");
  let name = "";
  let email = "";
  let at = 0;
  let focus: "name" | "email" = "name";
  let error: string | undefined;
  let busy = false;
  let stage: Stage = { kind: "form" };

  const run = (work: () => Promise<void>): void => {
    busy = true;
    void ctx
      .track(
        work().finally(() => {
          busy = false;
          ctx.invalidate();
        }),
      )
      .catch((e: unknown) => ctx.toast(String(e instanceof Error ? e.message : e), "danger"));
  };

  const place = (): void => {
    if (busy) return;
    const plan = paid()[at];
    if (plan === undefined) {
      error = NO_PROVIDER;
      ctx.invalidate();
      return;
    }
    error = undefined;
    run(async () => {
      const verdict = takeDoorAt(f.app, "plan", bucket);
      if (!verdict.allowed) {
        error = `Too many tries from here; try again in ${verdict.retryAfter}s`;
        return;
      }
      const url = new URL(publicOrigin(f.app.config.url, `http://${f.app.config.host ?? "localhost"}:${f.app.config.port ?? 3000}`));
      const placed = await placeOrder(f.app, { name, plan: plan.key, email, address: bucket }, url);
      if (!placed.ok) {
        error = `${placed.error.field === "form" ? "" : `${placed.error.field}: `}${placed.error.message}`;
        return;
      }
      stage = { kind: "placed", id: placed.value.id, ticket: placed.value.ticket, address: placed.value.redirect, name: name.trim(), says: "Open the address and pay; then press r." };
    });
  };

  const check = (): void => {
    if (busy || stage.kind !== "placed") return;
    const s = stage;
    run(async () => {
      // The ticket this screen was given is the order's key, as the cookie is on the web.
      if (!mayView(f.app, s.id, s.ticket)) {
        stage = { kind: "form" };
        error = "That order is not yours to see from here, so nothing is shown. Place it again.";
        return;
      }
      const o = await reconcileOrder(f.app, s.id);
      if (o === undefined) {
        stage = { kind: "form" };
        error = "That order is gone. Place it again.";
        return;
      }
      if (o.state === "pending") s.says = "Not paid yet. Open the address, pay, then press r.";
      else if (o.state === "paid" || o.state === "spawning") s.says = `Paid. Making ${o.name}; press r again in a moment.`;
      else if (o.state === "failed") stage = { kind: "done", name: o.name, says: `Paid, but the forge could not be made: ${o.reason}. The operator has been told; keep the order id ${o.id}.` };
      else {
        const given = await deliverLink(f.app, o);
        if (given.kind === "link") stage = { kind: "done", name: o.name, says: `${o.name} is ready. Open this link to take it over; it is shown once.${given.mailed ? ` It was also sent to ${o.email}.` : ""}`, link: given.claimUrl };
        else if (given.kind === "claimed") stage = { kind: "done", name: o.name, says: `${o.name} is taken over; sign in at its address.` };
        else stage = { kind: "done", name: o.name, says: "The link was shown already, once. Ask for a new one by email at /pricing/resend." };
      }
    });
  };

  const edit = (fn: (v: string) => string): void => {
    if (focus === "name") name = fn(name).slice(0, 60);
    else email = fn(email).slice(0, 254);
    error = undefined;
  };

  return {
    title: "Get a forge",
    keys: [binding(["enter"], "order"), binding(["tab"], "next field"), binding(["up", "down"], "plan"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const w = Math.max(20, area.w);
      let y = area.y;
      const line = (text: string, color = c.fg): void => {
        if (y < area.y + area.h) s.text(area.x, y, truncate(text, w), style(color, c.bg), area.x + area.w);
        y++;
      };
      if (stage.kind !== "form") {
        line(`Forge ${stage.name}`);
        y++;
        for (const row of wrap(stage.says, w)) line(row);
        y++;
        if (stage.kind === "placed") {
          line("Checkout address (open it in a browser to pay):", c.mutedFg);
          for (const row of chunks(stage.address, w)) line(row);
        } else if (stage.link !== undefined) {
          line("Claim link:", c.mutedFg);
          for (const row of chunks(stage.link, w)) line(row);
        }
        return;
      }
      const selling = checkoutOf(f.app) !== undefined;
      line(selling ? "Get your own forge: pick a plan, name it, pay. Free: use Start my forge." : "Plans. Paid plans are not on sale here yet: ask the operator.", c.mutedFg);
      y++;
      const list = paid();
      for (const p of plans()) {
        const isPaid = p.key !== FREE && p.priceUsd > 0;
        const mark = isPaid && list[at]?.key === p.key ? "▸" : " ";
        line(`${mark} ${p.name.padEnd(12)} ${isPaid ? `$${p.priceUsd} a month` : "free"}  ${sizeWords(p.size)}`, isPaid ? c.fg : c.mutedFg);
      }
      y++;
      const base = y - area.y;
      const fw = Math.min(60, w);
      const nameAt = field(s, { x: area.x, y: area.y + base, w: fw, h: 3 }, c, { label: "Name", value: name, focused: focus === "name", cursor: [...name].length, hint: "Lowercase letters, digits and dashes." });
      const emailAt = field(s, { x: area.x, y: area.y + base + 3, w: fw, h: 3 }, c, { label: "Email", value: email, focused: focus === "email", cursor: [...email].length, hint: busy ? "Placing the order…" : "The claim link is shown here after payment." });
      if (error !== undefined)
        wrap(error, fw).forEach((row, i) => {
          if (base + 6 + i < area.h) s.text(area.x, area.y + base + 6 + i, row, style(c.danger, c.bg), area.x + area.w);
        });
      ctx.setCursor(focus === "name" ? nameAt : emailAt);
    },
    paste(text) {
      if (stage.kind !== "form") return false;
      edit((v) => v + text.replace(/\s+/g, ""));
      return true;
    },
    key(e) {
      if (e.key === "esc") {
        ctx.pop();
        return true;
      }
      if (stage.kind === "placed") {
        if (e.key === "r" || e.key === "enter") check();
        else if (e.key === "c") {
          ctx.copy(stage.address);
          ctx.toast("copied through the terminal", "success");
        } else return false;
        return true;
      }
      if (stage.kind === "done") return false;
      if (e.key === "enter") {
        place();
        return true;
      }
      if (e.key === "tab") {
        focus = focus === "name" ? "email" : "name";
        return true;
      }
      const n = paid().length;
      if (e.key === "up" && n > 0) {
        at = (at + n - 1) % n;
        return true;
      }
      if (e.key === "down" && n > 0) {
        at = (at + 1) % n;
        return true;
      }
      if (e.key === "backspace") {
        edit((v) => [...v].slice(0, -1).join(""));
        return true;
      }
      if (!e.ctrl && !e.alt && [...e.key].length === 1 && e.key !== " ") {
        edit((v) => v + e.key);
        return true;
      }
      return false;
    },
  };
}

/** Offered to everyone: the sale is open to a guest and to a signed-in person alike, as on the web. */
export const pricingCommand = (session: Session, ctx: Ctx) => ({
  id: "pricing",
  title: "Get a forge (plans)",
  hint: "pick a plan, name it, pay at the checkout address",
  run: () => ctx.push(pricingScreen(session, ctx)),
});
