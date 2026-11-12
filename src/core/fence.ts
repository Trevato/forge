/**
 * The fence (#7649): text the forge's own agent reads that someone else
 * wrote — an issue's body, a comment, a file, an outside repository's
 * thread — reaches it inside a marked data block, and a write that follows
 * such a read without the person having asked for it is held as a confirm.
 * The agent holds the person's permissions, so what it reads must never
 * steer it.
 *
 * A block opens with `[[data <tag>]]` and closes with `[[/data <tag>]]`,
 * the tag fresh for every answer: text inside cannot close the block early,
 * because it cannot know the tag.
 *
 * Each conversation keeps what the person last said and whether the agent
 * has read fenced text; once it has, the fence stays up for the conversation.
 * Up, a write goes ahead when the person's newest words name it whole
 * (`named`), or, for undoable work in a repository they may write, when
 * those words ask for that work or answer the proposal that named it
 * (`askedFor`, #9401). Anything else is held, with buttons in the thread.
 * Plain data in and out; who may call is decided at the door (`http/mcp.ts`).
 */

import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";

/** A conversation's name on its token and its marks. */
export const VIA_FORM = /^conversation:[0-9a-z]{1,40}$/;

/** The person's words kept for naming a write; longer is cut. */
export const WORDS_MAX = 20_000;

/**
 * Keys whose strings the forge itself makes — ids, enums, timestamps, its
 * own addresses — and so are left bare. Every other string in an answer is
 * fenced wherever it sits: a body, a comment, a reason, a label, a branch or
 * file name, a display name. Allow-listed, so a field a tool adds tomorrow
 * is fenced until someone writes it in here. `repo` is not on it: the name
 * is an outsider's to choose.
 */
export const BARE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "state",
  "kind",
  "type",
  "scope",
  "visibility",
  "status",
  "role",
  "sha",
  "url",
  "href",
  "uri",
  "mimeType",
  "tool",
  "needs_confirm",
]);

/** Ids (`repoId`) and timestamps (`createdAt`) are the forge's too. */
const bareKey = (key: string): boolean => BARE_KEYS.has(key) || /[a-z](Id|At)$/.test(key);

/** Keys that hold an address. */
const ADDRESS_KEYS: ReadonlySet<string> = new Set(["url", "href", "uri"]);

/** What an id, an enum or a timestamp looks like: short, with no space, bracket or quote. */
const MADE_FORM = /^[A-Za-z0-9_.:/+-]{1,64}$/;

/**
 * A string under a bare key is left bare only while it still looks like one
 * the forge made (#8230): one short run with no space and no bracket, and an
 * address the forge's own — a path, or under `origin`. A sentence, or a link
 * someone else chose, is fenced like any other text.
 */
const bareValue = (key: string, value: string, origin: string | undefined): boolean => {
  if (!ADDRESS_KEYS.has(key)) return MADE_FORM.test(value);
  if (!/^[^\s[\]]{1,300}$/.test(value)) return false;
  return /^\/(?!\/)/.test(value) || (origin !== undefined && value.startsWith(`${origin}/`));
};

/** A key the forge names its fields with; any other key is someone's text, and fenced. */
const KEY_FORM = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** A fresh tag for one answer's blocks. */
export function fenceTag(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const fenceOpen = (tag: string): string => `[[data ${tag}]]`;
export const fenceClose = (tag: string): string => `[[/data ${tag}]]`;

/** One text inside a data block. */
export const fenced = (text: string, tag: string): string =>
  `${fenceOpen(tag)}\n${text}\n${fenceClose(tag)}`;

/**
 * The answer with every non-empty string wrapped — in an object, an array or
 * the answer itself, and an object's key that is not a field name — except
 * a forge-made value under a bare key, and whether any was. Numbers,
 * booleans and bare strings are returned as they were. `origin` is the
 * forge's own, whose addresses stay bare.
 */
export function fence(value: unknown, tag: string, origin?: string): { value: unknown; fenced: boolean } {
  let any = false;
  const wrap = (s: string): string => {
    any = true;
    return fenced(s, tag);
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v === "" ? v : wrap(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== "object") return v;
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [
        KEY_FORM.test(k) ? k : wrap(k),
        typeof x === "string" && bareKey(k) && bareValue(k, x, origin) ? x : walk(x),
      ]),
    );
  };
  const out = walk(value);
  return { value: out, fenced: any };
}

interface FenceRow {
  heard_mark: string;
  words: string;
  read_mark: string | null;
}

/** The person spoke: their newest words, marked now. */
export function heard(db: Database, via: string, words: string): void {
  db.query(
    `INSERT INTO conversation_fence (via, heard_mark, words) VALUES (?1, ?2, ?3)
     ON CONFLICT(via) DO UPDATE SET heard_mark = excluded.heard_mark, words = excluded.words`,
  ).run(via, id(), words.slice(0, WORDS_MAX));
}

/** The agent read fenced text, marked now. Before any words, nothing was heard. */
export function readFenced(db: Database, via: string): void {
  db.query(
    `INSERT INTO conversation_fence (via, heard_mark, words, read_mark) VALUES (?1, '', '', ?2)
     ON CONFLICT(via) DO UPDATE SET read_mark = excluded.read_mark`,
  ).run(via, id());
}

/**
 * The person's newest words once fenced text was read in this conversation,
 * so a write now must be one those words name; undefined when nothing was
 * ever read. The mark outlives the person's next message and a resume: the
 * session still holds what was read, so a new message from the person does
 * not make it safe (#8230). Only words that name the write let it go.
 */
export function fenceUp(db: Database, via: string): string | undefined {
  const row = db
    .query<FenceRow, [string]>(
      "SELECT heard_mark, words, read_mark FROM conversation_fence WHERE via = ?1",
    )
    .get(via);
  if (row === null || row.read_mark === null) return undefined;
  return row.words;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Lower case, one space between words: how words and values compare. */
const plain = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

// A word at most two before that turns the ask around: "do not close",
// "never merge", "do not turn on flow only".
const NEGATED = /(^|[^a-z0-9'])(not|no|never|don't|dont|won't|wont|without|stop)\W+(\S+\s+){0,2}$/;
/** A negating word anywhere in the clause before an ask turns it around: "do not, under any circumstances, comment". */
const NEGATED_CLAUSE = /(^|[^a-z0-9'])(not|no|never|don't|dont|won't|wont|without|stop)($|[^a-z0-9'])/;

/**
 * Whether these words hold `w` starting at a word boundary ("closing" holds
 * "close"), at least once not negated ("don't close" is not an ask).
 */
const says = (words: string, w: string): boolean => {
  const want = plain(w);
  if (want === "") return false;
  const re = new RegExp(`(^|[^a-z0-9])${escapeRe(want)}`, "g");
  for (const m of words.matchAll(re)) {
    if (!NEGATED.test(words.slice(0, m.index + m[1]!.length))) return true;
  }
  return false;
};

/** Whether these words hold `value` as whole words: not inside a longer word ("bug" is not in "debug"). */
const saysValue = (words: string, value: string): boolean =>
  new RegExp(`(?<![a-z0-9])${escapeRe(plain(value))}(?![a-z0-9])`).test(words);

/** Whether these words hold the whole number `n` (`12`, `#12`; not `w12`, `121`). */
const saysNumber = (words: string, n: number): boolean =>
  new RegExp(`(^|[^0-9a-z])${n}($|[^0-9a-z])`).test(words);

/** `allowForks` as "allow forks", `allow_forks` as "allow forks". */
const spoken = (field: string): string => field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");

/** Every leaf of an argument: arrays and objects opened up. */
const leaves = (v: unknown): unknown[] =>
  Array.isArray(v) ? v.flatMap(leaves) : v !== null && typeof v === "object" ? Object.values(v).flatMap(leaves) : [v];

/**
 * Whether the person's words name this write. The verb: every word of the
 * tool's name, or every switch it sets (a boolean field, `allowForks` as "allow
 * forks"), not negated. Then every value it is given: the repository's name,
 * every other string as written, as whole words (a label, a branch, a collaborator, a body),
 * and every whole number (an issue, a pull, `into`). Strict on purpose: a
 * write it misses is a confirm the person answers, never a write done.
 */
export function named(words: string, tool: string, args: Record<string, unknown>): boolean {
  const said = plain(words);
  const switches = Object.keys(args).filter((k) => k !== "dryRun" && typeof args[k] === "boolean");
  const verb =
    tool.split("_").every((w) => says(said, w)) ||
    (switches.length > 0 && switches.every((k) => says(said, k) || says(said, spoken(k))));
  if (!verb) return false;
  for (const [k, v] of Object.entries(args)) {
    for (const leaf of leaves(v)) {
      if (typeof leaf === "string") {
        const value = k === "repo" ? (leaf.split("/").pop() ?? "") : leaf;
        if (value !== "" && !saysValue(said, value)) return false;
      } else if (typeof leaf === "number") {
        if (!Number.isInteger(leaf) || !saysNumber(said, leaf)) return false;
      }
    }
  }
  return true;
}

/** Undoable work the fence may let go on the person's ask (`crew/conversation_confirm.ts` lists it). */
export interface Work {
  /** Words that ask for this work, in lower case, each global. */
  readonly ask: readonly RegExp[];
  /** Arguments the agent composes (a title, a body): the person need not have said them. */
  readonly composed: ReadonlySet<string>;
}

/** Longest message taken as a direct ask: past it, the words are more likely a paste than a request. */
const ASK_CHARS_MAX = 600;

/** Longest message taken as an answer to a proposal. */
const ANSWER_WORDS_MAX = 12;

/** Opening a message with one of these asks about the work rather than for it. */
const WONDERS = /^(what|why|when|where|who|which|how|did|does|do you|is|are|was|were|has|have|should i)(?![a-z0-9])/;

/** A plain yes, at the start of the message. */
const ASSENT = /^(yes|yeah|yep|yup|ya|sure|ok|okay|please|absolutely|definitely|lgtm|go ahead|go for it|do it|sounds good|ship it|make it so|let's do it|lets do it)(?![a-z0-9])/;

/** Anywhere in a short message, a sign it is not a plain answer. */
const DOUBT = /(^|[^a-z0-9'])(no|nope|not|don't|dont|never|stop|wait|later|cancel|but|instead|first|why|what|how|when|where|who|which|if|maybe|hold)(?![a-z0-9'])/;

/** Words that say nothing of the work: "port it" is "port". Thanks is not a yes. */
const FILLER: ReadonlySet<string> = new Set(["it", "this", "that", "them", "the", "a", "an", "and", "then", "now", "please", "go", "ahead"]);
const NOT_ASSENT: ReadonlySet<string> = new Set(["thanks", "thank", "thx", "you", "cool", "nice", "great", "interesting", "hm", "hmm"]);

/**
 * The closing question of the agent's last message, as the person read it:
 * what a comment or tag hides from the page is not proposed, and neither is
 * what an earlier paragraph buried. Undefined when it does not close on a question.
 */
export function proposalIn(text: string): string | undefined {
  const shown = text.replace(/<!--[\s\S]*?(-->|$)/g, " ").replace(/<[^>]*>/g, " ").trim();
  const last = shown.split(/\n\s*\n/).at(-1) ?? "";
  return last.includes("?") ? last : undefined;
}

/** Whether these plain words answer yes to this plain proposal: "yeah", or "port it" when it offered to port. */
function answers(said: string, proposal: string): boolean {
  const tokens = said.split(/[^a-z0-9'-]+/).filter((t) => t !== "");
  if (tokens.length === 0 || tokens.length > ANSWER_WORDS_MAX || said.includes("?") || DOUBT.test(said)) return false;
  if (ASSENT.test(said)) return true;
  const content = tokens.filter((t) => !FILLER.has(t));
  return content.length > 0 && content.every((t) => !NOT_ASSENT.has(t) && saysValue(proposal, t));
}

/** Whether these plain words hold an ask for the work, at least once not negated. */
const asksWork = (said: string, work: Work): boolean =>
  work.ask.some((re) =>
    [...said.matchAll(re)].some((m) => {
      const before = said.slice(0, m.index);
      return !NEGATED_CLAUSE.test(before.slice(Math.max(before.lastIndexOf("."), before.lastIndexOf(";")) + 1));
    }),
  );

/**
 * Whether the person asked for this undoable write after fenced text was
 * read (#9401): their newest words ask for the work, or answer yes to the
 * agent's closing question and that question names the work. Then every
 * argument the agent does not compose — the repository first, a number, a
 * label, an assignee — must be in what the person said or the question they
 * answered, so a steered agent cannot aim the work elsewhere; and composed
 * text may not carry a data block whole. Strict the same way as `named`: what
 * it misses is a confirm the person answers. `proposal` is what the agent
 * said before the person's newest words, never during the turn they started.
 */
export function askedFor(words: string, proposal: string | undefined, work: Work, args: Record<string, unknown>, self: string): boolean {
  const said = plain(words);
  const offered = proposal === undefined ? undefined : proposalIn(proposal);
  const closing = offered === undefined ? "" : plain(offered);
  const asked = words.length <= ASK_CHARS_MAX && !WONDERS.test(said) && asksWork(said, work);
  const answered = closing !== "" && answers(said, closing) && asksWork(closing, work);
  if (!asked && !answered) return false;
  const scope = `${said} ${closing}`;
  for (const [k, v] of Object.entries(args)) {
    for (const leaf of leaves(v)) {
      if (work.composed.has(k)) {
        if (typeof leaf === "string" && leaf.toLowerCase().includes("[[data ")) return false;
      } else if (typeof leaf === "string") {
        // A repository's short name is enough only under the person's own account: anyone can own another `open`.
        const owner = k === "repo" && leaf.includes("/") ? leaf.split("/")[0] : undefined;
        const own = owner !== undefined && owner.toLowerCase() === self.toLowerCase();
        const value = own ? (leaf.split("/").pop() ?? "") : leaf;
        if (value !== "" && !saysValue(scope, value)) return false;
      } else if (typeof leaf === "number") {
        if (!Number.isInteger(leaf) || !saysNumber(scope, leaf)) return false;
      }
    }
  }
  return true;
}

export interface Held {
  readonly id: string;
  readonly via: string;
  readonly userId: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly createdAt: string;
}

/** A conversation keeps at most this many held writes; past it, a write is refused unkept. */
export const HELD_MAX = 50;

/** Ten minutes: a held write not answered by then is past its time, and its arguments are cleared. */
export const HELD_TTL_MS = 600_000;

/**
 * Put every held write past `HELD_TTL_MS` out of reach (#7650): stamped
 * answered and its arguments cleared, so a secret it carried is not kept at
 * rest and it no longer counts toward `HELD_MAX`. Run before a write is held
 * and before the person's confirms are listed or answered.
 */
export function sweepHeld(db: Database, now: number = Date.now()): void {
  db.query(
    "UPDATE conversation_held SET answered_at = ?1, args = '{}' WHERE answered_at IS NULL AND created_at <= ?2",
  ).run(new Date(now).toISOString(), new Date(now - HELD_TTL_MS).toISOString());
}

/**
 * Keep a held write as a confirm the person answers; its id, or null when
 * the conversation already holds `HELD_MAX` waiting (a steered agent cannot
 * fill the table). Those past their time are swept first, so they never
 * count; counted and kept in one statement.
 */
export function hold(
  db: Database,
  via: string,
  userId: string,
  tool: string,
  args: Record<string, unknown>,
  now: number = Date.now(),
): string | null {
  const heldId = id();
  return db.transaction(() => {
    sweepHeld(db, now);
    const kept = db
      .query(
        `INSERT INTO conversation_held (id, via, user_id, tool, args, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
          WHERE (SELECT COUNT(*) FROM conversation_held WHERE via = ?2 AND answered_at IS NULL) < ?7`,
      )
      .run(heldId, via, userId, tool, JSON.stringify(args), new Date(now).toISOString(), HELD_MAX);
    return kept.changes === 1 ? heldId : null;
  })();
}

/**
 * Every write a conversation still holds is answered no and its arguments
 * cleared, so a stopped turn leaves nothing a late Confirm could apply.
 * Returns how many were cancelled.
 */
export function cancelHeld(db: Database, via: string, now: number = Date.now()): number {
  return db
    .query("UPDATE conversation_held SET answered_at = ?2, args = '{}' WHERE via = ?1 AND answered_at IS NULL")
    .run(via, new Date(now).toISOString()).changes;
}

/** A conversation's held writes, oldest first. */
export function heldIn(db: Database, via: string): Held[] {
  return db
    .query<
      { id: string; via: string; user_id: string; tool: string; args: string; created_at: string },
      [string]
    >("SELECT id, via, user_id, tool, args, created_at FROM conversation_held WHERE via = ?1 ORDER BY id")
    .all(via)
    .map((r) => ({
      id: r.id,
      via: r.via,
      userId: r.user_id,
      tool: r.tool,
      args: JSON.parse(r.args) as Record<string, unknown>,
      createdAt: r.created_at,
    }));
}

/** Of these confirms, the person's that ran out of time rather than being answered. */
export function pastTime(db: Database, userId: string, ids: readonly string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const rows = db
    .query<{ id: string; created_at: string; answered_at: string | null }, [string, string]>(
      "SELECT id, created_at, answered_at FROM conversation_held WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))",
    )
    .all(userId, JSON.stringify(ids));
  return new Set(
    rows
      .filter((r) => r.answered_at !== null && Date.parse(r.answered_at) - Date.parse(r.created_at) >= HELD_TTL_MS)
      .map((r) => r.id),
  );
}

/** Why a yes is refused: no such confirm of this person's, already answered, or past its time. */
export type YesRefusal = "not_found" | "answered" | "expired";

/**
 * How many confirms wait on the person's yes: one indexed count
 * (`conversation_held_waiting`), no sweep, so a page can ask it on every
 * render. Those past their time do not count, swept or not.
 */
export function countWaiting(db: Database, userId: string, now: number = Date.now()): number {
  return db
    .query<{ n: number }, [string, string]>(
      "SELECT COUNT(*) AS n FROM conversation_held WHERE user_id = ?1 AND answered_at IS NULL AND created_at > ?2",
    )
    .get(userId, new Date(now - HELD_TTL_MS).toISOString())!.n;
}

/** A person's confirms still waiting for their yes, oldest first; those past their time are swept first. */
export function waitingFor(db: Database, userId: string, now: number = Date.now()): Held[] {
  sweepHeld(db, now);
  return db
    .query<
      { id: string; via: string; user_id: string; tool: string; args: string; created_at: string },
      [string]
    >(
      "SELECT id, via, user_id, tool, args, created_at FROM conversation_held WHERE user_id = ?1 AND answered_at IS NULL ORDER BY id",
    )
    .all(userId)
    .map((r) => ({
      id: r.id,
      via: r.via,
      userId: r.user_id,
      tool: r.tool,
      args: JSON.parse(r.args) as Record<string, unknown>,
      createdAt: r.created_at,
    }));
}

/**
 * The person's yes to a held write, claimed once (#7650): the row is
 * stamped answered and its arguments cleared in the same transaction that
 * reads them, so a second yes finds it answered. Only the person it was
 * held for may answer; another person's confirm is `not_found`. A yes
 * `HELD_TTL_MS` or more after it was held is `expired` — whether this yes
 * or a sweep stamped it.
 */
export function answerHeld(
  db: Database,
  heldId: string,
  userId: string,
  now: number = Date.now(),
): { ok: true; value: Held } | { ok: false; error: YesRefusal } {
  return db.transaction(() => {
    sweepHeld(db, now);
    const row = db
      .query<
        { id: string; via: string; user_id: string; tool: string; args: string; created_at: string; answered_at: string | null },
        [string, string]
      >("SELECT * FROM conversation_held WHERE id = ?1 AND user_id = ?2")
      .get(heldId, userId);
    if (row === null) return { ok: false as const, error: "not_found" as const };
    if (row.answered_at !== null)
      return {
        ok: false as const,
        error: Date.parse(row.answered_at) - Date.parse(row.created_at) >= HELD_TTL_MS ? ("expired" as const) : ("answered" as const),
      };
    db.query("UPDATE conversation_held SET answered_at = ?2, args = '{}' WHERE id = ?1").run(
      heldId,
      new Date(now).toISOString(),
    );
    return {
      ok: true as const,
      value: {
        id: row.id,
        via: row.via,
        userId: row.user_id,
        tool: row.tool,
        args: JSON.parse(row.args) as Record<string, unknown>,
        createdAt: row.created_at,
      },
    };
  })();
}
