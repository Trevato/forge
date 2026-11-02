/**
 * `/asked` in the terminal (#1755): the owner's thoughts, then what they
 * asked for in issues, from the same `thoughtStream` and `askedIn` reads the
 * page makes — so the gate is core's and not this screen's. A guest has
 * neither, a viewer sees only their own thoughts, and a placement in a
 * repository the viewer cannot read says so and names nothing of it.
 * The palette offers the door only when signed in, so the screen has no
 * signed-out face; `askedLines` still returns nothing for a guest. Read-only;
 * `enter` on an ask hands over its web address, on a thought opens its card
 * (#7473): where it went and what it repeats or takes back, as MCP `thought`
 * answers. The card is re-read on `r`.
 * `s` cycles unshipped → flagged → all and `o` flips oldest/newest, with MCP
 * `asked`'s defaults, words and order (#7303) — not the page's grouping.
 */

import type { Database } from "bun:sqlite";
import { NOT_PLACED_YET, thoughtNotes, whereItWent } from "../../actions/ask_state_words.ts";
import { askedIn, askedRepos, outcomeText, type Asked, type AskedOrder, type AskedShow } from "../../core/asked.ts";
import { getIssue } from "../../core/issues.ts";
import { mayView } from "../../core/sealed.ts";
import { placementOf } from "../../core/placements.ts";
import { canRead, getRepo, type Repo } from "../../core/repos.ts";
import { linksFrom, linksTo } from "../../core/thought_links.ts";
import { thoughtStream, type StreamThought } from "../../core/thought_stream.ts";
import { thoughtOf } from "../../core/thoughts.ts";
import type { User } from "../../core/users.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { split, fill, len } from "../ui/layout.ts";
import { emptyState, type Tone } from "../ui/widgets.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { ListState, drawList, hitList, metaOf, openOnWeb, relTime, type ListRow } from "./common.ts";
import { issueScreen } from "./issue.ts";
import { local } from "./where.ts";

/** One line of plain text: a typed thought may carry newlines or escapes the terminal must not obey. */
const plain = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();

export interface AskedLine extends ListRow {
  /** The web path `enter` opens; absent for a thought. */
  readonly path?: string;
  /** The thought `enter` opens a card for. */
  readonly thoughtId?: string;
  /** The issue `enter` opens, on a card line: only ever a repository the viewer can read. */
  readonly issue?: { readonly repo: Repo; readonly number: number };
}

const THOUGHT_WORD = {
  unplaced: "heard",
  placed: "placed",
  building: "building",
  shipped: "shipped",
  superseded: "superseded",
} as const;

/** Red is for nothing built, green for shipped, amber for under way. */
function toneOf(flagged: boolean, state: string): { tone?: Tone } {
  if (flagged) return { tone: "danger" };
  if (state === "shipped") return { tone: "success" };
  return state === "building" ? { tone: "attn" } : {};
}

/** Where it went and what it repeats or takes back, in /asked's words (`whereItWent`, `thoughtNotes`). */
function thoughtLine(t: StreamThought): AskedLine {
  const where = whereItWent(t).map((x) => `${x.lead}${x.text}`);
  const notes = thoughtNotes(t).map((n) => `${n.text} ${relTime(n.at)}`);
  return {
    thoughtId: t.id,
    title: plain(t.text),
    ...toneOf(t.flagged, t.state),
    hollow: t.state === "unplaced" || t.state === "superseded",
    secondary: plain([...where, ...notes].join(" · ")),
    meta: metaOf(t.flagged ? "nothing built" : THOUGHT_WORD[t.state], relTime(t.receivedAt)),
  };
}

/** The state, then stale or flagged, in MCP `asked`'s words; the outcome is the secondary line. */
function askLine(a: Asked): AskedLine {
  return {
    title: plain(a.issue.title),
    ...toneOf(a.flagged, a.state),
    secondary: `${plain(outcomeText(a))} · ${a.repo.ownerName}/${a.repo.name} #${a.issue.number}`,
    meta: metaOf(a.state, a.flagged ? "flagged" : a.stale ? "stale" : "", relTime(a.askedAt)),
    path: `/${a.repo.ownerName}/${a.repo.name}/issues/${a.issue.number}`,
  };
}

/** The repository `owner/name` when the viewer may read it: the one place a card decides that. */
function readableRepo(db: Database, viewer: User, slug: string): Repo | undefined {
  const [owner, name, ...rest] = slug.split("/");
  const r = owner && name && rest.length === 0 ? getRepo(db, owner, name) : undefined;
  return r && canRead(db, r, viewer) ? r : undefined;
}

const quoted = (text: string): string => `\u201c${plain(text)}\u201d`;

/**
 * What became of one thought, as MCP `thought` answers: one sentence a line.
 * Not the viewer's, or not there, is `undefined` alike.
 */
export function thoughtCard(db: Database, viewer: User | undefined, id: string): AskedLine[] | undefined {
  if (viewer === undefined) return undefined;
  const t = thoughtOf(db, viewer.id, id);
  if (t === undefined) return undefined;
  const out: AskedLine[] = [{ title: quoted(t.text), hollow: true }];
  const p = placementOf(db, id);
  if (p === undefined) out.push({ title: `Not placed yet: ${NOT_PLACED_YET}.` });
  else if (p.placed.length === 0) out.push({ title: "Kept as a note." });
  for (const x of p?.placed ?? []) {
    const repo = readableRepo(db, viewer, x.repo);
    const issue = repo === undefined ? undefined : getIssue(db, repo.id, x.number);
    // A sealed issue in a readable repository is no more there than an unreadable repository.
    if (repo === undefined || issue === undefined || !mayView(db, repo, issue, viewer)) {
      out.push({ title: `It ${x.action} something in a repository you cannot read.` });
      continue;
    }
    out.push({
      title: `It ${x.action} ${x.repo} #${x.number}: ${plain(issue.title)}.`,
      issue: { repo, number: x.number },
    });
  }
  const refs = (ids: readonly string[], verb: string): void => {
    for (const other of ids) {
      const o = thoughtOf(db, viewer.id, other);
      out.push({ title: o ? `${verb} ${quoted(o.text)}.` : `${verb} a thought that is gone.` });
    }
  };
  const from = linksFrom(db, id);
  const to = linksTo(db, id);
  refs(from.repeats, "It repeats");
  refs(from.supersedes, "It takes back");
  refs(to.repeatedBy, "Repeated later by");
  refs(to.supersededBy === null ? [] : [to.supersededBy], "Taken back later by");
  return out;
}

function cardScreen(f: Session, ctx: Ctx, id: string, first: AskedLine[]): Screen {
  const state = new ListState();
  let rows = first;
  const open = (index: number): void => {
    const x = rows[index]?.issue;
    if (x !== undefined) ctx.push(issueScreen(f, ctx, local(f, x.repo), x.number));
  };
  return {
    title: "Thought",
    keys: [binding(["j", "k"], "move"), binding(["enter"], "open issue (on a line that has one)"), binding(["r"], "refresh")],
    render(area, s) {
      drawList(s, area, ctx.theme.c, state, rows);
      hitList(ctx, area, state, rows.length, { open });
    },
    key(e) {
      if (state.key(e, rows.length)) return true;
      if (e.key === "enter") {
        open(state.index);
        return true;
      }
      if (e.key === "r") {
        const again = thoughtCard(f.db, f.user, id);
        if (again === undefined) {
          // Gone since it was drawn: stale rows must not pass for current ones.
          ctx.toast("No such thought", "attn");
          ctx.pop();
          return true;
        }
        rows = again;
        state.clamp(rows.length);
        ctx.invalidate();
        return true;
      }
      return false;
    },
  };
}

/** What MCP `asked` takes, and its defaults. */
export interface AskedView {
  readonly show: AskedShow;
  readonly order: AskedOrder;
}

export const DEFAULT_VIEW: AskedView = { show: "unshipped", order: "oldest" };

const SHOW_CYCLE: readonly AskedShow[] = ["unshipped", "flagged", "all"];

const SHOW_WORDS: Record<AskedShow, string> = { unshipped: "not shipped", flagged: "flagged", all: "all" };

/** The choice in words, for the title: "not shipped, oldest first". */
export const viewWords = (v: AskedView): string => `${SHOW_WORDS[v.show]}, ${v.order} first`;

export const nextShow = (show: AskedShow): AskedShow =>
  SHOW_CYCLE[(SHOW_CYCLE.indexOf(show) + 1) % SHOW_CYCLE.length]!;

/** The thoughts, then the asks, as rows. A guest has none of either. */
export function askedLines(
  db: Database,
  viewer: User | undefined,
  view: AskedView = DEFAULT_VIEW,
): { thoughts: AskedLine[]; asks: AskedLine[] } {
  if (viewer === undefined) return { thoughts: [], asks: [] };
  const repos = askedRepos(db, viewer, null);
  return {
    thoughts: thoughtStream(db, viewer, { limit: 50 }).map(thoughtLine),
    // MCP's order, not /asked's needs-the-owner grouping: the title names the order, so the rows keep it.
    asks: askedIn(db, repos, view).map(askLine),
  };
}

export function askedScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let lines: AskedLine[] = [];
  let thoughtCount = 0;
  let view = DEFAULT_VIEW;
  const open = (index: number): void => {
    const line = lines[index];
    if (line?.thoughtId !== undefined) {
      // Not the viewer's, or gone: nothing exists, as MCP answers.
      const card = thoughtCard(f.db, f.user, line.thoughtId);
      if (card === undefined) ctx.toast("No such thought", "attn");
      else ctx.push(cardScreen(f, ctx, line.thoughtId, card));
      return;
    }
    if (line?.path !== undefined) openOnWeb(f, ctx, line.path, "That ask");
  };
  const read = (): void => {
    const got = askedLines(f.db, f.user, view);
    lines = [...got.thoughts, ...got.asks];
    thoughtCount = got.thoughts.length;
    state.clamp(lines.length);
  };
  return {
    get title() {
      return `Asked · ${viewWords(view)}`;
    },
    keys: [
      binding(["j", "k"], "move"),
      binding(["enter"], "open"),
      binding(["s"], "show"),
      binding(["o"], "order"),
      binding(["r"], "refresh"),
    ],
    load: async () => read(),
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      // The title names the choice; the head line only counts.
      const sentence = `${thoughtCount} thoughts · ${lines.length - thoughtCount} asks`;
      s.text(head!.x, head!.y, truncate(sentence, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      if (lines.length === 0) {
        emptyState(s, body!, c, {
          title: "Nothing asked yet",
          body: "What you tell the crew shows up here, with what became of it.",
        });
        return;
      }
      drawList(s, body!, c, state, lines);
      hitList(ctx, body!, state, lines.length, { open });
    },
    key(e) {
      if (state.key(e, lines.length)) return true;
      if (e.key === "enter") {
        open(state.index);
        return true;
      }
      if (e.key === "s" || e.key === "o") {
        view = e.key === "s"
          ? { ...view, show: nextShow(view.show) }
          : { ...view, order: view.order === "oldest" ? "newest" : "oldest" };
        state.index = 0;
        state.offset = 0;
        read();
        ctx.invalidate();
        return true;
      }
      if (e.key === "r") {
        read();
        ctx.invalidate();
        return true;
      }
      return false;
    },
  };
}
