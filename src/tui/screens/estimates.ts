/**
 * A repository's estimates, in the terminal (#11955): the issues the crew builds from next, each
 * with what is promised for it, and the same two acts the page, the API and MCP `estimate` reach.
 * Gated as they are: a reader sees the list (sealed issues left to `sealedScope`) and asks an
 * issue's base rate with `a`; recording with `r` is `recordEstimate`, so only a writer or a crew
 * member on the repository can. The line typed is `event p50 p90 basis…`, e.g.
 * `merged 2026-11-14T07:15:00Z 2026-11-14T11:00:00Z a small change`.
 */

import { askEstimate, estimateIssue, recordEstimate, type Asked } from "../../actions/estimates.ts";
import { currentByNumber, type EstimateRow } from "../../core/estimates.ts";
import { nextUp, type NextRow } from "../../core/next_up.ts";
import { canRead, canWrite, type Repo } from "../../core/repos.ts";
import { mayView, sealedScope } from "../../core/sealed.ts";
import { estimateLine } from "../../flow/estimate_words.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { fill, len, split } from "../ui/layout.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { ListState, drawList, live, promptScreen, type ListRow } from "./common.ts";

/** The rows shown: the top of the list, as the page's. */
const SHOWN = 100;
const LIVE_KINDS = ["issue.estimated", "issue.ranked", "issue.opened", "issue.closed", "issue.reopened"];

/** `event p50 p90 basis…` as the act's input. */
export function parseEstimate(line: string): { event: string; p50: string; p90: string; basis: string } | undefined {
  const m = /^\s*(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/s.exec(line);
  return m === null ? undefined : { event: m[1]!, p50: m[2]!, p90: m[3]!, basis: (m[4] ?? "").trim() };
}

export function estimatesScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  let rows: readonly NextRow[] = [];
  let promised = new Map<number, EstimateRow[]>();
  let asked: Asked | undefined;
  let loaded = false;
  // Read at use, not at open: access can change under a session.
  const may = (): boolean => f.user !== undefined && canWrite(f.db, repo, f.user);

  const reload = (): void => {
    if (!canRead(f.db, repo, f.user)) {
      rows = [];
      promised = new Map();
    } else {
      const scope = sealedScope(f.db, repo, f.user);
      rows = nextUp(f.db, repo, scope).rows.slice(0, SHOWN);
      promised = currentByNumber(f.db, repo.id, rows.filter((r) => r.issue.estimated).map((r) => r.issue.number));
    }
    loaded = true;
    state.clamp(rows.length);
    ctx.invalidate();
  };

  const current = (): NextRow | undefined => rows[state.index];
  const target = () => {
    const row = current();
    // The act's own gate for one issue: a kind of issue the viewer may see.
    const issue = row === undefined ? undefined : estimateIssue(f.app, repo, row.issue.number);
    return issue !== undefined && mayView(f.db, repo, issue, f.user) ? issue : undefined;
  };

  const ask = (): void => {
    const issue = target();
    if (issue === undefined || !canRead(f.db, repo, f.user)) return;
    asked = askEstimate(f.app, f.user, repo, issue);
    ctx.invalidate();
  };

  const record = (): void => {
    const issue = target();
    if (issue === undefined || !may()) return;
    ctx.push(
      promptScreen(ctx, screen, {
        title: `Estimate #${issue.number}`,
        label: "event p50 p90 basis: event is pull_opened, merged, live or done; times like 2026-11-14T07:15:00Z",
        onSubmit: (raw) => {
          const input = parseEstimate(raw);
          if (input === undefined) return "event, p50 and p90 first, then the basis";
          const made = recordEstimate(f.app, f.user!, repo, issue, input);
          if (!made.ok) return made.error.message;
          ctx.toast(`Recorded: ${made.value.base.basis}`, "success");
          reload();
          return undefined;
        },
      }),
    );
  };

  const lines = (): ListRow[] =>
    rows.map((r) => {
      const words = estimateLine(promised.get(r.issue.number) ?? [], Date.now());
      return { title: `#${r.issue.number} ${r.issue.title}`, meta: words ?? "no estimate" };
    });

  const screen: Screen = {
    title: `${repo.ownerName}/${repo.name} — Estimates`,
    get keys() {
      return [
        binding(["j", "k"], "move cursor"),
        binding(["a"], "ask the base rate", { disabled: current() === undefined }),
        binding(["r"], "record an estimate", { disabled: !may() || current() === undefined }),
      ];
    },
    load(signal) {
      live(f, signal, { repoId: repo.id, kinds: LIVE_KINDS }, () => reload());
      reload();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [head, list] = split(area, "v", [len(2), fill(1)]);
      const note = !loaded
        ? "Loading…"
        : rows.length === 0
          ? "Nothing is ready to estimate."
          : `a asks the base rate for the issue under the cursor${may() ? ", r records an estimate" : "; you can read estimates, not record them"}`;
      s.text(head!.x, head!.y, truncate(note, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const said = asked === undefined ? "" : `#${asked.number}: ${asked.base.basis}`;
      s.text(head!.x, head!.y + 1, truncate(said, head!.w), style(c.fg, c.bg), head!.x + head!.w);
      drawList(s, list!, c, state, lines());
    },
    key(e) {
      if (state.key(e, rows.length)) return true;
      if (e.ctrl || e.alt) return false;
      if (e.key === "a") ask();
      else if (e.key === "r") record();
      else return false;
      return true;
    },
  };
  return screen;
}
