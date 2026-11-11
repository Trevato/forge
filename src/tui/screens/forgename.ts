/**
 * "Is a forge name free?" in the terminal: type a name and be told whether
 * Start my forge would take it, by the same `forgeNameVerdict` as
 * `GET /forges/name/<name>`. Offered to a guest, beside Start my forge.
 */

import { forgeNameVerdict } from "../../actions/spawn.ts";
import type { Ctx } from "../app/app.ts";
import type { Session } from "../session.ts";
import { blank, promptScreen } from "./common.ts";

export const forgeNameCommand = (session: Session, ctx: Ctx) =>
  session.signedIn
    ? []
    : [
        {
          id: "forge-name",
          title: "Is a forge name free?",
          hint: "ask whether Start my forge would take a name",
          run: () =>
            ctx.push(
              promptScreen(ctx, blank("Is a forge name free?"), {
                title: "Is a forge name free?",
                label: "Forge name",
                onSubmit: async (raw) => {
                  const v = await forgeNameVerdict(session.app, raw.trim().toLowerCase());
                  ctx.toast(v.why, v.verdict === "free" ? "success" : "danger");
                },
              }),
            ),
        },
      ];
