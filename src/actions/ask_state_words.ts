/**
 * What the crew says about where an ask stands (#5619), said from one place
 * so the asked and answers views read the same on the web and in the
 * terminal. Plain strings: each caller escapes them as its surface does.
 */

/** An ask the planner has not yet put on any issue, and nobody has replied to. */
export const NOT_PLACED_YET = "the planner has not placed it yet";

/** A thought the planner has not placed yet, as its row on /asked ends. */
export const NOT_PLACED = "not placed yet";

/** A thought the planner placed on no issue: a vision, a decision, a note. */
export const KEPT_AS_NOTE = "kept as a note";

/** An ask whose issue has a run going and no answer yet. */
export const CREW_WORKING = "The crew is working on it.";

/** Text on one line, cut at the last space before `n` characters (a hard cut when it has none). */
export const cut = (raw: string, n: number): string => {
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length <= n) return text;
  const space = text.lastIndexOf(" ", n - 1);
  return `${text.slice(0, space > 0 ? space : n - 1)}…`;
};

/** One piece of where a thought went: `lead` plain, `text` linked to `href` where the surface links. */
export interface WherePart {
  readonly lead: string;
  readonly text: string;
  readonly href?: string;
}

/** What `whereItWent` reads of a thought, so the words need nothing but plain data. */
export interface ThoughtWhere {
  readonly reply: string | null;
  readonly asked: boolean;
  readonly placedAt: string | null;
  readonly placed: readonly {
    readonly action: string;
    readonly repo: string;
    readonly number: number;
    readonly pull?: number;
    readonly readable: boolean;
    readonly title: string | null;
  }[];
}

const ACTED = new Set(["opened", "linked"]);

/**
 * Where a thought went, as MCP `thought` answers it (#7509), in the same words
 * on /asked and in the terminal: `→` each issue it placed; the planner's
 * question when it answered with one; `kept as a note` when it placed it on
 * none; `not placed yet` until it has.
 */
export function whereItWent(t: ThoughtWhere): WherePart[] {
  if (t.placed.length === 0) {
    if (t.placedAt === null) return [{ lead: NOT_PLACED, text: "" }];
    if (t.asked && t.reply) return [{ lead: t.reply, text: "" }];
    return [{ lead: KEPT_AS_NOTE, text: "" }];
  }
  return t.placed.map((x) => {
    const act = ACTED.has(x.action) ? "" : `${x.action} `;
    if (!x.readable) return { lead: `→ ${act}in a repository you cannot read`, text: "" };
    if (x.title === null) return { lead: `→ ${act}${x.repo}#${x.number}`, text: "" };
    return {
      lead: `→ ${act}`,
      text: `${x.repo}#${x.number} ${cut(x.title, 60)}`,
      href: `/${x.repo}/${x.pull === x.number ? "pulls" : "issues"}/${x.number}`,
    };
  });
}

/** What a thought repeats, takes back, or was taken back by: the words, and the other thought's time. */
export interface ThoughtNote {
  readonly text: string;
  readonly at: string;
}

interface Ref {
  readonly text: string;
  readonly receivedAt: string;
}

export function thoughtNotes(t: {
  readonly supersededBy: Ref | null;
  readonly repeats: Ref | null;
  readonly supersedes: readonly Ref[];
}): ThoughtNote[] {
  const notes: ThoughtNote[] = [];
  if (t.supersededBy)
    notes.push({ text: `superseded by “${cut(t.supersededBy.text, 60)}”`, at: t.supersededBy.receivedAt });
  if (t.repeats) notes.push({ text: `repeats “${cut(t.repeats.text, 60)}”`, at: t.repeats.receivedAt });
  const back = t.supersedes[0];
  if (back) notes.push({ text: `takes back “${cut(back.text, 60)}”`, at: back.receivedAt });
  return notes;
}
