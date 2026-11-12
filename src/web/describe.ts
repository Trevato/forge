/**
 * The one sentence a page unfurls as (`PageOptions.description`), written
 * from live state. Plain data in, a string out: the callers hand over the
 * word and the facts they already hold, and nothing here reads a database.
 *
 * Two rules. A private repository, app, change or sealed report says its
 * name (the `<title>`) and "private", nothing else — an unfurl is read by a
 * bot with no account, and what a page says for itself is never more than
 * that reader may see. And no sentence uses dev's vocabulary or an owner's
 * facts: the same line is shown on a studio page and to a stranger.
 */

export const PRIVATE_LINE = "Private.";

/** The first non-empty line of a body, or `""`. */
export function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t !== "") return t;
  }
  return "";
}

/** `<word>: <what it is>`, or the word alone when there is nothing more. */
function say(word: string, rest: string): string {
  const head = word.charAt(0).toUpperCase() + word.slice(1);
  return rest === "" ? `${head}.` : `${head}: ${rest}`;
}

const shortOid = (oid: string): string => oid.slice(0, 7);

/** What anyone may see of where a page's repository stands. */
export interface Visibility {
  readonly private: boolean;
}

/** A tell or a change: its word, then its title or its opening line. */
export function threadLine(o: {
  private: boolean;
  word: string;
  title: string;
  body: string;
}): string {
  if (o.private) return PRIVATE_LINE;
  return say(o.word, firstLine(o.body) || o.title);
}

/** A run: its verdict, the short sha it is about, and what it said. */
export function runLine(o: {
  private: boolean;
  word: string;
  commitOid: string;
  summary: string;
}): string {
  if (o.private) return PRIVATE_LINE;
  const at = o.commitOid === "" ? "" : ` at ${shortOid(o.commitOid)}`;
  return say(`${o.word}${at}`, firstLine(o.summary));
}

/** A person or an organization, by what is public about them. */
export function ownerLine(o: {
  org: boolean;
  name: string;
  publicRepos: number;
  more: boolean;
}): string {
  const n = `${o.publicRepos}${o.more ? "+" : ""}`;
  const noun = o.publicRepos === 1 && !o.more ? "repository" : "repositories";
  return `${o.org ? "Organization" : "User"} @${o.name} · ${n} public ${noun}.`;
}

/**
 * A whole line that is a scaffold's default or a placeholder, not a
 * description a visitor can read. Anchored: "A todo list app" is real.
 */
const JARGON =
  /^\s*(untitled|test|description|none|n\/a|todo|tbd|wip|fixme|lorem ipsum.*|initial commit|(an? )?(scaffold(ed)?|auto-?generated)( \w+)?|created (by|with|from) (forge|template).*)\s*[.!]?\s*$/i;

/** A description a visitor can read, or `fallback` when it is empty or jargon. */
export function plainDescription(text: string, fallback: string): string {
  const line = firstLine(text);
  return line === "" || JARGON.test(line) ? fallback : line;
}

const sentence = (text: string): string => (/[.!?…]$/.test(text) ? text : `${text}.`);

/** A repository: its own description, or a plain sentence naming it. */
export function repoLine(o: { private: boolean; name: string; description: string }): string {
  if (o.private) return PRIVATE_LINE;
  return sentence(plainDescription(o.description, `${o.name} is a project on the forge: code, issues and changes in one place.`));
}

/** An app: its own description, and whether it is up, in `envPhrase`'s word. */
export function appLine(o: {
  private: boolean;
  name: string;
  description: string;
  state: string;
}): string {
  if (o.private) return PRIVATE_LINE;
  const own = plainDescription(o.description, `${o.name} is an app you can try and make your own.`);
  return `${sentence(own)} Status: ${o.state}.`;
}
