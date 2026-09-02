/**
 * The issue list — and, with `kind: "pull"`, the pull list, because a pull is
 * an issue with a diff and the list of them differs only in what a row's
 * state badge can say.
 *
 * Filters compose the way the API's do: state segment, label, author, and a
 * text search, all folded into the same `listIssues` call so the TUI can
 * never show a set the JSON surface could not.
 */

import { openIssue } from "../../actions/issues.ts";
import {
  countIssues,
  labelsFor,
  listIssues,
  listLabels,
  type Issue,
  type IssueKind,
  type Label,
} from "../../core/issues.ts";
import { listPulls, type Pull } from "../../core/pulls.ts";
import type { Repo } from "../../core/repos.ts";
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
  drawList,
  errorText,
  pickerScreen,
  relTime,
  runAsync,
  type ListRow,
} from "./common.ts";
import { issueScreen } from "./issue.ts";
import { newPullScreen } from "./newpull.ts";
import { pullScreen } from "./pull.ts";

const STATES = ["open", "closed", "all"] as const;
const PAGE = 40;

export function issuesScreen(
  f: Session,
  ctx: Ctx,
  repo: Repo,
  kind: IssueKind,
): Screen {
  let items: (Issue | Pull)[] = [];
  let labels: Label[] = [];
  let tags = new Map<string, Label[]>();
  let counts = { open: 0, closed: 0 };
  let more = false;
  let segment = 0;
  let label: string | undefined;
  let mine = false;
  const state = new ListState();
  const search = new Filter();

  const query = (cursor?: number): Parameters<typeof listIssues>[2] => ({
    state: STATES[segment]!,
    kind,
    ...(label === undefined ? {} : { label }),
    ...(mine && f.user ? { author: f.user.username } : {}),
    ...(cursor === undefined ? {} : { cursor }),
    limit: PAGE,
  });

  const fetch = (cursor?: number): (Issue | Pull)[] =>
    kind === "pull"
      ? listPulls(f.db, repo.id, query(cursor))
      : listIssues(f.db, repo.id, query(cursor));

  const reload = async (): Promise<void> => {
    items = fetch();
    more = items.length === PAGE;
    labels = listLabels(f.db, repo.id);
    tags = new Map(items.map((i) => [i.id, labelsFor(f.db, i.id)]));
    counts = {
      open: countIssues(f.db, repo.id, kind, "open"),
      closed: countIssues(f.db, repo.id, kind, "closed"),
    };
    state.clamp(items.length);
    ctx.invalidate();
    return Promise.resolve();
  };

  const loadMore = (): void => {
    const last = items[items.length - 1];
    if (!last) return;
    const next = fetch(last.number);
    for (const item of next) tags.set(item.id, labelsFor(f.db, item.id));
    items = [...items, ...next];
    more = next.length === PAGE;
    ctx.invalidate();
  };

  const shown = (): (Issue | Pull)[] =>
    items.filter(
      (i) => search.matches(i.title) || search.matches(`#${i.number}`),
    );

  const noun = kind === "pull" ? "pull request" : "issue";

  const screen: Screen = {
    title: kind === "pull" ? "Pulls" : "Issues",
    keys: [
      binding(["j", "k"], "move"),
      binding(["enter"], "open"),
      binding(["tab"], "state"),
      binding(["l"], "label"),
      binding(["a"], mine ? "all authors" : "only mine"),
      binding(["c"], `new ${noun}`, { disabled: !f.signedIn }),
      binding(["/"], "search"),
      binding(["r"], "refresh"),
    ],
    load: reload,
    render(area, s) {
      const c = ctx.theme.c;
      const [seg, box, body] = split(area, "v", [len(1), len(1), fill(1)]);
      segmented(s, seg!, c, {
        items: [
          `Open ${counts.open}`,
          `Closed ${counts.closed}`,
          `All ${counts.open + counts.closed}`,
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
          title: `No ${noun}s`,
          body:
            segment === 0
              ? `Nothing open in ${repo.name}.`
              : "Nothing matches these filters.",
          ...(f.signedIn ? { action: `c  new ${noun}` } : {}),
        });
        return;
      }
      const list: ListRow[] = rows.map((item) => {
        const merged = "mergedAt" in item && item.mergedAt !== null;
        return {
          title: item.title,
          state: merged
            ? ("merged" as const)
            : item.state === "open"
              ? ("open" as const)
              : ("closed" as const),
          secondary: (tags.get(item.id) ?? []).map((l) => l.name).join(" "),
          meta: `#${item.number} ${item.authorName} ${relTime(item.updatedAt)}`,
        };
      });
      if (more) list.push({ title: "Load more…" });
      drawList(s, body!, c, state, list);
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
        runAsync(ctx, reload);
        return true;
      }
      if (e.key === "a") {
        mine = !mine;
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
              runAsync(ctx, reload);
            },
          }),
        );
        return true;
      }
      if (e.key === "enter") {
        const item = shown()[state.index];
        if (item === undefined) {
          loadMore();
          return true;
        }
        ctx.push(
          kind === "pull"
            ? pullScreen(f, ctx, repo, item.number)
            : issueScreen(f, ctx, repo, item.number),
        );
        return true;
      }
      if (e.key === "c" && f.signedIn) {
        ctx.push(
          kind === "pull"
            ? newPullScreen(f, ctx, repo)
            : newIssueScreen(f, ctx, repo),
        );
        return true;
      }
      if (e.key === "r") {
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
    const created = openIssue(f.app, f.user, repo, { title, body: body.value });
    if (!created.ok) {
      // The input is never cleared: a rejected form keeps everything typed.
      error = errorText(created.error);
      ctx.toast(error, "danger");
      return;
    }
    ctx.toast(`opened #${created.value.number}`, "success");
    ctx.replace(issueScreen(f, ctx, repo, created.value.number));
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
