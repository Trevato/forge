/**
 * Where you are signed in, in the terminal (#7237): this terminal's key,
 * your browsers and your tokens, each with its kind, where and when it was
 * last seen, as Settings → Sessions and MCP `sessions` list them — never a
 * secret. `d` signs the selected browser out after a confirm, through
 * `endAccountSession`, so the gate is the action's: your own account only.
 * `d` on a token revokes it after a confirm, through the action `deleteToken`
 * as Settings and the API do (your own only, and `token.deleted` is emitted).
 * `m` makes a token through the action `createToken` (what Settings uses, so
 * `token.created` is emitted and `ADMIN_TOKEN_WORDS` is the refusal): a name,
 * a scope, and for admin a second explicit `y`. The secret is shown once on a
 * screen of its own and forgotten when that screen is left. Only a person
 * minting from a terminal session may: an agent is not offered `m`.
 * `p` changes your password through the action `changePassword` (what
 * Settings › Password and the API use, so the sign-in throttle applies and
 * `user.updated` is emitted): the current one, the new one and the new one
 * again, each in a masked prompt. The typed passwords live only in the
 * prompts' closures for the call; refusals read in Settings' words. An agent
 * is not offered `p`, as it is not offered `m`.
 * This terminal is held by its key, not a browser session, and cannot be
 * ended from here.
 */

import { UPSTREAM_REPO } from "../../core/upstream.ts";
import { accountSignIns, endAccountSession } from "../../actions/signins.ts";
import {
  CHANGE_PASSWORD_WORDS,
  PASSWORD_CHANGED_WORDS,
  changePassword,
  createToken,
  deleteToken,
} from "../../actions/users.ts";
import { marketplaceLines, offeredPluginRepo } from "../../core/mcp_card.ts";
import { publicOrigin } from "../../core/public_origin.ts";
import { withinPasswordCap } from "../../core/hash-gate.ts";
import { listKeys } from "../../core/keys.ts";
import { ADMIN_TOKEN_WORDS, type TokenScope } from "../../core/tokens.ts";
import { MIN_PASSWORD } from "../../core/users.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, ago, confirmScreen, drawList, later, promptScreen, type ListRow } from "./common.ts";

interface SignIn {
  readonly kind: "terminal" | "browser" | "token";
  readonly id: string;
  readonly where: string;
  readonly seen: string | null;
  readonly since: string;
  readonly here: boolean;
  /** Set on a token row: the parts of `where`, for the confirm. */
  readonly name?: string;
  readonly scope?: string;
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
      where: t.oauthClient === null ? `${t.name} · ${t.scope}` : `${t.name} · ${t.scope} · ${t.oauthClient}, renews itself`,
      seen: t.lastUsedAt,
      since: t.createdAt,
      here: false,
      name: t.name,
      scope: t.scope,
    })),
  ];
}

/** Cut into rows of `width` characters: wrapped, never truncated, so a hand-copied line is the whole line. */
function hardWrap(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const rows: string[] = [];
  for (let i = 0; i < text.length; i += w) rows.push(text.slice(i, i + w));
  return rows;
}

/** The secret, alone on a screen; nothing keeps it once this is popped. */
function secretScreen(ctx: Ctx, secret: string, market: { add: string; install: string } | null): Screen {
  let copied = "";
  return {
    title: "New access code",
    keys: [
      binding(["y"], "copy it"),
      ...(market === null ? [] : [binding(["a"], "copy the marketplace line"), binding(["i"], "copy the install line")]),
      binding(["esc", "q"], "done"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      const end = area.x + area.w;
      const bottom = area.y + area.h;
      s.text(area.x, area.y, truncate("copy it now, it is never shown again.", area.w), style(c.mutedFg, c.bg), end);
      const lines = hardWrap(secret, area.w);
      lines.forEach((line, i) => s.text(area.x, area.y + 2 + i, line, style(c.fg, c.bg), end));
      const foot = copied === "" ? "y copies it, esc is done." : copied;
      s.text(area.x, area.y + 3 + lines.length, truncate(foot, area.w), style(c.mutedFg, c.bg), end);
      if (lines.length > 1)
        s.text(area.x, area.y + 4 + lines.length, truncate("It wraps; y copies it whole.", area.w), style(c.mutedFg, c.bg), end);
      // The same marketplace lines Settings › Tokens offers, under the same gate; wrapped whole or not drawn.
      if (market === null) return;
      const top = area.y + 6 + lines.length;
      const add = hardWrap(market.add, area.w);
      const install = hardWrap(market.install, area.w);
      const head = "Claude Code plugin (a, i copy):";
      if (top + 1 + add.length + install.length > bottom) {
        if (top < bottom) s.text(area.x, top, truncate("Plugin lines: a and i copy them.", area.w), style(c.mutedFg, c.bg), end);
        return;
      }
      s.text(area.x, top, truncate(head, area.w), style(c.mutedFg, c.bg), end);
      [...add, ...install].forEach((row, i) => s.text(area.x, top + 1 + i, row, style(c.fg, c.bg), end));
    },
    key(e) {
      if (e.ctrl || e.alt) return true;
      if (e.key === "y") {
        ctx.copy(secret);
        copied = "Copied.";
      } else if (market !== null && e.key === "a") {
        ctx.copy(market.add);
        copied = "Copied the marketplace line.";
      } else if (market !== null && e.key === "i") {
        ctx.copy(market.install);
        copied = "Copied the install line.";
      } else if (e.key === "esc" || e.key === "q") {
        ctx.pop();
      }
      return true;
    },
  };
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
      note = "This terminal cannot be ended from here: disconnect, or remove its key in Settings → Computer keys.";
      ctx.invalidate();
      return;
    }
    if (picked.kind === "token") {
      ctx.push(
        confirmScreen(ctx, screen, {
          title: "Revoke a token",
          body: [`Revoke ${picked.name} (${picked.scope})? It stops working at once.`],
          actions: [{ label: "Keep", variant: "ghost" }, { label: "Revoke", variant: "danger" }],
          onChoose: (i) => {
            if (i < 1) return;
            const user = f.user;
            const done = user !== undefined && deleteToken(f.app, user, picked.id).ok;
            note = done ? "Revoked that token." : "That token is already gone.";
            ctx.invalidate();
          },
        }),
      );
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

  /** Pushes the secret's screen; call it once the modal has popped. */
  const mint = (name: string, scope: TokenScope): void => {
    const user = f.user;
    const made = createToken(f.app, user, name, scope);
    if (!made.ok) {
      note = made.error === "forbidden" ? ADMIN_TOKEN_WORDS : "Sign in to make a token.";
      ctx.invalidate();
      return;
    }
    note = `Made ${name} (${scope}).`;
    const repo = offeredPluginRepo(f.db, f.app.config.forgeRepo, UPSTREAM_REPO);
    const origin = publicOrigin(f.app.config.url, `http://${f.app.config.host ?? "localhost"}:${f.app.config.port ?? 3000}`);
    ctx.push(secretScreen(ctx, made.value.token, repo === undefined ? null : marketplaceLines(origin, repo)));
  };

  /** Asks admin to say it twice; a plain y mints. */
  const confirmAdmin = (name: string) =>
    later(ctx, () =>
      confirmScreen(ctx, screen, {
        title: "Make an admin access code",
        body: [`${name} will act as admin: y to make it, n to cancel.`],
        actions: [{ label: "Make it", variant: "danger" }, { label: "Cancel", variant: "ghost" }],
        yesNo: true,
        selected: 1,
        width: 60,
        onChoose: (i) => {
          if (i === 0) mint(name, "admin");
        },
      }),
    );

  const askScope = (name: string, isAdmin: boolean) =>
    later(ctx, () =>
      promptScreen(ctx, screen, {
        title: "Make an access code",
        label: isAdmin ? "Scope: ro, rw or admin" : "Scope: ro or rw",
        value: "ro",
        onSubmit: (word) => {
          const scope = word.toLowerCase();
          if (scope === "admin" && !isAdmin) return ADMIN_TOKEN_WORDS;
          if (scope !== "ro" && scope !== "rw" && scope !== "admin") return isAdmin ? "Type ro, rw or admin." : "Type ro or rw.";
          if (scope === "admin") return confirmAdmin(name);
          return Promise.resolve().then(() => mint(name, scope));
        },
      }),
    );

  const askName = (isAdmin: boolean) =>
    promptScreen(ctx, screen, {
      title: "Make an access code",
      label: "Name",
      value: "token",
      onSubmit: (name) => {
        if (name === "") return "A token needs a name.";
        if ([...name].length > 64) return "Keep the name to 64 characters.";
        return askScope(name, isAdmin);
      },
    });

  const make = (): void => {
    const user = f.user;
    // An agent holds no keys to mint with; a guest has no account.
    if (user === undefined || user.kind === "agent") return;
    ctx.push(askName(user.isAdmin));
  };

  /** Calls the action; the passwords are arguments only, never kept here. */
  const change = async (current: string, next: string): Promise<void> => {
    const changed = await changePassword(f.app, f.user, { current, next, source: f.identity.remoteAddress });
    note = changed.ok ? PASSWORD_CHANGED_WORDS : CHANGE_PASSWORD_WORDS[changed.error];
    ctx.invalidate();
  };

  const askAgain = (current: string, next: string) =>
    later(ctx, () =>
      promptScreen(ctx, screen, {
        title: "Change your password",
        label: "New password, again",
        mask: true,
        onSubmit: (again) => (again === next ? change(current, next) : "The two new passwords don't match."),
      }),
    );

  const askNext = (current: string) =>
    later(ctx, () =>
      promptScreen(ctx, screen, {
        title: "Change your password",
        label: "New password",
        mask: true,
        // Refused here, in Settings' words, so a weak one is not typed twice;
        // the action checks again.
        onSubmit: (next) => {
          if (next === "") return "Type a new password.";
          if (next.length < MIN_PASSWORD) return CHANGE_PASSWORD_WORDS.weak_password;
          if (!withinPasswordCap(next)) return CHANGE_PASSWORD_WORDS.password_too_long;
          return askAgain(current, next);
        },
      }),
    );

  const askCurrent = () =>
    promptScreen(ctx, screen, {
      title: "Change your password",
      label: "Current password",
      mask: true,
      onSubmit: (current) => (current === "" ? "Type your current password." : askNext(current)),
    });

  const rotate = (): void => {
    const user = f.user;
    // An agent signs in with a key, not a password; a guest has no account.
    if (user === undefined || user.kind === "agent") return;
    ctx.push(askCurrent());
  };

  const screen: Screen = {
    title: "Signed in",
    keys: [
      binding(["j", "k"], "move cursor"),
      binding(["d"], "sign a browser out or revoke a token"),
      binding(["m"], "make an access code"),
      binding(["p"], "change your password"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      const all = signInsOf(f);
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const text =
        note !== ""
          ? note
          : f.user === undefined
            ? "Sign in to see where you are signed in."
            : f.user.kind === "agent"
              ? "Where you are signed in. d signs a browser out or revokes a token."
              : "Where you are signed in. d signs a browser out or revokes a token, m makes an access code, p changes your password.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, body!, c, state, rows(all));
    },
    key(e) {
      note = "";
      const all = signInsOf(f);
      if (state.key(e, all.length)) return true;
      if (e.ctrl || e.alt) return false;
      if (e.key === "m") {
        make();
        return true;
      }
      if (e.key === "p") {
        rotate();
        return true;
      }
      if (e.key !== "d") return false;
      const picked = all[state.index];
      if (picked === undefined) return false;
      end(picked);
      return true;
    },
  };
  return screen;
}
