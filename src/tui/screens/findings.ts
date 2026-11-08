/**
 * Findings in the terminal (#9593): the findings page's list from the same
 * reads — `listFindings`, `lastScan` — newest open first, never the matched
 * text. `a` on an open finding asks why it may stand and accepts it through
 * `acceptFinding`, the action the page's form calls, so the same people are
 * refused (agents, readers, guests) and the acceptance shows on the page.
 * Access is read at every draw: a person who cannot read sees nothing.
 */

import { acceptFinding, REASON_MAX, REASON_MIN } from "../../actions/scan_accept.ts";
import { lastScan, listFindings, type FindingRow } from "../../checks/scan_store.ts";
import { canRead, canWrite, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { emptyState } from "../ui/widgets.ts";
import { ListState, drawList, promptScreen, type ListRow } from "./common.ts";

const pass = (run: { at: string; skipped: number } | null): string =>
  run === null ? "never" : `${run.at.slice(0, 16).replace("T", " ")}${run.skipped === 0 ? "" : ` (partial: ${run.skipped} not read)`}`;

export function findingRow(f: FindingRow): ListRow {
  const where = `${f.path}${f.line > 0 ? `:${f.line}` : ""}`;
  return {
    title: f.rule,
    secondary: f.accepted !== null ? "accepted" : f.severity,
    ...(f.accepted === null ? { tone: f.severity === "high" ? ("danger" as const) : ("attn" as const) } : {}),
    meta: where,
    note: f.accepted !== null ? `accepted by ${f.accepted.by}: ${f.accepted.reason}` : `${f.kind} · found ${f.foundAt.slice(0, 10)} at ${f.oid.slice(0, 12)}`,
  };
}

export function findingsScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  const visible = (): boolean => canRead(f.db, repo, f.user);
  const writer = (): boolean => f.user !== undefined && f.user.kind === "user" && canWrite(f.db, repo, f.user);
  const rows = (): FindingRow[] => (visible() ? listFindings(f.db, repo.id) : []);
  const screen: Screen = {
    title: "Findings",
    keys: [binding(["j", "k"], "move cursor"), ...(writer() ? [binding(["a"], "accept with a reason")] : []), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      if (!visible()) {
        emptyState(s, area, c, { title: "Not yours to see", body: "Findings are for the repository's readers." });
        return;
      }
      const list = rows();
      const head = `Last push scan ${pass(lastScan(f.db, repo.id, "push"))} · last nightly scan ${pass(lastScan(f.db, repo.id, "nightly"))}`;
      if (list.length === 0) {
        emptyState(s, area, c, { title: "Nothing found", body: head });
        return;
      }
      s.text(area.x, area.y, head.slice(0, area.w), style(c.mutedFg, c.bg));
      drawList(s, { ...area, y: area.y + 2, h: Math.max(0, area.h - 2) }, c, state, list.map(findingRow));
    },
    key(e) {
      if (e.ctrl || e.alt) return state.key(e, rows().length);
      if (e.key === "a") {
        const finding = rows()[state.index];
        if (finding === undefined) return false;
        if (finding.accepted !== null) {
          ctx.toast("That finding is already accepted.");
          return true;
        }
        if (!writer()) {
          ctx.toast("Only a person with write access accepts a finding.", "danger");
          return true;
        }
        ctx.push(
          promptScreen(ctx, screen, {
            title: `Accept ${finding.rule}`,
            label: `why it may stand (${REASON_MIN} to ${REASON_MAX} characters)`,
            onSubmit: (reason) => {
              const done = acceptFinding(f.app, repo, f.user, finding.id, reason);
              if (!done.ok) return done.why;
              ctx.toast("Accepted. The reason is recorded on the finding.");
              ctx.invalidate();
              return undefined;
            },
          }),
        );
        return true;
      }
      return state.key(e, rows().length);
    },
  };
  return screen;
}
