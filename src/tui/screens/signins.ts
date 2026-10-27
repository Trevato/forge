/**
 * Where you are signed in, in the terminal (#7237): this terminal's key,
 * your browsers and your tokens, each with its kind, where and when it was
 * last seen, as Settings → Sessions and MCP `sessions` list them — never a
 * secret. `d` signs the selected browser out after a confirm, through
 * `endAccountSession`, so the gate is the action's: your own account only.
 * This terminal is held by its key, not a browser session, and cannot be
 * ended from here; a token is revoked from Settings → Personal access tokens.
 */

import { accountSignIns, endAccountSession } from "../../actions/signins.ts";
import { listKeys } from "../../core/keys.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, ago, confirmScreen, drawList, type ListRow } from "./common.ts";

interface SignIn {
  readonly kind: "terminal" | "browser" | "token";
  readonly id: string;
  readonly where: string;
  readonly seen: string | null;
  readonly since: string;
  readonly here: boolean;
}

/** The tail of an id: two browsers signed in the same day still read apart. */
const shortId = (id: string): string => id.slice(-6).toLowerCase();

/** The rows, this terminal first; empty for a guest. */
export function signInsOf(f: Session): SignIn[] {
  const user = f.user;
  if (user === undefined) return [];
  // Without `current`: the terminal holds no browser cookie, so no browser
  // row is ever "this one" here; this terminal's key is.
  const seen = accountSignIns(f.app, user, user.username);
  if (!seen.ok) return [];
  const key = f.keyId === undefined ? undefined : listKeys(f.db, user.id).find((k) => k.id === f.keyId);
  return [
    ...(key === undefined
      ? []
      : [{ kind: "terminal" as const, id: key.id, where: key.name, seen: key.lastUsedAt, since: key.createdAt, here: true }]),
    ...seen.value.sessions.map((s) => ({
      kind: "browser" as const,
      id: s.id,
      where: `web browser ${shortId(s.id)}`,
      seen: s.lastSeenAt,
      since: s.createdAt,
      here: s.current,
    })),
    ...seen.value.tokens.map((t) => ({
      kind: "token" as const,
      id: t.id,
      where: `${t.name} · ${t.scope}`,
      seen: t.lastUsedAt,
      since: t.createdAt,
      here: false,
    })),
  ];
}

export function signInsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";

  const rows = (all: readonly SignIn[]): ListRow[] =>
    all.map((s) => ({
      title: s.here ? `${s.where} · this one` : s.where,
      secondary: s.kind,
      meta: `last seen ${s.seen === null ? "never" : ago(s.seen)} · since ${s.since.slice(0, 10)}`,
    }));

  const end = (picked: SignIn): void => {
    if (picked.kind === "terminal") {
      note = "This terminal cannot be ended from here: disconnect, or remove its key in Settings → SSH keys.";
      ctx.invalidate();
      return;
    }
    if (picked.kind === "token") {
      note = "A token is revoked from Settings → Personal access tokens.";
      ctx.invalidate();
      return;
    }
    ctx.push(
      confirmScreen(ctx, screen, {
        title: "Sign this browser out",
        body: [`${picked.where}: last seen ${picked.seen === null ? "never" : ago(picked.seen)}, signed in ${picked.since.slice(0, 10)}.`],
        actions: [{ label: "Keep", variant: "ghost" }, { label: "Sign out", variant: "danger" }],
        onChoose: (i) => {
          if (i < 1) return;
          const user = f.user;
          const done = user !== undefined && endAccountSession(f.app, user, user.username, picked.id).ok;
          note = done ? "Signed that browser out." : "That browser is already signed out.";
          ctx.invalidate();
        },
      }),
    );
  };

  const screen: Screen = {
    title: "Signed in",
    keys: [binding(["j", "k"], "move cursor"), binding(["d"], "sign a browser out")],
    render(area, s) {
      const c = ctx.theme.c;
      const all = signInsOf(f);
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const text =
        note !== ""
          ? note
          : f.user === undefined
            ? "Sign in to see where you are signed in."
            : "Where you are signed in. d signs the selected browser out.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, body!, c, state, rows(all));
    },
    key(e) {
      note = "";
      const all = signInsOf(f);
      if (state.key(e, all.length)) return true;
      if (e.ctrl || e.alt || e.key !== "d") return false;
      const picked = all[state.index];
      if (picked === undefined) return false;
      end(picked);
      return true;
    },
  };
  return screen;
}
