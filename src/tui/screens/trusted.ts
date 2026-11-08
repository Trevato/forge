/**
 * Trusted sources in the terminal (#8937), a forge admin's: the list
 * Settings → Trusted sources has, with the same doors — `a` trusts an
 * account on a forge until a date, `x` removes the one under the cursor, `s`
 * is the kill switch (stops all folding in, or resumes it), `v` reverts what
 * the one under the cursor landed. Each goes through `actions/trusted_sources.ts`,
 * so it is the same check, the same audit and the same event as the web's.
 * Anyone else is not offered it.
 */

import { addTrust, removeTrust, revertBySource, setFoldInStopped } from "../../actions/trusted_sources.ts";
import { endsSoon, foldInStopped, leftWords, listTrusted, type TrustError } from "../../core/trusted_sources.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, confirmScreen, drawList, promptScreen, runAsync, type ListRow } from "./common.ts";

const WORDS: Record<TrustError | "not_found", string> = {
  bad_host: "That is not a forge address.",
  bad_account: "That is not an account name.",
  bad_date: "Give the end as a date, year-month-day.",
  in_the_past: "That date has passed.",
  not_found: "Only a forge admin changes who is trusted.",
};

/** Whether the palette offers the screen: a signed-in admin who is a person. */
export const mayTrust = (f: Session): boolean => f.user !== undefined && f.user.isAdmin && f.user.kind !== "agent";

export function trustedScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const entries = () => (mayTrust(f) ? listTrusted(f.db) : []);

  const rows = (): ListRow[] => {
    const now = new Date();
    return entries().map((s) => ({
      title: `${s.account}  ${s.host}`,
      meta:
        s.until <= now.toISOString()
          ? "lapsed, waits for review"
          : `until ${s.until.slice(0, 10)} (${leftWords(s.until, now)})${endsSoon(s, now) ? ", ends soon" : ""}`,
    }));
  };

  const screen: Screen = {
    title: "Trusted sources",
    keys: [binding(["j", "k"], "move cursor"), binding(["a"], "trust"), binding(["x"], "remove"), binding(["s"], "stop or resume"), binding(["v"], "revert landings")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const stopped = foldInStopped(f.db);
      const text = !mayTrust(f)
        ? "Only a forge admin changes who is trusted."
        : stopped !== undefined
          ? `Folding in is stopped (by ${stopped.by}); s resumes it.`
          : "Who folds in without a person's review; s stops all of it.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, body!, c, state, rows());
    },
    key(e) {
      if (!mayTrust(f) || e.ctrl || e.alt) return false;
      if (state.key(e, entries().length)) return true;
      const user = f.user;
      const at = entries()[state.index];
      if (e.key === "a") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Trust a source",
            label: "account forge until, e.g. jmoran git.open-platform.sh 2026-12-02",
            hint: "account (child:name for a downstream forge), forge, end date",
            onSubmit: (raw) => {
              const [account = "", host = "", until = ""] = raw.trim().split(/\s+/);
              const made = addTrust(f.app, user, { account, host, until });
              if (!made.ok) return WORDS[made.error];
              ctx.toast(`${made.value.account} on ${made.value.host} is trusted until ${made.value.until.slice(0, 10)}.`, "success");
              ctx.invalidate();
              return undefined;
            },
          }),
        );
        return true;
      }
      if (e.key === "s") {
        const stop = foldInStopped(f.db) === undefined;
        ctx.push(
          confirmScreen(ctx, screen, {
            title: stop ? "Stop all folding in" : "Resume folding in",
            body: [stop ? "Every trusted source's work waits for review until you resume." : "Trusted sources' work folds in again."],
            actions: [{ label: "Cancel", variant: "ghost" }, { label: stop ? "Stop" : "Resume", variant: "default" }],
            onChoose: (i) => {
              if (i !== 1) return;
              setFoldInStopped(f.app, user, stop);
              ctx.toast(stop ? "Folding in is stopped." : "Folding in resumed.", "success");
              ctx.invalidate();
            },
          }),
        );
        return true;
      }
      if (at === undefined) return false;
      if (e.key === "x") {
        ctx.push(
          confirmScreen(ctx, screen, {
            title: "Remove trust",
            body: [`${at.account} on ${at.host} will wait for review.`],
            actions: [{ label: "Keep", variant: "ghost" }, { label: "Remove", variant: "default" }],
            onChoose: (i) => {
              if (i !== 1) return;
              const gone = removeTrust(f.app, user, at.id);
              ctx.toast(gone.ok ? `${at.account} on ${at.host} now waits for review.` : WORDS.not_found, gone.ok ? "success" : "danger");
              ctx.invalidate();
            },
          }),
        );
        return true;
      }
      if (e.key === "v") {
        ctx.push(
          confirmScreen(ctx, screen, {
            title: "Revert landings",
            body: [`Opens a revert pull for everything ${at.account} on ${at.host} landed, for you to land.`],
            actions: [{ label: "Cancel", variant: "ghost" }, { label: "Open reverts", variant: "default" }],
            onChoose: (i) => {
              if (i !== 1) return;
              runAsync(ctx, async () => {
                const done = await revertBySource(f.app, user, at.host, at.account);
                ctx.toast(done.ok ? `${done.value.opened} revert pull${done.value.opened === 1 ? "" : "s"} opened.` : WORDS.not_found, done.ok ? "success" : "danger");
                ctx.invalidate();
              });
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
