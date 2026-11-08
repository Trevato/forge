/**
 * Reports from outside, from a repository screen's `:` palette (#7233): the
 * terminal's door to the waiting list the web, the API and MCP `reports`
 * already show. The row is "Reports (N)" and appears only while N > 0 for a
 * person who may decide them — `waitingCount` is 0 to everyone else. `a`
 * accepts the report under the cursor as an issue (its own title, behind the
 * "From outside" marker) and says the number; `d` dismisses after a confirm.
 * Every rule is the action's (`actions/reports.ts`).
 */

import { REPORT_ALREADY_DECIDED } from "../../actions/origin_app_words.ts";
import { acceptReport, dismissReport, waitingCount, waitingReports } from "../../actions/reports.ts";
import { byFiler, filerWords, type Report } from "../../core/reports.ts";
import type { Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Command } from "../app/palette.ts";
import { style } from "../term/style.ts";
import { truncate, wrap } from "../term/width.ts";
import type { Session } from "../session.ts";
import { beside, fill, len, pct, split } from "../ui/layout.ts";
import { ListState, ago, confirmScreen, drawList, errorText, runAsync, type ListRow } from "./common.ts";

/** The palette row for `repo`: only while reports wait, only to a decider. */
export function reportsCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || f.user === undefined) return [];
  const n = waitingCount(f.app, f.user, repo);
  if (n === 0) return [];
  return [
    {
      id: "reports",
      title: `${repo.ownerName}/${repo.name} — Reports (${n})`,
      hint: "accept or dismiss what outsiders sent",
      run: () => ctx.push(reportsScreen(f, ctx, repo)),
    },
  ];
}

/** A refusal from the action, in the words every other door uses. */
function refusal(code: string): string {
  return code === "decided" ? REPORT_ALREADY_DECIDED : errorText(code);
}

export function reportsScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  let note = "";
  // What the person last saw: a key acts on that row, so a report someone
  // else decided meanwhile is refused in words rather than silently skipped.
  let shown: Report[] = [];
  const load = (): Report[] => {
    const r = waitingReports(f.app, f.user, repo);
    shown = r.ok ? r.value : [];
    return shown;
  };

  const rows = (list: readonly Report[]): ListRow[] =>
    list.map((r) => ({ title: r.title, secondary: filerWords(r.filedBy), meta: ago(r.createdAt) }));

  /** The waiting reports' filers with a count each, most first: "2 @muse · 1 anonymous". */
  const counts = (list: readonly Report[]): string =>
    byFiler(list).map((g) => `${g.count} ${filerWords(g)}`).join(" · ");

  const screen: Screen = {
    title: `Reports: ${repo.ownerName}/${repo.name}`,
    keys: [binding(["j", "k"], "move cursor"), binding(["a"], "accept as an issue"), binding(["d"], "dismiss")],
    render(area, s) {
      const c = ctx.theme.c;
      const list = load();
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const status =
        list.length === 0
          ? "Nothing waits."
          : note === ""
            ? `From ${counts(list)}; unchecked. a accepts as an issue, d dismisses.`
            : "";
      const text = [note, status].filter((t) => t !== "").join(" ");
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const { main, aside } = beside(body!, ctx.twoPane, { main: pct(45), aside: fill(1) });
      drawList(s, main, c, state, rows(list));
      const picked = list[state.index];
      if (aside === undefined || picked === undefined) return;
      const x = aside.x + 1;
      const w = Math.max(0, aside.w - 2);
      const lines = [
        `Sent ${ago(picked.createdAt)} by ${filerWords(picked.filedBy)}`,
        ...(picked.page === null ? [] : [`From ${picked.page}`]),
        "",
        ...wrap(picked.body === "" ? "(no words)" : picked.body, w),
      ];
      lines.slice(0, aside.h).forEach((l, i) =>
        s.text(x, aside.y + i, truncate(l, w), style(i === 0 ? c.mutedFg : c.fg, c.bg), x + w),
      );
    },
    key(e) {
      if (state.key(e, shown.length)) return true;
      if (e.ctrl || e.alt) return false;
      const picked = shown[state.index];
      if (e.key === "a") {
        if (picked === undefined) return false;
        runAsync(ctx, async () => {
          const done = await acceptReport(f.app, f.user, repo, picked.id);
          note = done.ok ? `Accepted as issue #${done.value.number}.` : refusal(done.error);
          ctx.invalidate();
        });
        return true;
      }
      if (e.key === "d") {
        if (picked === undefined) return false;
        ctx.push(
          confirmScreen(ctx, screen, {
            title: "Dismiss this report",
            body: [picked.title, "No issue is opened."],
            actions: [{ label: "Keep waiting", variant: "ghost" }, { label: "Dismiss" }],
            onChoose: (i) => {
              if (i < 1) return;
              const done = dismissReport(f.app, f.user, repo, picked.id);
              note = done.ok ? "Dismissed." : refusal(done.error);
              ctx.invalidate();
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
