/**
 * Cloud accounts in the terminal, a forge admin's (#2199): each account with
 * what it is used for, when it was verified and last used, and today's vendor
 * calls, as Settings → Cloud accounts shows them. `a` attaches (verified, then
 * sealed), `v` re-verifies, `r` rotates, `n` renames, `x` removes — all through
 * `actions/cloud.ts`, so the checks are the page's. A token is typed masked and
 * is never drawn, kept or put in a note. Anyone else sees nothing and does nothing.
 */

import { addAccount, allowWrite, auditAccount, removeAccount, renameAccount, reverify, rotateAccount } from "../../actions/cloud.ts";
import { usesByVendor, type VendorUse } from "../../cloud/declared.ts";
import { cloudOverview } from "../../cloud/overview.ts";
import { LABEL, PROVIDERS } from "../../cloud/providers.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, drawList, later, promptScreen, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";

const day = (at: string | null): string => (at === null ? "never" : at.slice(0, 16).replace("T", " "));

/** Every vendor call of today, newest first: when, whose, why, where, how much, let through or refused. */
function callsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const calls = () => {
    const r = cloudOverview(f.app, f.user);
    return r.ok ? r.value.today : [];
  };
  return {
    title: "Vendor calls today",
    keys: [binding(["j", "k"], "move cursor"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const all = calls();
      s.text(head!.x, head!.y, truncate(`${all.length} vendor call${all.length === 1 ? "" : "s"} today (UTC), newest first.`, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(
        s,
        list!,
        c,
        state,
        all.map((r) => ({
          title: `${r.provider}/${r.account} ${r.purpose}`,
          ...(r.allowed ? {} : { tone: "danger" as const }),
          secondary: `${r.allowed ? "allowed" : "REFUSED"} · ${r.bytesOut} B out · ${r.at.slice(11, 19)}`,
          meta: r.target,
        })),
      );
    },
    key: (e) => state.key(e, calls().length),
  };
}

export function cloudScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";
  let uses: ReadonlyMap<string, readonly VendorUse[]> = new Map();
  const read = () => cloudOverview(f.app, f.user, uses);
  const allowed = (): boolean => read().ok;
  const accounts = () => {
    const r = read();
    return r.ok ? r.value.accounts : [];
  };

  if (f.user?.isAdmin === true)
    void usesByVendor(f.app.db, f.app.reposRoot, f.user)
      .then((m) => {
        uses = m;
        ctx.invalidate();
      })
      .catch(() => undefined);

  const say = (text: string): void => {
    note = text;
    ctx.invalidate();
  };
  const settle = async <T>(r: Promise<{ ok: true; value: T } | { ok: false; error: string }>, good: (v: T) => string): Promise<void> => {
    const made = await r;
    say(made.ok ? good(made.value) : made.error);
  };

  const rows = (): ListRow[] =>
    accounts().map((a) => ({
      title: `${a.provider}/${a.name}`,
      secondary: `verified ${day(a.verifiedAt)} · used ${day(a.lastUsedAt)} · ${a.callsToday} call${a.callsToday === 1 ? "" : "s"} today`,
      meta: a.writeAllowed ? "writes allowed" : "read-only",
    }));

  const attach = (parent: Screen): Screen =>
    promptScreen(ctx, parent, {
      title: "Attach a cloud account",
      label: `provider/name, provider is ${PROVIDERS.join(", ")}`,
      placeholder: "github/main",
      onSubmit: (raw) => {
        const [provider = "", name = "", ...rest] = raw.split("/");
        if (rest.length > 0 || name === "") return "Write it as provider/name.";
        if (!(PROVIDERS as readonly string[]).includes(provider)) return `A provider is ${PROVIDERS.join(", ")}.`;
        return later(ctx, () =>
          promptScreen(ctx, parent, {
            title: `${LABEL[provider as (typeof PROVIDERS)[number]]} / ${name}`,
            label: "the token (checked, then sealed, never shown)",
            mask: true,
            onSubmit: (value) => settle(addAccount(f.app, f.user, provider, name, value.trim()), () => `Sealed ${provider}/${name}.`),
          }),
        );
      },
    });

  const screen: Screen = {
    title: "Cloud accounts",
    keys: [
      binding(["j", "k"], "move cursor"),
      binding(["a"], "attach"),
      binding(["v"], "verify"),
      binding(["r"], "rotate"),
      binding(["n"], "rename"),
      binding(["x"], "remove"),
      binding(["w"], "writes on/off"),
      binding(["A"], "audit"),
      binding(["c"], "calls today"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      const r = read();
      const [head, list] = split(area, "v", [len(1), fill(1)]);
      const selected = r.ok ? r.value.accounts[state.index] : undefined;
      const text =
        note !== ""
          ? note
          : !r.ok
            ? "Cloud accounts are a forge admin's."
            : selected !== undefined
              ? `${selected.summary} ${selected.usedFor}`
              : "No account attached. Press a to attach one.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, rows());
    },
    key(e) {
      if (state.key(e, accounts().length)) return true;
      if (e.ctrl || e.alt || !allowed()) return false;
      if (e.key === "a") {
        ctx.push(attach(screen));
        return true;
      }
      if (e.key === "c") {
        ctx.push(callsScreen(f, ctx));
        return true;
      }
      const a = accounts()[state.index];
      if (a === undefined) return false;
      const { provider, name } = a;
      if (e.key === "v") {
        say(`Verifying ${provider}/${name}…`);
        void settle(reverify(f.app, f.user, provider, name), () => `Verified ${provider}/${name}.`);
      } else if (e.key === "r")
        ctx.push(
          promptScreen(ctx, screen, {
            title: `Rotate ${provider}/${name}`,
            label: "the new token (checked, then sealed)",
            mask: true,
            onSubmit: (value) => settle(rotateAccount(f.app, f.user, provider, name, value.trim()), () => `Rotated ${provider}/${name}.`),
          }),
        );
      else if (e.key === "n")
        ctx.push(
          promptScreen(ctx, screen, {
            title: `Rename ${provider}/${name}`,
            label: "new name",
            onSubmit: (to) => {
              const r = renameAccount(f.app, f.user, provider, name, to);
              if (!r.ok) return r.error;
              say(`Renamed to ${provider}/${to}.`);
              return undefined;
            },
          }),
        );
      else if (e.key === "w") {
        const r = allowWrite(f.app, f.user, provider, name, !a.writeAllowed);
        say(r.ok ? `${provider}/${name}: ${a.writeAllowed ? "read-only" : "writes allowed"}.` : r.error);
      } else if (e.key === "A")
        ctx.push(
          promptScreen(ctx, screen, {
            title: `Audit ${provider}/${name}`,
            label: "owner/repo to file the findings in",
            onSubmit: (repo) => {
              say(`Auditing ${provider}/${name}…`);
              return settle(auditAccount(f.app, f.user, provider, name, repo), (v) => `Audit: ${v.opened} issue${v.opened === 1 ? "" : "s"} opened, ${v.found} found.`);
            },
          }),
        );
      else if (e.key === "x")
        ctx.push(
          promptScreen(ctx, screen, {
            title: `Remove ${provider}/${name}`,
            label: `type ${name} to remove it and its sealed token`,
            onSubmit: (typed) => {
              if (typed !== name) return `Type ${name} to confirm.`;
              const r = removeAccount(f.app, f.user, provider, name);
              if (!r.ok) return r.error;
              say(`Removed ${provider}/${name}.`);
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

/** Cloud accounts, as Settings → Cloud accounts has them: a forge admin (#2199). */
export const entry: PaletteEntry = {
  id: "cloud",
  title: "Cloud accounts",
  hint: "provider tokens, what they are used for, today's calls",
  offered: (session) => session.user?.isAdmin === true,
  run: (session, ctx) => ctx.push(cloudScreen(session, ctx)),
};
