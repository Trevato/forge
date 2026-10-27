/**
 * Flags in the terminal, a forge admin's (#1970): every declared flag with
 * why it exists, its default, the owner issue and its live value, as
 * Settings → Flags shows them. Enter sets one from a line like
 * `forge=on users=u1,u2 roles=admin percent=30` (checked by `checkInput`, the
 * page's own check); `x` clears it; `w` makes the 30-day winner the default
 * and opens the removal issue (`makeWinnerDefault`). A change goes through
 * the registry's `set`, so it is live at once, as on the page. The gate is the page's:
 * an admin who is not an agent; anyone else sees nothing and sets nothing.
 */

import { readFlags } from "../../actions/flags_view.ts";
import {
  checkInput,
  FLAGS_ADMIN_ONLY,
  flagRegistry,
  mayManageFlags,
  usesLine,
  winnerOffer,
  type FlagInput,
  type FlagValue,
} from "../../core/flags.ts";
import { makeWinnerDefault } from "../../actions/flag_winner.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, promptScreen, type ListRow } from "./common.ts";

const KEYS = ["forge", "users", "roles", "percent"] as const;

/** `forge=on users=a,b` → the page's form fields; an unknown word is an error. */
export function parseLine(line: string): FlagInput | string {
  const out: FlagInput = { forge: "", users: "", roles: "", percent: "" };
  for (const word of line.split(/\s+/).filter((w) => w !== "")) {
    const at = word.indexOf("=");
    const key = word.slice(0, at);
    if (at < 0 || !(KEYS as readonly string[]).includes(key))
      return `"${word.slice(0, 40)}": use forge=on|off users=a,b roles=x percent=30`;
    out[key as (typeof KEYS)[number]] = word.slice(at + 1);
  }
  return out;
}

function show(v: FlagValue | undefined): string {
  if (v === undefined) return "not set";
  return [
    v.forge === undefined ? "" : `forge=${v.forge ? "on" : "off"}`,
    v.users ? `users=${v.users.join(",")}` : "",
    v.roles ? `roles=${v.roles.join(",")}` : "",
    v.percent === undefined ? "" : `percent=${v.percent}`,
  ]
    .filter((x) => x !== "")
    .join(" ");
}

export function flagsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const allowed = mayManageFlags(f.user);
  const names = (): string[] => (allowed ? Object.keys(flagRegistry().decls) : []);
  let note = "";

  const save = (name: string, value: FlagValue | undefined): void => {
    if (!allowed || f.user === undefined) return;
    note = flagRegistry().set(f.db, name, value, f.user.id)
      ? `${name}: ${value === undefined ? "cleared" : "saved"}.`
      : "There is no such flag.";
    ctx.invalidate();
  };

  /** The read-out of the flag under the cursor. */
  const usesOf = (name: string): string =>
    `${name}  ${usesLine(flagRegistry().uses(f.db, name, 7), flagRegistry().uses(f.db, name, 30))}`;

  const offer = (name: string) =>
    winnerOffer(flagRegistry().uses(f.db, name, 30), flagRegistry().value(name as never));

  const winner = (name: string): void => {
    const lead = offer(name);
    if (!allowed || f.user === undefined || lead === undefined) return;
    const made = makeWinnerDefault(f.app, f.user, name, lead);
    note = made.ok
      ? `${name}: ${lead} is the default; issue #${made.issue.number} asks the crew to remove the flag.`
      : made.message;
    ctx.invalidate();
  };

  const rows = (): ListRow[] => {
    const read = readFlags(f.user);
    return (read.ok ? read.flags : []).map((flag) => ({
      title: flag.name,
      secondary: show(flag.value),
      meta: `${offer(flag.name) === undefined ? "" : `w: make ${offer(flag.name)} the default  `}${flag.why}  default ${flag.default ? "on" : "off"}  owner #${flag.issue}`,
    }));
  };

  const screen: Screen = {
    title: "Flags",
    keys: [
      binding(["j", "k"], "move cursor"),
      binding(["enter"], "set"),
      binding(["x"], "clear"),
      binding(["w"], "make the winner the default"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const text =
        note !== ""
          ? note
          : !allowed
            ? FLAGS_ADMIN_ONLY
            : names().length === 0
              ? "No flag is declared yet."
              : usesOf(names()[state.index] ?? names()[0]!);
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, rows());
    },
    key(e) {
      const all = names();
      if (state.key(e, all.length)) return true;
      if (e.ctrl || e.alt || !allowed) return false;
      const name = all[state.index];
      if (name === undefined) return false;
      if (e.key === "x") save(name, undefined);
      else if (e.key === "w") winner(name);
      else if (e.key === "enter")
        ctx.push(
          promptScreen(ctx, screen, {
            title: name,
            label: "forge=on|off users=a,b roles=x percent=30",
            value: show(flagRegistry().value(name as never)).replace("not set", ""),
            onSubmit: (raw) => {
              const input = parseLine(raw);
              if (typeof input === "string") return input;
              const checked = checkInput(input);
              if (!checked.ok) return checked.message;
              save(name, checked.value);
              return undefined;
            },
          }),
        );
      else return false;
      return true;
    },
  };
  return screen;
}
