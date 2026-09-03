/**
 * The issue list — and, with `kind: "pull"`, the pull list, because a pull is
 * an issue with a diff and the list of them differs only in what a row's
 * state badge can say.
 *
 * Filters compose the way the API's do: state segment, label, author, and a
 * text search, all folded into the one `issues()` question the `RepoSource`
 * answers — so the same screen lists what we hold and what another forge
 * holds, and the TUI can never show a set the JSON surface could not.
 */

import { openIssueThrough } from "../../actions/issues.ts";
import type { IssueKind, Label } from "../../core/issues.ts";
import { mergedPullNumbers } from "../../core/pulls.ts";
import type { Repo } from "../../core/repos.ts";
import type { IssueSummary, RepoFacts, RepoSource } from "../../view/source.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { Textarea } from "../ui/textarea.ts";
import { fill, len, split } from "../ui/layout.ts";
import { card, emptyState, field, segmented } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  Filter,
  ListState,
  ORIGIN_MARK,
  commentsMeta,
  metaOf,
  drawList,
  errorText,
  hitList,
  live,
  pickerScreen,
  relTime,
  runAsync,
  type ListRow,
} from "./common.ts";
import { issueScreen } from "./issue.ts";
import { newPullScreen } from "./newpull.ts";
import { pullScreen } from "./pull.ts";
import {
  local,
  localRepo,
  sourceName,
  whereRows,
  whereStrip,
} from "./where.ts";

const STATES = ["open", "closed", "all"] as const;
const PAGE = 40;

export function issuesScreen(
  f: Session,
  ctx: Ctx,
  src: RepoSource,
  kind: IssueKind,
): Screen {
  let items: IssueSummary[] = [];
  let labels: Label[] = [];
  let facts: RepoFacts | undefined;
  let cursor: string | undefined;
  let more = false;
  /** Nothing says "no issues" before the first page has actually answered. */
  let loaded = false;
  let segment = 0;
  let label: string | undefined;
  let mine = false;
  const state = new ListState();
  const search = new Filter();
  const repo = localRepo(src);
  // A count is shown only once it is known for certain: a segment whose page
  // ended is exactly as long as what is on screen, and nothing else here is
  // allowed to guess.
  const counted = new Map<string, number>();
  /**
   * Which of these pulls landed. `IssueSummary` cannot say — the shape has no
   * `mergedAt` — so on a repository we hold the row is asked directly. A live
   * browse shows "closed", which is all the origin's list endpoint says too.
   */
  const merged = new Set<number>();
  const markMerged = (rows: readonly IssueSummary[]): void => {
    if (repo === undefined || kind !== "pull") return;
    // One query for the page, addressed the way the list has them: by
    // number. `getPull` per row was a query per row on the hottest list.
    for (const number of mergedPullNumbers(
      f.db,
      repo.id,
      rows.map((row) => row.number),
    ))
      merged.add(number);
  };

  const query = (at?: string): Parameters<RepoSource["issues"]>[0] => ({
    kind,
    state: STATES[segment]!,
    ...(label === undefined ? {} : { label }),
    ...(mine && f.user ? { author: f.user.username } : {}),
    ...(at === undefined ? {} : { cursor: at }),
    limit: PAGE,
  });

  const take = async (at?: string): Promise<IssueSummary[]> => {
    const page = await src.issues(query(at));
    if (!page.ok) {
      ctx.toast(errorText(page.error), "danger");
      more = false;
      return [];
    }
    cursor = page.value.next ?? undefined;
    more = page.value.next !== null;
    return [...page.value.items];
  };

  const reload = async (): Promise<void> => {
    merged.clear();
    items = await take();
    loaded = true;
    markMerged(items);
    if (!more) counted.set(STATES[segment]!, items.length);
    state.clamp(items.length);
    ctx.invalidate();
    const [described, listed] = await Promise.all([
      src.describe(),
      src.labels(),
    ]);
    if (described.ok) {
      facts = described.value;
      const open = kind === "pull" ? facts.openPulls : facts.openIssues;
      if (open !== null) counted.set("open", open);
    }
    labels = listed.ok ? listed.value : [];
    ctx.invalidate();
  };

  const loadMore = (): void => {
    const at = cursor;
    if (at === undefined) return;
    runAsync(ctx, async () => {
      const page = await take(at);
      markMerged(page);
      items = [...items, ...page];
      if (!more) counted.set(STATES[segment]!, items.length);
      ctx.invalidate();
    });
  };

  const shown = (): IssueSummary[] =>
    items.filter(
      (i) => search.matches(i.title) || search.matches(`#${i.number}`),
    );

  const noun = kind === "pull" ? "pull request" : "issue";
  const mayWrite = (): boolean => src.capabilities.write && repo !== undefined;
  /** "Open 2" once we know, "Open" until then — never "Open 0" on a guess. */
  const tally = (which: (typeof STATES)[number], text: string): string => {
    const n = counted.get(which);
    return n === undefined ? text : `${text} ${n}`;
  };

  /**
   * `enter`, and a click, and the "Load more…" row past the end — one
   * function, so the pointer cannot open something the keyboard would not.
   */
  const openAt = (index: number): void => {
    const item = shown()[index];
    if (item === undefined) {
      loadMore();
      return;
    }
    ctx.push(
      kind === "pull"
        ? pullScreen(f, ctx, src, item.number)
        : issueScreen(f, ctx, src, item.number),
    );
  };

  const screen: Screen = {
    title: kind === "pull" ? "Pulls" : "Issues",
    get keys() {
      return [
        binding(["j", "k"], "move"),
        binding(["enter"], "open"),
        binding(["tab"], "open/closed/all"),
        binding(["l"], "label"),
        binding(["a"], mine ? "all authors" : "only mine"),
        ...(mayWrite() ? [binding(["c"], `new ${noun}`)] : []),
        binding(["/"], "search"),
        binding(["r"], "refresh"),
      ];
    },
    load(signal) {
      // A list of conversations is exactly the thing somebody else changes
      // while you look at it. Repo-scoped where we can be: a live browse has
      // no local repo id, and no local event can be about it.
      if (repo !== undefined)
        live(f, signal, { repoId: repo.id }, () => runAsync(ctx, reload));
      return reload();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [strip, seg, box, body] = split(area, "v", [
        len(whereRows(src)),
        len(1),
        len(1),
        fill(1),
      ]);
      whereStrip(s, strip!, c, f, src);
      const open = counted.get("open");
      const closed = counted.get("closed");
      segmented(s, seg!, c, {
        items: [
          tally("open", "Open"),
          tally("closed", "Closed"),
          open !== undefined && closed !== undefined
            ? `All ${open + closed}`
            : tally("all", "All"),
        ],
        active: segment,
      });
      const chips = [
        label === undefined ? "" : `label:${label}`,
        mine ? "author:me" : "",
      ]
        .filter((t) => t !== "")
        .join("  ");
      if (search.on) ctx.setCursor(search.render(s, box!, c, "search titles"));
      else
        s.text(
          box!.x,
          box!.y,
          truncate(chips, box!.w),
          style(c.accent, c.bg),
          box!.x + box!.w,
        );

      const rows = shown();
      if (rows.length === 0) {
        emptyState(s, body!, c, {
          title: loaded ? `No ${noun}s` : "Reading…",
          body: !loaded
            ? `Asking ${sourceName(src)}`
            : segment === 0
              ? `Nothing open in ${sourceName(src)}.`
              : "Nothing matches these filters.",
          ...(loaded && mayWrite() ? { action: `c  new ${noun}` } : {}),
        });
        return;
      }
      const list: ListRow[] = rows.map((item) => {
        return {
          title: item.title,
          state: merged.has(item.number)
            ? ("merged" as const)
            : item.state === "open"
              ? ("open" as const)
              : ("closed" as const),
          secondary: item.labels.map((l) => l.name).join(" "),
          // An imported row is the origin's author, marked as upstream: a
          // login from another forge must never read as an account here.
          meta: metaOf(
            `#${item.number} ${
              item.originAuthor === null || item.originAuthor === ""
                ? item.authorName
                : `${ORIGIN_MARK} ${item.originAuthor}`
            } ${relTime(item.updatedAt)}`,
            commentsMeta(item.commentCount, ctx.icons),
          ),
        };
      });
      if (more) list.push({ title: "Load more…" });
      drawList(s, body!, c, state, list);
      hitList(ctx, body!, state, list.length, { open: openAt });
    },
    key(e) {
      if (search.active) {
        const handled = search.key(e);
        if (handled) state.clamp(shown().length);
        return handled;
      }
      const total = shown().length + (more ? 1 : 0);
      if (state.key(e, total)) return true;
      if (e.key === "/") {
        search.open();
        return true;
      }
      if (e.key === "tab") {
        segment = (segment + 1) % STATES.length;
        cursor = undefined;
        runAsync(ctx, reload);
        return true;
      }
      if (e.key === "a") {
        mine = !mine;
        counted.clear();
        cursor = undefined;
        runAsync(ctx, reload);
        return true;
      }
      if (e.key === "l") {
        ctx.push(
          pickerScreen(ctx, screen, {
            title: "Filter by label",
            items: [
              { id: "", label: "(any label)" },
              ...labels.map((l) => ({ id: l.name, label: l.name })),
            ],
            onPick: (ids) => {
              label = ids[0] === "" ? undefined : ids[0];
              counted.clear();
              cursor = undefined;
              runAsync(ctx, reload);
            },
          }),
        );
        return true;
      }
      if (e.key === "enter") {
        openAt(state.index);
        return true;
      }
      if (e.key === "c" && mayWrite() && repo !== undefined) {
        ctx.push(
          kind === "pull"
            ? newPullScreen(f, ctx, repo)
            : newIssueScreen(f, ctx, repo),
        );
        return true;
      }
      if (e.key === "r") {
        cursor = undefined;
        counted.clear();
        runAsync(ctx, reload);
        return true;
      }
      return false;
    },
  };
  return screen;
}

export function newIssueScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  let title = "";
  const body = new Textarea("");
  let focus: "title" | "body" = "title";
  let error: string | undefined;

  const submit = (): void => {
    const values = { title, body: body.value };
    // The `…Through` twin: on a mirror the origin creates the issue, so the
    // number this screen jumps to is the origin's own.
    runAsync(ctx, async () => {
      const created = await openIssueThrough(f.app, f.user, repo, values);
      if (!created.ok) {
        // The input is never cleared: a rejected form keeps everything typed.
        error = errorText(created.error);
        ctx.toast(error, "danger");
        return;
      }
      ctx.toast(`opened #${created.value.number}`, "success");
      ctx.replace(issueScreen(f, ctx, local(f, repo), created.value.number));
    });
  };

  return {
    title: "New issue",
    keys: [
      binding(["tab"], "next field"),
      binding(["ctrl+d"], "open issue"),
      binding(["esc"], "discard"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      const [top, rest] = split(area, "v", [len(4), fill(1)]);
      const cursor = field(s, top!, c, {
        label: "Title",
        value: title,
        focused: focus === "title",
        ...(focus === "title" ? { cursor: [...title].length } : {}),
        ...(error === undefined
          ? { hint: "One line, imperative mood." }
          : { error }),
      });
      const inner = card(s, rest!, c, {
        title: "Description",
        footer: "ctrl+d submit",
        focused: focus === "body",
      });
      const bodyCursor = body.render(s, inner, c, focus === "body");
      ctx.setCursor(focus === "title" ? cursor : bodyCursor);
    },
    paste(text) {
      if (focus === "body") body.paste(text);
      else title += text.replace(/\s+/g, " ");
      return true;
    },
    key(e) {
      if (e.ctrl && e.key === "d") {
        submit();
        return true;
      }
      if (e.key === "tab") {
        focus = focus === "title" ? "body" : "title";
        return true;
      }
      if (focus === "body") {
        const out = body.key(e);
        if (out === "submit") {
          submit();
          return true;
        }
        if (out === "cancel") return false;
        return out !== "ignored";
      }
      if (e.key === "enter") {
        focus = "body";
        return true;
      }
      if (e.key === "backspace") {
        title = [...title].slice(0, -1).join("");
        error = undefined;
        return true;
      }
      if (!e.ctrl && !e.alt && [...e.key].length === 1) {
        title += e.key;
        error = undefined;
        return true;
      }
      return false;
    },
  };
}
