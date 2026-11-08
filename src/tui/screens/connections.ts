/**
 * Connected origins in the terminal: the hosts your mirrors come from, as
 * Settings › Origins lists them. `s` syncs the selected one now, `d` disconnects
 * it after a confirm — through `actions/origins.ts`, in `origin_words.ts`'s words.
 */

import { connectOrigin, checkOriginAgain, connectRefusal, disconnectOrigin, listUserOrigins, syncOriginNow } from "../../actions/origins.ts";
import { CHECK_TOO_SOON, CHECK_WORDS, DISCONNECT_DETAIL, NO_SUCH_ORIGIN, connectWords, disconnectedWords, syncedWords } from "../../actions/origin_words.ts";
import { mirrorsByOrigin } from "../../core/origins.ts";
import { writesPaused } from "../../origins/credential.ts";
import { FORGE_NOT_CARRIED, FORGE_SIGN_IN_ON_PAGE } from "../../origins/words.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, confirmScreen, drawList, later, promptScreen } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const host = (webUrl: string): string => URL.parse(webUrl)?.host ?? webUrl;
const day = (at: string | null): string => (at === null ? "never synced" : `synced ${at.slice(0, 16).replace("T", " ")}`);

export function connectionsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const origins = () => (f.user === undefined ? [] : listUserOrigins(f.app, f.user));
  const counts = () => (f.user === undefined ? new Map<string, { count: number }>() : mirrorsByOrigin(f.app.db, f.user.id));

  const screen: Screen = {
    title: "Connected origins",
    keys: [binding(["j", "k"], "move cursor"), binding(["c"], "connect"), binding(["s"], "sync now"), binding(["v"], "verify again"), binding(["d"], "disconnect"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const all = origins();
      const picked = all[state.index];
      const pausedNote = picked !== undefined && writesPaused(f.app, picked.id) !== undefined;
      const text =
        picked?.software === "forge"
          ? `Another forge. ${FORGE_NOT_CARRIED}`
          : pausedNote
            ? "Couldn't verify this connection; writes paused. Reading and syncing go on. Press v to check again."
            : all.length === 0
            ? `No origin connected. Press c to connect one. ${FORGE_SIGN_IN_ON_PAGE}`
            : `The hosts your mirrors come from. ${FORGE_SIGN_IN_ON_PAGE}`;
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
            ...(o.lastError !== "" || writesPaused(f.app, o.id) !== undefined ? { tone: "danger" as const } : {}),
            secondary: `${o.software === "forge" ? "another forge · " : ""}${k} repositor${k === 1 ? "y" : "ies"} · ${day(o.lastSyncAt)}`,
            meta: o.lastError !== "" ? o.lastError : writesPaused(f.app, o.id) !== undefined ? "writes paused" : o.authKind === "oauth" ? "OAuth" : "token",
          };
        }),
      );
    },
    key(e) {
      if (state.key(e, origins().length)) return true;
      if (e.ctrl || e.alt || f.user === undefined) return false;
      if (e.key === "c") {
        const user = f.user;
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Connect an origin",
            label: "Host or address (a forge, Forgejo, Gitea, GitHub)",
            placeholder: "forge.example.com",
            onSubmit: (hostText) => {
              if (hostText === "") return "Type the address of the forge.";
              return later(ctx, () =>
                promptScreen(ctx, screen, {
                  title: "Connect an origin",
                  label: `Access token for ${hostText}`,
                  hint: "Made in that forge's settings; kept encrypted here.",
                  mask: true,
                  onSubmit: (token) => {
                    if (token.trim() === "") return "Paste the token.";
                    ctx.toast(`Connecting ${hostText}…`);
                    return connectOrigin(f.app, user, { host: hostText, token }).then((r) => {
                      ctx.toast(r.ok ? `Connected ${r.value.login} at ${host(r.value.webUrl)}.` : connectRefusal(r.error).message ?? connectWords(connectRefusal(r.error).code), r.ok ? "success" : "danger");
                      ctx.invalidate();
                    });
                  },
                }),
              );
            },
          }),
        );
        return true;
      }
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
      if (e.key === "v") {
        ctx.toast(`Checking ${host(o.webUrl)}…`);
        void checkOriginAgain(f.app, user, o.id)
          .then((r) => {
            if (!r.ok) ctx.toast(r.error === "too_soon" ? CHECK_TOO_SOON : NO_SUCH_ORIGIN, "danger");
            else ctx.toast(CHECK_WORDS[r.value], r.value === "passed" || r.value === "unguarded" ? "success" : "danger");
            ctx.invalidate();
          })
          .catch(() => ctx.toast("The check failed.", "danger"));
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
