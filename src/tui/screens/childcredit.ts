/**
 * A site admin sets what a child forge may spend of this forge's model
 * credential, in the terminal (#10484): pick a forge it sent, type the
 * dollars. The rule is the action's (`lendCredit`), the same as the API's
 * `PUT /api/v1/forges/:name/credit`: admins only, a sum above 0 and up to
 * 100000, the child's bearer handed over before anything is saved.
 */

import { lendCredit, type CreditError } from "../../actions/child_credit.ts";
import { usdWords } from "../../spawn/credit.ts";
import { clientRows } from "../../spawn/clients.ts";
import type { Ctx, Screen } from "../app/app.ts";
import type { Session } from "../session.ts";
import { blank, pickerScreen, promptScreen, runAsync } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const WORDS: Record<CreditError, string> = {
  unauthorized: "sign in first",
  forbidden: "only a site admin lends credit",
  not_found: "no such forge",
  invalid_amount: "dollars above 0 and up to 100000, like 200 or 12.50",
  unreachable: "the child's data could not be reached; nothing was saved",
};

/** "200", "12.50": plain dollars, nothing else, else NaN (the action refuses it). */
export const dollarsOf = (raw: string): number => (/^\d{1,6}(\.\d{1,2})?$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN);

export function lendScreen(f: Session, ctx: Ctx, parent: Screen, forges: readonly { name: string; hint: string }[]): Screen {
  return pickerScreen(ctx, parent, {
    title: "Lend credit to which forge?",
    items: forges.map((c) => ({ id: c.name, label: c.name, hint: c.hint })),
    onPick: (ids) => {
      const name = ids[0];
      if (name === undefined) return;
      ctx.push(
        promptScreen(ctx, parent, {
          title: `Credit for ${name}`,
          label: "dollars it may spend on this forge's credential",
          onSubmit: (raw) =>
            lendCredit(f.app, f.user, name, dollarsOf(raw)).then((done) =>
              ctx.toast(done.ok ? `${name} may spend ${usdWords(done.value.capUsd)} of this forge's credit.` : `${name}: ${WORDS[done.error]}`, done.ok ? "success" : "danger"),
            ),
        }),
      );
    },
  });
}

export const entry: PaletteEntry = {
  id: "lend-credit",
  title: "Lend a child credit",
  hint: "set the dollars a forge you sent may spend on this one's model credential",
  after: ["forges"],
  offered: (session) => session.user?.isAdmin === true,
  run: (session, ctx) =>
    runAsync(ctx, async () => {
      const rows = (await clientRows(session.app)).filter((r) => r.made);
      if (rows.length === 0) return void ctx.toast("You have not sent a forge yet");
      ctx.push(lendScreen(session, ctx, blank("Lend credit"), rows.map((r) => ({ name: r.name, hint: r.creditCapUsd == null ? "no credit lent" : `${usdWords(r.creditCapUsd)} lent` }))));
    }),
};
