/**
 * What the Later gate holds, from the terminal (#8700): the held page's twin.
 * The same reads (`reviewGate`, `reviewedClosed`) and the same actions
 * (`liftHold`, `applyGateReview`) the page and the MCP tools use, so who may
 * see and who may change is theirs: a repository the viewer cannot read is
 * not found, and only a writer who is not an agent applies. The list is live;
 * a change to what the gate holds resets the ticks, so what is approved is
 * always what is shown.
 *
 *   space  tick or untick a candidate     A  apply the ticked (close or merge)
 *   l      lift (or revive, on a closed)  enter  open the issue
 */

import { liftHold } from "../../actions/gate.ts";
import { applyGateReview, reviewGate, type GateReview } from "../../actions/gate_review.ts";
import { THREAD_SAYS } from "../../actions/thread_words.ts";
import { reviewedClosed } from "../../core/gate_hold.ts";
import { getIssue } from "../../core/issues.ts";
import { tallyLine } from "../../core/gate_triage.ts";
import { pillarsOf } from "../../core/pillars.ts";
import type { Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { ListState, drawList, hitList, live, metaOf, runAsync, type ListRow } from "./common.ts";
import { issueScreen } from "./issue.ts";
import { local } from "./where.ts";
import { emptyState } from "../ui/widgets.ts";

/** One line of the screen: a candidate, or an issue the review closed. */
export interface HeldLine {
  readonly number: number;
  readonly title: string;
  readonly theme: string;
  readonly why: string;
  readonly waiting: number;
  readonly closed: boolean;
  /** Proposed to stay behind the gate: nothing to tick. */
  readonly keep: boolean;
}

export interface HeldRead {
  readonly review: GateReview;
  readonly lines: readonly HeldLine[];
}

/** The gate's candidates and what it closed, or nothing where the repository has no gate. */
export function readHeld(f: Session, repo: Repo): HeldRead | undefined {
  const review = reviewGate(f.app, repo);
  if (review === undefined) return undefined;
  const lines: HeldLine[] = review.themes.flatMap((t) =>
    t.items.map((i) => ({
      number: i.number,
      title: i.title,
      theme: `${t.name} · ${tallyLine(t.items)}`,
      why: i.verdict.why,
      waiting: i.waiting,
      closed: false,
      keep: i.verdict.kind === "keep",
    })),
  );
  for (const i of reviewedClosed(f.db, repo, pillarsOf(f.db, repo)))
    lines.push({ number: i.number, title: i.title, theme: "Closed by the review", why: "revive with l", waiting: 0, closed: true, keep: false });
  return { review, lines };
}

/** One row per line; a candidate shows its tick, a flagged one says closing parks work. */
export function heldRows(lines: readonly HeldLine[], ticked: ReadonlySet<number>): ListRow[] {
  return lines.map((l) => ({
    title: `${l.closed ? "   " : l.keep ? "[-]" : ticked.has(l.number) ? "[x]" : "[ ]"} #${l.number} ${l.title}`,
    meta: metaOf(
      l.theme,
      l.why,
      l.waiting > 0 ? `${l.waiting} open waits for it: closing parks it` : "",
    ),
  }));
}

export function heldScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  let read: HeldRead | undefined;
  let ticked = new Set<number>();
  const lines = (): readonly HeldLine[] => read?.lines ?? [];
  const reload = (): void => {
    const next = readHeld(f, repo);
    if (next?.review.digest !== read?.review.digest) ticked = new Set(next?.review.ticked ?? []);
    read = next;
    state.clamp(lines().length);
    ctx.invalidate();
  };
  const lift = (index: number): void => {
    const line = lines()[index];
    if (line === undefined) return;
    const issue = getIssue(f.db, repo.id, line.number);
    if (issue === undefined) return;
    const done = liftHold(f.app, f.user, repo, issue);
    if (done.ok) ctx.toast(`#${line.number} is lifted from behind the Later gate.`, "success");
    else ctx.toast(done.error === "not_held" ? `#${line.number} is not behind the Later gate.` : THREAD_SAYS.planForbidden, "danger");
    reload();
  };
  const apply = (): void => {
    if (read === undefined) return;
    if (f.user === undefined) return void ctx.toast("Sign in first.", "danger");
    const user = f.user;
    const digest = read.review.digest;
    const numbers = [...ticked].filter((n) => !lines().some((l) => l.number === n && l.keep));
    runAsync(ctx, async () => {
      const done = applyGateReview(f.app, user, repo, numbers, digest);
      if (done.ok) ctx.toast(`Closed or merged ${done.value}.`, "success");
      else
        ctx.toast(
          done.error === "stale"
            ? "What the gate holds changed since you read it. Nothing was changed."
            : done.error === "forbidden"
              ? THREAD_SAYS.planForbidden
              : "There is no Later gate here.",
          "danger",
        );
      reload();
    });
  };
  const openAt = (index: number): void => {
    const line = lines()[index];
    if (line !== undefined) ctx.push(issueScreen(f, ctx, local(f, repo), line.number));
  };
  const toggle = (index: number): void => {
    const line = lines()[index];
    if (line === undefined || line.closed || line.keep) return;
    if (!ticked.delete(line.number)) ticked.add(line.number);
    ctx.invalidate();
  };
  return {
    title: `Held · ${repo.ownerName}/${repo.name}`,
    keys: [
      binding(["j", "k"], "move"),
      binding(["space"], "tick"),
      binding(["A"], "apply the ticked"),
      binding(["l"], "lift / revive"),
      binding(["enter"], "open"),
      binding(["esc", "q"], "close"),
    ],
    load(signal) {
      live(f, signal, { repoId: repo.id }, () => runAsync(ctx, async () => reload()));
      reload();
      return Promise.resolve();
    },
    render(area, s) {
      if (read === undefined) {
        emptyState(s, area, ctx.theme.c, { title: "No Later gate", body: "This repository holds nothing back." });
        return;
      }
      drawList(s, area, ctx.theme.c, state, heldRows(lines(), ticked));
      hitList(ctx, area, state, lines().length, { open: openAt });
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === " " || e.key === "space") toggle(state.index);
      else if (e.key === "A") apply();
      else if (e.key === "l") lift(state.index);
      else if (e.key === "enter") openAt(state.index);
      else state.key(e, lines().length);
      return true;
    },
  };
}
