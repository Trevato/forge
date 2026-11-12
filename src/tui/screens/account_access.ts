/**
 * A person's access, in the terminal (#11688), as `/settings/accounts/<name>`
 * has it: every person with their role, the browsers they are signed in on
 * now and when one was last seen. `/` searches by name, `c` clears it; `r`
 * resets the selected person's access (a one-hour, one-use link, shown on a
 * screen of its own; `r` asks whether to sign them out everywhere too) and
 * `e` signs them out everywhere, each after a confirm. Every rule is the
 * action's (`actions/account_access.ts`): only an admin sees or does any of
 * it, never to themselves or an agent, and another admin only for the forge's
 * owner. Each act is an event, so web viewers see it live.
 */

import { ACCESS_WORDS, accessUrl, endAllSessions, resetAccess } from "../../actions/account_access.ts";
import { listAccounts } from "../../actions/accounts.ts";
import { listSessions } from "../../core/sessions.ts";
import { roleOf } from "../../core/roles.ts";
import { getUserByName } from "../../core/users.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, ago, confirmScreen, drawList, linkScreen, live, promptScreen, runAsync, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

/** What a search may be: names are short. */
const MAX_QUERY = 64;

interface Line {
  readonly username: string;
  readonly row: ListRow;
}

export function accountAccessScreen(f: Session, ctx: Ctx): Screen {
  const list = new ListState();
  let query = "";

  /** The people the viewer may see, searched; empty for anyone who is not an admin. */
  const lines = (): Line[] => {
    const listed = listAccounts(f.app, f.user);
    if (!listed.ok) return [];
    const needle = query.toLowerCase();
    return listed.value
      .filter((a) => a.kind === "user" && a.removedAt === null)
      .filter((a) => needle === "" || a.username.toLowerCase().includes(needle) || a.displayName.toLowerCase().includes(needle))
      .map((a): Line => {
        const user = getUserByName(f.db, a.username);
        const browsers = user === undefined ? [] : listSessions(f.db, user.id);
        const seen = browsers.map((b) => b.lastSeenAt ?? b.createdAt).sort().at(-1);
        return {
          username: a.username,
          row: {
            title: `${a.username}  ${a.isAdmin ? "admin" : user === undefined ? "" : roleOf(f.db, user)}${a.suspendedAt === null ? "" : "  suspended"}`,
            meta: `${browsers.length === 0 ? "not signed in" : `signed in on ${browsers.length} ${browsers.length === 1 ? "browser" : "browsers"}, last seen ${ago(seen ?? "")}`}`,
          },
        };
      });
  };

  const refused = (error: "not_found" | "not_allowed"): void =>
    ctx.toast(error === "not_found" ? "No such person." : ACCESS_WORDS.notAllowed, "danger");

  const reset = (username: string, endAll: boolean): void =>
    runAsync(ctx, async () => {
      const done = await resetAccess(f.app, f.user, username, { endAll });
      if (!done.ok) return refused(done.error);
      const url = done.value.token === undefined ? undefined : accessUrl(f.app, done.value.token);
      const ended = done.value.sessionsEnded > 0 ? ` Signed out of ${done.value.sessionsEnded}.` : "";
      ctx.toast(`Link made for ${username}; it works once, for an hour.${done.value.mailed ? " Mailed to them." : ""}${ended}`);
      if (url !== undefined) ctx.push(linkScreen(ctx, url, screen));
    });

  const askReset = (username: string): void =>
    ctx.push(
      confirmScreen(ctx, screen, {
        title: `Reset ${username}'s access`,
        body: [`Makes a one-hour, one-use link for ${username} to set a new password; whoever opens it takes the account.`],
        actions: [{ label: "Reset and sign out", variant: "danger" }, { label: "Reset only", variant: "danger" }, { label: "Cancel", variant: "ghost" }],
        selected: 2,
        width: 70,
        onChoose: (i) => {
          if (i === 0 || i === 1) reset(username, i === 0);
        },
      }),
    );

  const askEnd = (username: string): void =>
    ctx.push(
      confirmScreen(ctx, screen, {
        title: `Sign ${username} out everywhere`,
        body: [`Every browser ${username} is signed in on stops working at once. Sign them out?`],
        actions: [{ label: "Sign out", variant: "danger" }, { label: "Cancel", variant: "ghost" }],
        selected: 1,
        yesNo: true,
        onChoose: (i) => {
          if (i !== 0) return;
          const done = endAllSessions(f.app, f.user, username);
          if (!done.ok) return refused(done.error);
          ctx.toast(`${username} is signed out of ${done.value.sessionsEnded} ${done.value.sessionsEnded === 1 ? "browser" : "browsers"}.`);
        },
      }),
    );

  const screen: Screen = {
    title: "Account access",
    keys: [
      binding(["j", "k"], "move cursor"),
      binding(["/"], "search by name"),
      binding(["c"], "clear search"),
      binding(["r"], "reset access"),
      binding(["e"], "end all sessions"),
    ],
    load(signal) {
      live(f, signal, { where: (e) => e.kind.startsWith("account.") }, () => ctx.invalidate());
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const all = lines();
      list.clamp(all.length);
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const note =
        f.user?.isAdmin !== true || f.user.kind !== "user"
          ? "Only a forge admin sees this."
          : all.length === 0
            ? query === "" ? "No one is here." : `No one matches ${query}.`
            : query === "" ? "Everyone on this forge. r resets access, e ends all sessions." : `${all.length} matching ${query}.`;
      s.text(head!.x, head!.y, truncate(note, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, body!, c, list, all.map((l) => l.row));
    },
    key(e) {
      const all = lines();
      if (list.key(e, all.length)) return true;
      if (e.ctrl || e.alt) return false;
      if (e.key === "/") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Search accounts",
            label: "name contains",
            value: query,
            onSubmit: (raw) => {
              const word = raw.trim();
              if (word.length > MAX_QUERY) return "Keep it to 64 characters.";
              query = word;
              list.index = 0;
              ctx.invalidate();
              return undefined;
            },
          }),
        );
        return true;
      }
      if (e.key === "c") {
        query = "";
        ctx.invalidate();
        return true;
      }
      const picked = all[list.index];
      if (e.key === "r" && picked !== undefined) askReset(picked.username);
      else if (e.key === "e" && picked !== undefined) askEnd(picked.username);
      else return false;
      return true;
    },
  };
  return screen;
}

/** A forge admin's: reset a person's access and end their sessions, as the account page does. */
export const entry: PaletteEntry = {
  id: "account-access",
  title: "Account access",
  hint: "search people, reset access, end sessions",
  after: ["people"],
  offered: (session) => session.user?.isAdmin === true && session.user.kind === "user",
  run: (session, ctx) => ctx.push(accountAccessScreen(session, ctx)),
};
