/**
 * Connected origins in the terminal: the hosts your mirrors come from, as
 * Settings › Origins lists them. `s` syncs the selected one now, `d` disconnects
 * it after a confirm — through `actions/origins.ts`, in `origin_words.ts`'s words.
 */

import { disconnectOrigin, listUserOrigins, syncOriginNow } from "../../actions/origins.ts";
import { DISCONNECT_DETAIL, NO_SUCH_ORIGIN, disconnectedWords, syncedWords } from "../../actions/origin_words.ts";
import { mirrorsByOrigin } from "../../core/origins.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, confirmScreen, drawList } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const host = (webUrl: string): string => URL.parse(webUrl)?.host ?? webUrl;
const day = (at: string | null): string => (at === null ? "never synced" : `synced ${at.slice(0, 16).replace("T", " ")}`);

export function connectionsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const origins = () => (f.user === undefined ? [] : listUserOrigins(f.app, f.user));
  const counts = () => (f.user === undefined ? new Map<string, { count: number }>() : mirrorsByOrigin(f.app.db, f.user.id));

  const screen: Screen = {
    title: "Connected origins",
    keys: [binding(["j", "k"], "move cursor"), binding(["s"], "sync now"), binding(["d"], "disconnect"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const all = origins();
      const text = all.length === 0 ? "No origin connected. Connect one in Settings › Origins." : "The hosts your mirrors come from.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const n = counts();
      drawList(
        s,
        list!,
        c,
        state,
        all.map((o) => {
          const k = n.get(o.id)?.count ?? 0;
          return {
            title: `${host(o.webUrl)} · ${o.login}`,
            ...(o.lastError !== "" ? { tone: "danger" as const } : {}),
            secondary: `${k} repositor${k === 1 ? "y" : "ies"} · ${day(o.lastSyncAt)}`,
            meta: o.lastError !== "" ? o.lastError : o.authKind === "oauth" ? "OAuth" : "token",
          };
        }),
      );
    },
    key(e) {
      if (state.key(e, origins().length)) return true;
      if (e.ctrl || e.alt || f.user === undefined) return false;
      const o = origins()[state.index];
      if (o === undefined) return false;
      const user = f.user;
      if (e.key === "s") {
        ctx.toast(`Syncing ${host(o.webUrl)}…`);
        void syncOriginNow(f.app, user, o.id)
          .then((r) => {
            if (!r.ok) ctx.toast(NO_SUCH_ORIGIN, "danger");
            else if (r.value.error !== "") ctx.toast(r.value.error, "danger");
            else ctx.toast(syncedWords(r.value.repos), "success");
            ctx.invalidate();
          })
          .catch(() => ctx.toast("The sync failed.", "danger"));
        return true;
      }
      if (e.key === "d") {
        ctx.push(
          confirmScreen(ctx, screen, {
            title: "Disconnect this origin?",
            body: [`${o.login} at ${host(o.webUrl)}`, "", DISCONNECT_DETAIL],
            actions: [
              { label: "Cancel", variant: "ghost" },
              { label: "Disconnect", variant: "danger" },
            ],
            width: 80,
            onChoose: (choice) => {
              if (choice !== 1) return;
              void disconnectOrigin(f.app, user, o.id)
                .then((r) => {
                  ctx.toast(r.ok ? disconnectedWords(r.value.revokedUpstream) : NO_SUCH_ORIGIN, r.ok ? "success" : "danger");
                  ctx.invalidate();
                })
                .catch(() => ctx.toast("The disconnect failed.", "danger"));
            },
          }),
        );
        return true;
      }
      return false;
    },
  };
  return screen;
}

/** Connected origins: a signed-in person, not an agent. */
export const entry: PaletteEntry = {
  id: "origins",
  title: "Connected origins",
  hint: "the hosts your mirrors come from",
  offered: (session) => session.user !== undefined && session.user.kind !== "agent",
  run: (session, ctx) => ctx.push(connectionsScreen(session, ctx)),
};
