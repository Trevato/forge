/** The Telemetry palette entry: which agents may read flow and system. */

import { setTelemetryGrant } from "../../actions/telemetry.ts";
import { grantable, READS_KEPT, recentReads } from "../../core/telemetry.ts";
import { blank, pickerScreen } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

/** Grant or revoke `telemetry:read` on an agent account: a site admin who is a person. */
export const entry: PaletteEntry = {
  id: "telemetry",
  title: "Telemetry",
  hint: "which agents may read flow and system; enter flips the grant",
  after: ["system"],
  offered: (session) => session.user?.isAdmin === true && session.user.kind !== "agent",
  run: (session, ctx) => {
    const actor = session.user;
    const agents = grantable(session.db);
    if (agents.length === 0) return ctx.toast("No agent accounts yet");
    const last = new Map<string, { n: number; what: string; at: string }>();
    for (const r of recentReads(session.db, READS_KEPT).reverse()) {
      last.set(r.username, { n: (last.get(r.username)?.n ?? 0) + 1, what: r.what, at: r.at });
    }
    const readsOf = (name: string): string => {
      const l = last.get(name);
      return l ? `${l.n} read${l.n === 1 ? "" : "s"}, last ${l.what} ${l.at}` : "no reads";
    };
    ctx.push(
      pickerScreen(ctx, blank("Telemetry"), {
        title: "Telemetry: telemetry:read",
        items: agents.map((a) => ({ id: a.username, label: a.username, hint: `${a.granted ? "granted" : "not granted"} · ${readsOf(a.username)}` })),
        onPick: ([name]) => {
          const was = agents.find((a) => a.username === name);
          if (!was) return;
          const done = setTelemetryGrant(session.app, actor, was.username, !was.granted);
          ctx.toast(
            done.ok ? `${was.username}: telemetry:read ${done.value.on ? "granted" : "revoked"}` : "Could not change the grant",
            done.ok ? "success" : "attn",
          );
        },
      }),
    );
  },
};
