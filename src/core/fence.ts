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
 * Each conversation keeps two marks: when the person last spoke (and what
 * they said) and when the agent last read fenced text. Marks are monotonic
 * ids, so they order even within one millisecond. Plain data in and out;
 * who may call is decided at the door (`http/mcp.ts`).
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
 * is fenced until someone writes it in here.
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
  "repo",
  "needs_confirm",
]);

/** Ids (`repoId`) and timestamps (`createdAt`) are the forge's too. */
const bare = (key: string): boolean => BARE_KEYS.has(key) || /[a-z](Id|At)$/.test(key);

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
 * the answer itself — except under a bare key, and whether any was. Numbers,
 * booleans and bare strings are returned as they were.
 */
export function fence(value: unknown, tag: string): { value: unknown; fenced: boolean } {
  let any = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v === "") return v;
      any = true;
      return fenced(v, tag);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== "object") return v;
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, bare(k) && typeof x === "string" ? x : walk(x)]),
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
 * The person's newest words when fenced text was read after them, so a
 * write now must be one those words name; undefined when nothing was read
 * since the person spoke.
 */
export function fenceUp(db: Database, via: string): string | undefined {
  const row = db
    .query<FenceRow, [string]>(
      "SELECT heard_mark, words, read_mark FROM conversation_fence WHERE via = ?1",
    )
    .get(via);
  if (row === null || row.read_mark === null || row.read_mark <= row.heard_mark) return undefined;
  return row.words;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Lower case, one space between words: how words and values compare. */
const plain = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

// A word at most two before that turns the ask around: "do not close",
// "never merge", "do not turn on flow only".
const NEGATED = /(^|[^a-z0-9'])(not|no|never|don't|dont|without|stop)\s+(\S+\s+){0,2}$/;

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

/** Whether these words hold the whole number `n` (`12`, `#12`; not `w12`, `121`). */
const saysNumber = (words: string, n: number): boolean =>
  new RegExp(`(^|[^0-9a-z])${n}($|[^0-9a-z])`).test(words);

/** `flowOnly` as "flow only", `allow_forks` as "allow forks". */
const spoken = (field: string): string => field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");

/** Every leaf of an argument: arrays and objects opened up. */
const leaves = (v: unknown): unknown[] =>
  Array.isArray(v) ? v.flatMap(leaves) : v !== null && typeof v === "object" ? Object.values(v).flatMap(leaves) : [v];

/**
 * Whether the person's words name this write. The verb: every word of the
 * tool's name, or every switch it sets (a boolean field, `flowOnly` as "flow
 * only"), not negated. Then every value it is given: the repository's name,
 * every other string as written (a label, a branch, a collaborator, a body),
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
        if (value !== "" && !said.includes(plain(value))) return false;
        if (k === "repo" && !says(said, value)) return false;
      } else if (typeof leaf === "number") {
        if (!Number.isInteger(leaf) || !saysNumber(said, leaf)) return false;
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

/**
 * Keep a held write as a confirm the person answers; its id, or null when
 * the conversation already holds `HELD_MAX` (a steered agent cannot fill
 * the table). Counted and kept in one statement.
 */
export function hold(
  db: Database,
  via: string,
  userId: string,
  tool: string,
  args: Record<string, unknown>,
): string | null {
  const heldId = id();
  const kept = db
    .query(
      `INSERT INTO conversation_held (id, via, user_id, tool, args, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
        WHERE (SELECT COUNT(*) FROM conversation_held WHERE via = ?2) < ?7`,
    )
    .run(heldId, via, userId, tool, JSON.stringify(args), new Date().toISOString(), HELD_MAX);
  return kept.changes === 1 ? heldId : null;
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
