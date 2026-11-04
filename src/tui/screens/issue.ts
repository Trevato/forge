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

import { putFlowFirst } from "../../actions/flow_first.ts";
import { FLOW_LABEL } from "../../core/flow_label.ts";
import {
  addCommentThrough,
  editIssue,
  mayEditIssue,
  setIssueLabelsThrough,
  setIssueStateThrough,
  setIssueSealed,
  TAKEN_UP,
} from "../../actions/issues.ts";
import { sealedWords, sealRefusedWords } from "../../actions/seal_issue_words.ts";
import {
  dependencyWords,
  linkIssue,
  unlinkIssue,
} from "../../actions/dependencies.ts";
import { THREAD_SAYS } from "../../actions/thread_words.ts";
import { ISSUE_TEAMS_SAY, nameTeams } from "../../actions/issue_teams.ts";
import { teamsOfIssue, TEAMS_MAX } from "../../core/issue_teams.ts";
import { listTeams } from "../../core/teams.ts";
import { listRepoRuns } from "../../actions/runs.ts";
import { readPlan } from "../../actions/run_plan.ts";
import type { IssuePlan } from "../../core/issue_plans.ts";
import { shownStates } from "../../runs/state.ts";
import { headline, planLines, planTitle } from "./runplan.ts";
import { privateRepoForSealed } from "../../actions/repos.ts";
import { confirmIssue } from "../../actions/dependencies.ts";
import { isCrew } from "../../core/agents.ts";
import { dependenciesOf, heldBlockers } from "../../core/dependencies.ts";
import { alreadyDone } from "../../core/done_on_main.ts";
import { hasPicture } from "../../core/note_pictures.ts";
import { isMirror } from "../../origins/write-through.ts";
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
  confirmScreen,
  drawLines,
  hitScroll,
  errorText,
  later,
  live,
  pickerScreen,
  plural,
  promptScreen,
  runAsync,
} from "./common.ts";
import { assignPicker, assignedText } from "./assign.ts";
import { liveBindings, liveKey } from "./mirror.ts";
import { RunList, maySteer, openRunLog, steerPrompt } from "./runlist.ts";
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

/** The refusals of an edit, in the action's and the page's words. */
const EDIT_SAY: Record<string, string> = {
  forbidden: "only the author, or a person who writes here, edits this",
  taken_up: TAKEN_UP,
  body_too_long: "that description is too long",
};

/**
 * An issue's words as the editor holds them: the title on the first line,
 * a blank line, then the body — the shape of a commit message.
 */
export function editText(title: string, body: string): string {
  return body === "" ? title : `${title}\n\n${body}`;
}

/** The editor's text back into a title and a body. */
export function readEditText(text: string): { title: string; body: string } {
  const [first = "", ...rest] = text.replace(/\r\n?/g, "\n").split("\n");
  return { title: first.trim(), body: rest.join("\n").replace(/^\n+/, "").trimEnd() };
}

/** What an issue waits for and holds up, by number, ascending. */
export interface Waits {
  readonly blockedBy: readonly number[];
  readonly blocks: readonly number[];
}

/** The waits line's parts: plain words, and the numbers a click opens. */
export function waitsParts(waits: Waits): { text: string; opens?: number }[] {
  const parts: { text: string; opens?: number }[] = [];
  const run = (words: string, numbers: readonly number[]): void => {
    if (numbers.length === 0) return;
    if (parts.length > 0) parts.push({ text: " · " });
    parts.push({ text: `${words} ` });
    numbers.forEach((n, i) => {
      if (i > 0) parts.push({ text: ", " });
      parts.push({ text: `#${n}`, opens: n });
    });
  };
  run("Waits for", waits.blockedBy);
  run("Holds up", waits.blocks);
  return parts;
}

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
  /** Closed-as-dropped-or-split blockers nobody has said may be passed. */
  let held: Issue[] = [];
  let plan: IssuePlan | undefined;
  let shown: ReturnType<typeof headline>;
  /** Which issues this one waits for and holds up; a line when any. */
  let waits: Waits = { blockedBy: [], blocks: [] };
  /** What the crew has done here, newest first; a card when there is any. */
  const crew = new RunList(f);
  /** Which pane `j`/`k`/`enter` belong to; `tab` moves between them. */
  let focus: "thread" | "crew" = "thread";
  /** The private repository made for this sealed report, shown until we leave. */
  let privateNote: string | undefined;
  /** The text `e` opened the editor with; set while the composer edits, not comments. */
  let editing: string | undefined;
  const mayWrite = (): boolean => src.capabilities.write && repo !== undefined;
  /** `g` is a person's: the crew parked the issue and may not unpark itself. */
  const mayGoAhead = (): boolean =>
    mayWrite() &&
    held.length > 0 &&
    f.user !== undefined &&
    repo !== undefined &&
    !isCrew(f.db, repo.id, f.user.id);
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
    held =
      issueRow?.state === "open" ? heldBlockers(f.db, issueRow.id) : [];
    const deps = issueRow === undefined ? undefined : dependenciesOf(f.db, issueRow.id);
    waits = {
      blockedBy: deps?.blockedBy.map((i) => i.number) ?? [],
      blocks: deps?.blocks.map((i) => i.number) ?? [],
    };
    crew.set(runs !== undefined && runs.ok ? runs.value : []);
    plan =
      repo === undefined || issueRow === undefined ? undefined : readPlan(f.app, repo, f.user, issueRow);
    const states = shownStates(f.db, runs !== undefined && runs.ok ? runs.value : []);
    shown = headline(runs !== undefined && runs.ok ? runs.value.map((r) => states.get(r.id)!) : []);
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

  /** Whether `editIssue` would take this person's words here: its own two tests. */
  const mayEdit = (): boolean =>
    repo !== undefined &&
    !isMirror(f.app, repo) &&
    issueRow !== undefined &&
    mayEditIssue(f.app, repo, issueRow, f.user).ok;

  /** `e` — the title and the body in the long-form editor. */
  const startEdit = (): void => {
    if (issueRow === undefined) return;
    editing = editText(issueRow.title, issueRow.body);
    composer.start(`Edit #${number} — first line is the title`, editing);
  };

  const stopEdit = (): void => {
    editing = undefined;
    composer.close();
  };

  /** `ctrl+d` in the editor. A refusal keeps the draft open, as typed. */
  const saveEdit = (): void => {
    const at = row();
    if (at?.issue === undefined) return;
    if (composer.value === editing) {
      stopEdit();
      return;
    }
    const edited = editIssue(f.app, f.user, at.repo, at.issue, readEditText(composer.value));
    if (!edited.ok) {
      ctx.toast(EDIT_SAY[edited.error] ?? errorText(edited.error), "danger");
      return;
    }
    stopEdit();
    runAsync(ctx, reload);
    ctx.toast("saved", "success");
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

  /** `g` — say the issue may go ahead without its dropped or split blockers. */
  const goAhead = (): void => {
    const at = row();
    if (at?.issue === undefined || held.length === 0) return;
    const { repo: target, issue } = at;
    const ask = (blockers: Issue[]): Screen => {
      const names = blockers.map((b) => `#${b.number}`).join(", ");
      return confirmScreen(ctx, screen, {
        title: "Let it go ahead?",
        body: [`#${issue.number} waited for ${names}, closed without being done.`],
        actions: [{ label: "Go ahead" }, { label: "Cancel" }],
        selected: 1,
        onChoose: (index) => {
          if (index !== 0) return;
          runAsync(ctx, async () => {
            for (const b of blockers) {
              const done = confirmIssue(f.app, f.user, target, issue, b);
              if (!done.ok) {
                ctx.toast(errorText(done.error), "danger");
                return;
              }
            }
            await reload();
            ctx.toast("may go ahead", "success");
          });
        },
      });
    };
    if (held.length === 1) {
      ctx.push(ask(held));
      return;
    }
    // Several held: name one, or all of them.
    const all = "all";
    const blockers = held;
    ctx.push(
      pickerScreen(ctx, screen, {
        title: "Go ahead without",
        items: [
          ...blockers.map((b) => ({
            id: String(b.number),
            label: `#${b.number} ${b.title}`,
            hint: b.closeReason ?? "closed",
          })),
          { id: all, label: "all of them" },
        ],
        onPick: (ids) => {
          const picked =
            ids[0] === all ? blockers : blockers.filter((b) => String(b.number) === ids[0]);
          if (picked.length > 0) void later(ctx, () => ask(picked));
        },
      }),
    );
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

  /** `S` — seal or unseal this report, after a confirm that says who will see it. */
  const seal = (): void => {
    const at = row();
    if (at?.issue === undefined) return;
    const { repo: target, issue } = at;
    const sealed = !issue.sealed;
    ctx.push(
      confirmScreen(ctx, screen, {
        title: sealed ? "Seal this report?" : "Unseal this report?",
        body: [
          sealed
            ? `Seal #${issue.number}? Only people who can write here and the crew will see it.`
            : `Unseal #${issue.number}? Everyone who can read ${target.ownerName}/${target.name} sees it and its fix.`,
        ],
        actions: [
          // Unsealing shows the report and its fix to every reader: the danger button.
          { label: sealed ? "Seal" : "Unseal", variant: sealed ? "default" : "danger" },
          { label: "Cancel", variant: "ghost" },
        ],
        selected: 1,
        width: 90,
        onChoose: (index) => {
          if (index !== 0) return;
          const done = setIssueSealed(f.app, f.user, target, issue, sealed);
          if (!done.ok) {
            ctx.toast(sealRefusedWords(done.error), "danger");
            return;
          }
          ctx.toast(sealedWords(sealed), "success");
          runAsync(ctx, reload);
        },
      }),
    );
  };

  /**
   * `w` — a number to wait for. A new one links it; one it already waits
   * for asks first, then stops the wait. Refusals in `dependencyWords`.
   */
  const waitFor = (): void => {
    const at = row();
    if (at?.issue === undefined) return;
    const { repo: target, issue } = at;
    const refused = (code: string): string =>
      dependencyWords[code] ?? (code === "forbidden" ? THREAD_SAYS.planForbidden : errorText(code));
    const settled = (said: string): void => {
      ctx.toast(said, "success");
      runAsync(ctx, reload);
    };
    ctx.push(
      promptScreen(ctx, screen, {
        title: "Waits for",
        label: `#${number} waits for issue`,
        placeholder: "12",
        hint:
          waits.blockedBy.length === 0
            ? "the number of the issue that must land first"
            : "a number it already waits for stops the wait",
        onSubmit: (value) => {
          const n = Number(value.replace(/^#/, ""));
          if (!Number.isInteger(n) || n <= 0) return "an issue number, like 12";
          const blocker = getIssue(f.db, target.id, n);
          if (blocker === undefined) return `no #${n} here`;
          // Asked now, not from the last reload: another door may have
          // linked or unlinked since.
          const waiting = dependenciesOf(f.db, issue.id).blockedBy.some((i) => i.id === blocker.id);
          if (waiting)
            return later(ctx, () =>
              confirmScreen(ctx, screen, {
                title: `Stop waiting for #${n}?`,
                body: [`#${number} no longer waits for #${n}.`],
                actions: [
                  { label: "Stop waiting", variant: "danger" },
                  { label: "Cancel", variant: "ghost" },
                ],
                onChoose: (choice) => {
                  if (choice !== 0) return;
                  const done = unlinkIssue(f.app, f.user, target, issue, blocker);
                  if (!done.ok) ctx.toast(refused(done.error), "danger");
                  else settled(`#${number} no longer waits for #${n}`);
                },
              }),
            );
          const done = linkIssue(f.app, f.user, target, issue, blocker);
          // A refusal another number could fix stays in the prompt; one
          // about who may plan here closes it and says so in full.
          if (!done.ok && done.error in dependencyWords) return refused(done.error);
          if (!done.ok) {
            ctx.toast(refused(done.error), "danger");
            return undefined;
          }
          settled(`#${number} waits for #${n}`);
          return undefined;
        },
      }),
    );
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
        ...(focus === "crew" && repo !== undefined && maySteer(f, repo, crew.selected)
          ? [binding(["s"], "steer")]
          : []),
        ...(mayWrite()
          ? [
              binding(["c"], "comment"),
              ...(mayEdit() ? [binding(["e"], "edit")] : []),
              binding(["a"], "assign"),
              binding(["x"], "close", {
                disabled: detail?.issue.state === "closed",
              }),
              binding(["o"], "reopen", {
                disabled: detail?.issue.state !== "closed",
              }),
              binding(["l"], "labels"),
              binding(["t"], "teams"),
              ...(mayGoAhead() ? [binding(["g"], "go ahead")] : []),
              binding(["w"], "waits for"),
              binding(["S"], issueRow?.sealed === true ? "unseal" : "seal"),
              ...(issueRow?.sealed === true
                ? [binding(["p"], "private repo")]
                : []),
              binding(["f"], "flow first"),
            ]
          : [
              ...(mayEdit() ? [binding(["e"], "edit")] : []),
              ...liveBindings(src),
            ]),
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
      const planRows = planLines(plan);
      const planH = planRows.length === 0 ? 0 : Math.min(planRows.length, CREW_ROWS + 2) + 2;
      const waitsLine = waitsParts(waits);
      const headH = waitsLine.length === 0 ? 3 : 4;
      const [strip, head, waitRow, crewRow, planRow, body, box] = split(area, "v", [
        len(whereRows(src)),
        len(headH),
        len(held.length === 0 ? 0 : 1),
        len(crewH),
        len(planH),
        fill(1),
        len(Math.min(foot, Math.max(0, area.h - 4 - headH - crewH - planH - whereRows(src) - (held.length === 0 ? 0 : 1)))),
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
      // What this waits for and holds up; each number opens that issue.
      let wx = head!.x;
      for (const part of waitsLine) {
        const start = wx;
        wx = s.text(
          wx,
          head!.y + 2,
          part.text,
          style(part.opens === undefined ? c.mutedFg : c.fg, c.bg),
          right,
        );
        const opens = part.opens;
        if (opens !== undefined && wx > start)
          ctx.hit({ x: start, y: head!.y + 2, w: wx - start, h: 1 }, () =>
            ctx.push(issueScreen(f, ctx, src, opens)),
          );
      }
      if (held.length > 0)
        s.text(
          waitRow!.x,
          waitRow!.y,
          truncate(
            `waits for ${held.map((b) => `#${b.number} (${b.closeReason ?? "closed"})`).join(", ")}, closed without being done${mayGoAhead() ? " · g lets it go ahead" : ""}`,
            waitRow!.w,
          ),
          style(c.fg, c.bg),
          waitRow!.x + waitRow!.w,
        );
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

      if (planH > 0 && plan !== undefined) {
        const inner = card(s, planRow!, c, { title: planTitle(plan, shown) });
        planRows.slice(0, inner.h).forEach((row, i) => {
          s.text(inner.x, inner.y + i, truncate(row, inner.w), style(c.fg, c.card), inner.x + inner.w);
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
        if (editing !== undefined) {
          if (out === "submit") saveEdit();
          else if (out === "cancel") stopEdit();
        } else if (out === "submit") submit();
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
        if (e.key === "s") {
          const run = crew.selected;
          if (run !== undefined && repo !== undefined && maySteer(f, repo, run))
            steerPrompt(f, ctx, screen, repo, run, () => runAsync(ctx, reload));
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
      if (e.key === "e" && mayEdit()) {
        startEdit();
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
      if (e.key === "f" && mayWrite()) {
        const at = row();
        if (at?.issue === undefined) return true;
        const { repo: target, issue } = at;
        const first = !(detail?.issue.labels ?? []).some((l) => l.name.toLowerCase() === FLOW_LABEL);
        runAsync(ctx, async () => {
          const applied = await putFlowFirst(f.app, f.user, target, issue, first);
          if (!applied.ok) ctx.toast(errorText(applied.error), "danger");
          else {
            ctx.toast(first ? "Flow first." : "No longer first.");
            await reload();
          }
        });
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
      if (e.key === "g" && mayGoAhead()) {
        goAhead();
        return true;
      }
      if (e.key === "w" && mayWrite()) {
        waitFor();
        return true;
      }
      if (e.key === "S" && mayWrite()) {
        seal();
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
