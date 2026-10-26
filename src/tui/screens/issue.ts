/**
 * One issue: the conversation, the composer, and the state and label changes
 * a participant is allowed to make.
 *
 * The conversation comes from the `RepoSource`, so the same screen reads an
 * issue we hold and one on another forge — and the composer and the state
 * keys simply do not exist on the second, because `capabilities.write` is
 * false and there is no method on that source that could write anyway.
 *
 * On a repository we hold it subscribes to the event bus while it is on the
 * stack, so a comment posted from the web (or by another terminal) appears
 * without a keypress. The subscription is released by the screen's own abort
 * signal — popping the screen is what unsubscribes it, with no lifecycle
 * hook needed.
 */

import {
  addCommentThrough,
  setIssueLabelsThrough,
  setIssueStateThrough,
} from "../../actions/issues.ts";
import { ISSUE_TEAMS_SAY, nameTeams } from "../../actions/issue_teams.ts";
import { teamsOfIssue, TEAMS_MAX } from "../../core/issue_teams.ts";
import { listTeams } from "../../core/teams.ts";
import { listRepoRuns } from "../../actions/runs.ts";
import { privateRepoForSealed } from "../../actions/repos.ts";
import { alreadyDone } from "../../core/done_on_main.ts";
import { hasPicture } from "../../core/note_pictures.ts";
import { getIssue, type Issue, type Label } from "../../core/issues.ts";
import type { Repo } from "../../core/repos.ts";
import type { IssueDetail, RepoSource } from "../../view/source.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Span } from "../term/screen.ts";
import { BOLD, style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { card, dot, labelChip } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  ORIGIN_MARK,
  Scroll,
  ago,
  drawLines,
  hitScroll,
  errorText,
  live,
  pickerScreen,
  plural,
  runAsync,
} from "./common.ts";
import { assignPicker, assignedText } from "./assign.ts";
import { liveBindings, liveKey } from "./mirror.ts";
import { RunList, openRunLog } from "./runlist.ts";
import { Composer, threadLines, type ThreadEntry } from "./thread.ts";
import { local, localRepo, whereRows, whereStrip } from "./where.ts";

/** The crew card shows this many runs before it scrolls. */
const CREW_ROWS = 4;

/** The terminal's clone URL for a repository, from the forge's own origin. */
export function cloneUrl(f: Session, repo: Repo): string {
  const config = f.app.config;
  const origin = config.url ?? `http://${config.host ?? "localhost"}:${config.port ?? 3000}`;
  return `${origin.replace(/\/+$/, "")}/${repo.ownerName}/${repo.name}.git`;
}

/** The refusals of the private repository, in the web page's words. */
const PRIVATE_SAY: Record<string, string> = {
  not_sealed: "This report is not sealed: its fix can be worked in the open.",
  unverified: "Verify your email first: the private repository is for verified writers.",
};

/** The status-line tail for an issue the crew found done on main. */
export function doneText(commits: readonly string[], canClose: boolean): string {
  if (commits.length === 0) return "";
  const shas = commits.map((o) => o.slice(0, 7)).join(", ");
  return ` · done on main in ${shas}${canClose ? ", x to close" : ""}`;
}

export function issueScreen(
  f: Session,
  ctx: Ctx,
  src: RepoSource,
  number: number,
  keep: { top?: number } = {},
): Screen {
  let detail: IssueDetail | undefined;
  let labels: Label[] = [];
  let lines: Span[][] = [];
  let width = 0;
  const scroll = new Scroll();
  const composer = new Composer();
  const repo = localRepo(src);
  /** The local row — who it is assigned to. Undefined on a live browse. */
  let issueRow: Issue | undefined;
  /** The commits the crew found this issue done by on main; `x` closes it. */
  let doneBy: readonly string[] = [];
  /** What the crew has done here, newest first; a card when there is any. */
  const crew = new RunList(f);
  /** Which pane `j`/`k`/`enter` belong to; `tab` moves between them. */
  let focus: "thread" | "crew" = "thread";
  /** The private repository made for this sealed report, shown until we leave. */
  let privateNote: string | undefined;
  const mayWrite = (): boolean => src.capabilities.write && repo !== undefined;
  scroll.top = keep.top ?? 0;

  const reload = async (): Promise<void> => {
    const read = await src.issue(number);
    if (!read.ok) {
      ctx.toast(errorText(read.error), "danger");
      ctx.pop();
      return;
    }
    detail = read.value;
    issueRow = repo === undefined ? undefined : getIssue(f.db, repo.id, number);
    const runs =
      repo === undefined || issueRow === undefined
        ? undefined
        : listRepoRuns(f.app, f.user, repo, {
            kind: "agent",
            issueId: issueRow.id,
            limit: 50,
          });
    doneBy =
      issueRow?.state === "open"
        ? (alreadyDone(f.db, [issueRow.id]).get(issueRow.id) ?? [])
        : [];
    crew.set(runs !== undefined && runs.ok ? runs.value : []);
    if (crew.runs.length === 0) focus = "thread";
    width = 0;
    ctx.invalidate();
    const listed = await src.labels();
    labels = listed.ok ? listed.value : [];
  };

  /** The path of the picture a note sent with this issue, when it has one. */
  const pictureText = (): string =>
    repo !== undefined && issueRow !== undefined && hasPicture(f.db, repo.id, issueRow.number)
      ? ` · picture: /${repo.ownerName}/${repo.name}/issues/${issueRow.number}/picture`
      : "";

  /** `a` — hand the issue to a person, an agent, or nobody. */
  const assign = (): void => {
    if (repo === undefined || issueRow === undefined) return;
    assignPicker(f, ctx, screen, repo, issueRow, () => runAsync(ctx, reload));
  };

  const openRun = (): void => {
    const run = crew.selected;
    if (run !== undefined && repo !== undefined)
      openRunLog(f, ctx, repo, run);
  };

  /** The core row a write needs. Only ever reached on a local source. */
  const row = ():
    | { repo: Repo; issue: ReturnType<typeof getIssue> }
    | undefined =>
    repo === undefined
      ? undefined
      : { repo, issue: getIssue(f.db, repo.id, number) };

  // An imported author is the login on the *origin*, so it is shown in place
  // of the local one and marked with the upstream glyph — a name from another
  // forge must never be mistaken for an account here.
  const who = (name: string, origin: string | null): string =>
    origin === null || origin === "" ? name : `${ORIGIN_MARK} ${origin}`;

  const entries = (): ThreadEntry[] =>
    detail === undefined
      ? []
      : [
          {
            kind: "comment" as const,
            actor: who(detail.issue.authorName, detail.issue.originAuthor),
            at: detail.issue.createdAt,
            body: detail.body === "" ? "_No description._" : detail.body,
            ...(detail.issue.originUrl === null
              ? {}
              : { note: detail.issue.originUrl }),
          },
          ...detail.comments.map((comment) => ({
            kind: "comment" as const,
            actor: who(comment.authorName, comment.originAuthor),
            at: comment.createdAt,
            body: comment.body,
          })),
        ];

  // The `…Through` twins: identical on a native repo, and on a mirror they
  // write to the origin first and reflect what came back.
  const submit = (): void => {
    const at = row();
    if (at?.issue === undefined) return;
    const { repo: target, issue } = at;
    const body = composer.value;
    runAsync(ctx, async () => {
      const added = await addCommentThrough(f.app, f.user, target, issue, body);
      if (!added.ok) {
        ctx.toast(errorText(added.error), "danger");
        return;
      }
      composer.close();
      await reload();
      ctx.toast("comment posted", "success");
    });
  };

  const setState = (state: "open" | "closed"): void => {
    const at = row();
    if (at?.issue === undefined) return;
    const { repo: target, issue } = at;
    runAsync(ctx, async () => {
      const changed = await setIssueStateThrough(
        f.app,
        f.user,
        target,
        issue,
        state,
      );
      if (!changed.ok) ctx.toast(errorText(changed.error), "danger");
      else {
        await reload();
        ctx.toast(state === "closed" ? "closed" : "reopened", "success");
      }
    });
  };

  /** `p` — the private repository to fix this sealed report in. */
  const privateRepo = (): void => {
    const at = row();
    if (at?.issue === undefined) return;
    const { repo: target, issue } = at;
    runAsync(ctx, async () => {
      const made = await privateRepoForSealed(f.app, f.user, target, issue);
      if (!made.ok) {
        ctx.toast(PRIVATE_SAY[made.error] ?? errorText(made.error), "danger");
        return;
      }
      const there = `${made.value.ownerName}/${made.value.name}`;
      privateNote = `private repository ${there} · clone ${cloneUrl(f, made.value)} · open the pull from there, saying "Closes #${number}"`;
      width = 0;
      ctx.invalidate();
      ctx.toast(`private repository ${there}`, "success");
    });
  };

  const screen: Screen = {
    title: `#${number}`,
    get keys() {
      return [
        ...(crew.runs.length > 0
          ? [binding(["tab"], "conversation/crew")]
          : []),
        focus === "crew"
          ? binding(["enter"], "open the run")
          : binding(["j", "k"], "scroll"),
        ...(mayWrite()
          ? [
              binding(["c"], "comment"),
              binding(["a"], "assign"),
              binding(["x"], "close", {
                disabled: detail?.issue.state === "closed",
              }),
              binding(["o"], "reopen", {
                disabled: detail?.issue.state !== "closed",
              }),
              binding(["l"], "labels"),
              binding(["t"], "teams"),
              ...(issueRow?.sealed === true
                ? [binding(["p"], "private repo")]
                : []),
            ]
          : liveBindings(src)),
        binding(["r"], "refresh"),
      ];
    },
    load(signal) {
      // Live: any event touching this repo invalidates what we are showing.
      if (repo !== undefined)
        live(f, signal, { repoId: repo.id }, () => runAsync(ctx, reload));
      return reload();
    },
    render(area, s) {
      const c = ctx.theme.c;
      if (!detail) return;
      const issue = detail.issue;
      const foot = composer.height();
      // The where-strip, then three rows of head: the title, the summary
      // line, and one blank so the first entry is not glued to the metadata.
      // Then the crew card, only when an agent has worked here.
      const crewH =
        crew.runs.length === 0 ? 0 : Math.min(crew.runs.length, CREW_ROWS) + 2;
      const [strip, head, crewRow, body, box] = split(area, "v", [
        len(whereRows(src)),
        len(3),
        len(crewH),
        fill(1),
        len(Math.min(foot, Math.max(0, area.h - 7 - crewH - whereRows(src)))),
      ]);
      whereStrip(s, strip!, c, f, src);
      const right = head!.x + head!.w;
      let x = s.text(
        head!.x,
        head!.y,
        `#${issue.number} `,
        style(c.mutedFg, c.bg),
        right,
      );
      s.text(
        x,
        head!.y,
        truncate(issue.title, Math.max(0, right - x)),
        style(c.fg, c.bg, BOLD),
        right,
      );
      const closed = issue.state !== "open";
      x = dot(s, head!.x, head!.y + 1, c, {
        tone: closed ? "danger" : "success",
      });
      x = s.text(
        x,
        head!.y + 1,
        truncate(
          ` ${issue.state} · opened by ${who(issue.authorName, issue.originAuthor)} ${ago(issue.createdAt)} · ${plural(detail.comments.length, "comment")}${assignedText(issueRow, ctx.icons)}${doneText(doneBy, mayWrite())}${pictureText()}`,
          Math.max(0, right - x),
        ),
        style(c.mutedFg, c.bg),
        right,
      );
      for (const label of issue.labels)
        x = labelChip(
          s,
          x + 1,
          head!.y + 1,
          c,
          { text: label.name, color: label.color },
          right,
        );
      // The teams that review the closing pull, shown to every reader.
      const named = issueRow === undefined ? [] : teamsOfIssue(f.db, issueRow.id);
      if (named.length > 0) {
        const names = new Map(listTeams(f.db).map((t) => [t.slug, t.name]));
        s.text(
          x + 1,
          head!.y + 1,
          truncate(`teams: ${named.map((t) => names.get(t) ?? t).join(", ")}`, Math.max(0, right - x - 1)),
          style(c.mutedFg, c.bg),
          right,
        );
      }
      if (crewH > 0) {
        const inner = card(s, crewRow!, c, {
          title: `Crew · ${plural(crew.runs.length, "run")}`,
          focused: focus === "crew",
        });
        crew.render(s, inner, c, ctx, focus === "crew", (run) => {
          focus = "crew";
          if (repo !== undefined) openRunLog(f, ctx, repo, run);
        });
      }

      if (width !== body!.w) {
        width = body!.w;
        lines = threadLines(entries(), Math.max(20, body!.w - 1), c);
      }
      // An empty conversation says how to start one, where the next entry
      // would have gone — but not while the composer is already open.
      const hint =
        detail.comments.length === 0 && !composer.open
          ? [
              [
                {
                  text: mayWrite()
                    ? "c  comment"
                    : src.capabilities.mirror
                      ? "read-only · m mirrors this repository into your workbench"
                      : "sign in to comment",
                  style: style(c.faint, c.bg),
                },
              ],
            ]
          : [];
      const note =
        privateNote === undefined
          ? []
          : threadLines(
              [{ kind: "comment" as const, actor: "private repository", at: new Date().toISOString(), body: privateNote }],
              Math.max(20, body!.w - 1),
              c,
            );
      const all = [...lines, ...hint, ...note];
      drawLines(s, body!, c, scroll, all);
      hitScroll(ctx, body!, scroll, all.length);
      if (foot > 0) composer.render(s, box!, c, ctx);
    },
    paste: (text) => composer.paste(text),
    key(e) {
      if (composer.open) {
        const out = composer.key(e);
        if (out === "submit") submit();
        else if (out === "cancel") composer.close();
        return true;
      }
      if (e.key === "tab" && crew.runs.length > 0) {
        focus = focus === "thread" ? "crew" : "thread";
        return true;
      }
      if (focus === "crew") {
        if (crew.state.key(e, crew.runs.length)) return true;
        if (e.key === "enter") {
          openRun();
          return true;
        }
      }
      if (e.key === "a" && mayWrite()) {
        assign();
        return true;
      }
      if (e.key === "c" && mayWrite()) {
        composer.start("Comment");
        return true;
      }
      if (e.key === "x" && mayWrite()) {
        setState("closed");
        return true;
      }
      if (e.key === "o" && mayWrite()) {
        setState("open");
        return true;
      }
      if (e.key === "l" && mayWrite()) {
        const at = row();
        if (at?.issue === undefined) return true;
        const { repo: target, issue } = at;
        ctx.push(
          pickerScreen(ctx, screen, {
            title: "Labels",
            multi: true,
            items: labels.map((l) => ({ id: l.id, label: l.name })),
            chosen: (detail?.issue.labels ?? []).map((l) => l.id),
            onPick: (ids) => {
              runAsync(ctx, async () => {
                const applied = await setIssueLabelsThrough(
                  f.app,
                  f.user,
                  target,
                  issue,
                  ids,
                );
                if (!applied.ok) ctx.toast(errorText(applied.error), "danger");
                else await reload();
              });
            },
          }),
        );
        return true;
      }
      if (e.key === "t" && mayWrite()) {
        const at = row();
        if (at?.issue === undefined) return true;
        const { repo: target, issue } = at;
        ctx.push(
          pickerScreen(ctx, screen, {
            title: `Teams (at most ${TEAMS_MAX})`,
            multi: true,
            items: listTeams(f.db).map((t) => ({ id: t.slug, label: t.name })),
            chosen: teamsOfIssue(f.db, issue.id),
            onPick: (slugs) => {
              const set = nameTeams(f.app, f.user, target, issue, slugs);
              if (!set.ok) ctx.toast(ISSUE_TEAMS_SAY[set.error] ?? errorText(set.error), "danger");
              else ctx.toast(set.value.length === 0 ? "teams cleared" : `teams: ${set.value.join(", ")}`, "success");
            },
          }),
        );
        return true;
      }
      if (e.key === "p" && mayWrite()) {
        privateRepo();
        return true;
      }
      if (e.key === "r") {
        runAsync(ctx, reload);
        return true;
      }
      if (
        liveKey(f, ctx, e, src, {
          parent: screen,
          onDone: (next) =>
            ctx.replace(
              issueScreen(f, ctx, local(f, next), number, { top: scroll.top }),
            ),
        })
      )
        return true;
      return scroll.key(e, lines.length);
    },
  };
  return screen;
}
