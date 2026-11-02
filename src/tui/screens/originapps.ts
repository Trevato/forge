/**
 * Your OAuth apps for connecting origins, in the terminal (#7291): the host
 * (or kind), client id and whether a secret is set, as Settings and MCP
 * `origin_apps` list them. `a` asks for a host (or github), a client id and a
 * client secret typed masked, and registers it through `registerOriginApp`,
 * refused in the API's words (`connectMessage`); `d` removes the one under the
 * cursor after a confirm. A secret is write-only: it is held in a closure from
 * the masked field to the action and is never drawn, toasted or logged.
 */

import { deleteOriginApp, listOriginApps, registerOriginApp } from "../../actions/origins.ts";
import { connectMessage } from "../../http/api.ts";
import type { AppRow } from "../../origins/oauth.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { wrap } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import type { Session } from "../session.ts";
import { FORGE_SIGN_IN_ON_PAGE } from "../../origins/words.ts";
import { ListState, confirmScreen, drawList, later, promptScreen, type ListRow } from "./common.ts";

/** A row's name: the host of its web address, as the page shows it. */
const hostOf = (a: AppRow): string => a.webUrl.replace(/^https?:\/\//, "");

export function originAppsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let rows: AppRow[] = [];
  let note = "";
  const reload = (): void => {
    rows = f.user === undefined ? [] : listOriginApps(f.app, f.user);
    state.clamp(rows.length);
    ctx.invalidate();
  };
  reload();
  const say = (text: string): void => {
    note = text;
    reload();
  };

  const add = (): Screen =>
    promptScreen(ctx, screen, {
      title: "Register an origin app",
      label: "host, or github",
      placeholder: "github",
      onSubmit: (host) => {
        if (host === "") return "An origin app needs a host, or github.";
        return later(ctx, () =>
          promptScreen(ctx, screen, {
            title: host,
            label: "the OAuth app's client id",
            onSubmit: (clientId) => {
              if (clientId === "") return "`clientId` is required";
              return later(ctx, () =>
                promptScreen(ctx, screen, {
                  title: host,
                  label: "the client secret (sealed, never shown again)",
                  mask: true,
                  onSubmit: async (secret) => {
                    const saved = await registerOriginApp(f.app, f.user, {
                      host,
                      ...(host.toLowerCase() === "github" ? { kind: "github" as const } : {}),
                      clientId,
                      ...(secret.trim() === "" ? {} : { clientSecret: secret }),
                    });
                    say(saved.ok ? `${hostOf(saved.value)} is registered.` : connectMessage(saved.error));
                  },
                }),
              );
            },
          }),
        );
      },
    });

  const remove = (a: AppRow): Screen =>
    confirmScreen(ctx, screen, {
      title: "Remove this origin app",
      body: [`${hostOf(a)}, client ${a.clientId}`, "Connecting that origin by OAuth stops working."],
      actions: [{ label: "Keep", variant: "ghost" }, { label: "Remove", variant: "danger" }],
      onChoose: (i) => {
        if (i !== 1) return;
        const removed = deleteOriginApp(f.app, f.user, a.id);
        say(removed.ok ? `${hostOf(a)} is removed.` : "no such origin app");
      },
    });

  const lines = (): ListRow[] =>
    rows.map((a) => ({
      title: hostOf(a),
      secondary: a.kind,
      meta: `client ${a.clientId} · ${a.hasSecret ? "secret set" : "no secret"}`,
    }));

  const screen: Screen = {
    title: "Origin apps",
    keys: [binding(["a"], "register one"), binding(["d"], "remove"), binding(["j", "k"], "move cursor")],
    render(area, s) {
      const c = ctx.theme.c;
      const text =
        note !== ""
          ? note
          : f.user === undefined
            ? "Sign in to see your origin apps."
            : rows.length === 0
              ? `No origin app yet. Press a to register one. ${FORGE_SIGN_IN_ON_PAGE}`
              : `${rows.length} registered; a secret is never shown.`;
      // A refusal is the API's sentence, whole: it wraps rather than cuts.
      const said = wrap(text, Math.max(1, area.w)).slice(0, 3);
      const [head, list] = split(area, "v", [len(said.length), fill(1)]);
      said.forEach((line, i) => s.text(head!.x, head!.y + i, line, style(c.mutedFg, c.bg), head!.x + head!.w));
      drawList(s, list!, c, state, lines());
    },
    key(e) {
      if (state.key(e, rows.length)) return true;
      if (e.ctrl || e.alt || f.user === undefined) return false;
      if (e.key === "a") {
        note = "";
        ctx.push(add());
        return true;
      }
      const a = rows[state.index];
      if (e.key === "d" && a !== undefined) {
        note = "";
        ctx.push(remove(a));
        return true;
      }
      return false;
    },
  };
  return screen;
}
