/**
 * "Does a forge answer?" in the terminal: pick a forge this one sent and be
 * told whether it answers yet, by the same `childReady` as
 * `GET /forges/<name>/ready`. Yes or no; the claim code is never shown.
 */

import { listChildren } from "../../actions/spawn.ts";
import { childReady } from "../../spawn/ready.ts";
import type { Ctx } from "../app/app.ts";
import { blank, pickerScreen, runAsync } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

export const entry: PaletteEntry = {
  id: "forge-ready",
  title: "Does a forge answer?",
  hint: "ask whether a forge you sent answers yet",
  after: ["forges"],
  // Admin only, as `forges` is: the list names every forge this one sent.
  offered: (session) => session.user?.isAdmin === true,
  run: (session, ctx: Ctx) =>
    runAsync(ctx, async () => {
      // From the ledger alone: filling the picker probes no child.
      const rows = await listChildren(session.app);
      if (rows.length === 0) return void ctx.toast("You have not sent a forge yet");
      ctx.push(
        pickerScreen(ctx, blank("Does a forge answer?"), {
          title: "Which forge?",
          items: rows.map((r) => ({ id: r.name, label: r.name, hint: "" })),
          onPick: (ids) => {
            const name = ids[0];
            if (name === undefined) return;
            runAsync(ctx, async () => {
              const ready = await childReady(session.app, name);
              if (ready === undefined) return void ctx.toast(`${name}: no such forge`, "danger");
              ctx.toast(ready ? `${name} answers.` : `${name} does not answer yet.`, ready ? "success" : "danger");
            });
          },
        }),
      );
    }),
};
