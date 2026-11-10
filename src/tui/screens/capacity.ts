/**
 * The forge's capacity and guards in the terminal, a forge admin's who is a
 * person: each guard's live value and bounds, and `e` on a settable one asks
 * for a value, shows the plan (from → to) and changes it after a confirm,
 * through the same actions as MCP `capacity`; a move of cells.egress to
 * report asks why first, as the page does. The actions decide who may.
 */

import type { SelfSwap } from "../../release/swap.ts";
import { DERIVED_WORDS, REASON_WORDS, changeCapacity, listCapacity, type CapacityRow } from "../../actions/capacity.ts";
import { SETTING_WORDS } from "../../actions/setting_words.ts";
import { CAPACITY, belowCeiling, needsReason, validCapacity, type CapacityKey } from "../../core/capacity.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { egressReportedLine } from "../../system/egress_line.ts";
import { ListState, confirmScreen, drawList, later, promptScreen, type ListRow } from "./common.ts";

/** Whether the palette offers the screen: a forge admin who is a person. */
export const mayCapacity = (session: Session): boolean =>
  session.user?.isAdmin === true && session.user.kind !== "agent";

/** What a setting takes, in a few words. */
export function boundsOf(key: CapacityKey): string {
  const kind = CAPACITY[key].kind;
  return kind.type === "count" ? `${kind.min}–${kind.max}` : kind.values.join(" | ");
}

/** What a refused change says, in its own words. */
const refused = (error: "not_found" | "no_such_setting" | "invalid_value" | "no_credential" | "derived" | "reason_required"): string =>
  error === "reason_required"
    ? REASON_WORDS
    : error === "derived"
    ? DERIVED_WORDS
    : error === "no_credential"
    ? "Set a password or a passkey first: turning the edge off would lock you out"
    : error === "invalid_value"
      ? SETTING_WORDS.outOfRange
      : "no such capacity setting";

/** Whether this forge can swap itself (#8383), as /settings/capacity says it. */
export function selfSwapRow(s: SelfSwap): ListRow {
  return {
    title: "Self-swap",
    tone: s.blocked === null ? "success" : "attn",
    meta: `${s.blocked === null ? "ready" : "blocked"} · FORGE_SELF_SWAP ${s.enabled ? "set" : "off"} · tcp_migrate_req ${s.migrateReq}`,
    ...(s.blocked === null ? {} : { below: [s.blocked] }),
  };
}

const shown = (v: string): string => (v === "" ? "auto" : v);

export function capacityScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const rows = (): CapacityRow[] => {
    const listed = listCapacity(f.app, f.user);
    return listed.ok ? listed.value.settings : [];
  };
  const lines = (): ListRow[] => {
    const listed = listCapacity(f.app, f.user);
    if (!listed.ok) return [];
    const guards = listed.value.settings.map((r) => {
      const low = belowCeiling(f.app.db, r.key);
      return {
        title: `${r.label} (${r.key})`,
        meta: `${shown(r.value)} · ${r.source === "derived" ? "derived from Speed" : r.source} · takes ${boundsOf(r.key)}${r.source === "setting" ? ` · default ${shown(r.default)}` : ""}${low === null ? "" : ` · below ceiling ${low.ceiling}`}`,
        ...(low === null ? {} : { tone: "attn" as const }),
      };
    });
    // After the guards, so the cursor (bounded by the settings) never lands on it.
    const egress = egressReportedLine(f.app.db);
    return [...guards, selfSwapRow(listed.value.selfSwap), ...(egress === null ? [] : [{ title: egress, tone: "attn" as const }])];
  };

  const plan = (row: CapacityRow, typed: string, reason = ""): void => {
    const to = typed === "" ? row.default : typed;
    later(ctx, () =>
      confirmScreen(ctx, screen, {
        title: "Capacity",
        body: [`${row.key}: ${shown(row.value)} → ${shown(to)}`, ...(reason === "" ? [] : [`why: ${reason}`]), "change it? y/n"],
        actions: [{ label: "y" }, { label: "n" }],
        selected: 1,
        onChoose: (choice) => {
          if (choice !== 0) return;
          const done = changeCapacity(f.app, f.user, row.key, typed, reason);
          if (!done.ok) return ctx.toast(refused(done.error), "danger");
          ctx.toast(`${done.value.key}: ${shown(done.value.from)} → ${shown(done.value.to)}, from the next pick on.`, "success");
          ctx.invalidate();
        },
      }),
    );
  };

  const askWhy = (row: CapacityRow, value: string): void => {
    void later(ctx, () =>
      promptScreen(ctx, screen, {
        title: row.label,
        label: `Why set ${row.key} to ${value}? (kept with your name)`,
        onSubmit: (why) => (why === "" ? REASON_WORDS : (plan(row, value, why), undefined)),
      }),
    );
  };

  const screen: Screen = {
    title: "Capacity",
    keys: [binding(["e"], "change a setting"), binding(["j", "k"], "move cursor")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      s.text(head!.x, head!.y, truncate("e changes the guard under the cursor, as /settings/capacity does", head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, lines());
    },
    key(e) {
      const all = rows();
      if (e.key !== "e") return state.key(e, all.length);
      const row = all[state.index];
      if (row === undefined) return true;
      later(ctx, () =>
        promptScreen(ctx, screen, {
          title: row.label,
          label: `${row.key} (${boundsOf(row.key)}; empty restores the default)`,
          value: row.value,
          onSubmit: (typed) => {
            const value = typed.trim();
            if (value !== "" && !validCapacity(row.key, value)) return SETTING_WORDS.outOfRange;
            // A move to report says why, as the page asks (#10778); tightening never waits.
            if (needsReason(row.key) && value === "report") return askWhy(row, value), undefined;
            return plan(row, value), undefined;
          },
        }),
      );
      return true;
    },
  };
  return screen;
}
