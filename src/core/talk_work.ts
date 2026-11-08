/**
 * What a /talk turn did, read from the calls it stored (#8821): one quiet
 * steps line ("read 3 files, opened #12") and the links to what it opened or
 * changed. Plain data in, plain data out: the calls are tool turns written as
 * `<tool> <json args>` (`crew/conversation.ts`), and only a well-formed
 * repo, number and path ever becomes a link. Both doors read it: the web page
 * draws it, and `GET /api/v1/conversation/turns` carries it for the terminal.
 */

import type { Database } from "bun:sqlite";
import { getIssue } from "./issues.ts";
import { listTurns } from "./conversations.ts";
import { getRepo, type Repo } from "./repos.ts";

/** The part of a turn the reading needs: its role and its stored text. */
export type Said = { readonly role: string; readonly text: string };

export interface Link {
  readonly href: string;
  readonly label: string;
}

/**
 * What the links need to know about the forge: a file link needs the default
 * branch the blob page resolves, and a number link needs to know whether it is
 * an issue or a pull (each answers only at its own path). Undefined is unknown.
 */
export interface Lookup {
  readonly branchOf: (repo: string) => string | undefined;
  readonly kindOf: (repo: string, n: number) => "issue" | "pull" | undefined;
}

const NOTHING: Lookup = { branchOf: () => undefined, kindOf: () => undefined };

/** A thought as the agent's `thinking` turn stores it (`crew/conversation.ts`), else undefined. */
export function thinkingOf(turn: Said): string | undefined {
  if (turn.role !== "tool" || !turn.text.startsWith('{"thinking"')) return undefined;
  try {
    const data: unknown = JSON.parse(turn.text);
    const thought = typeof data === "object" && data !== null ? (data as Record<string, unknown>)["thinking"] : undefined;
    return typeof thought === "string" ? thought : undefined;
  } catch {
    return undefined;
  }
}

/** The lookup read from the database, each answer kept for the request, so a long chat asks once per repo and number. */
export function lookupFrom(db: Database): Lookup {
  const repos = new Map<string, Repo | undefined>();
  const kinds = new Map<string, "issue" | "pull" | undefined>();
  const repoOf = (repo: string): Repo | undefined => {
    if (!repos.has(repo)) {
      const [owner, name] = repo.split("/");
      repos.set(repo, owner === undefined || name === undefined ? undefined : getRepo(db, owner, name));
    }
    return repos.get(repo);
  };
  return {
    branchOf: (repo) => repoOf(repo)?.defaultBranch,
    kindOf: (repo, n) => {
      const key = `${repo}#${String(n)}`;
      if (!kinds.has(key)) {
        const found = repoOf(repo);
        kinds.set(key, found === undefined ? undefined : getIssue(db, found.id, n)?.kind);
      }
      return kinds.get(key);
    },
  };
}

export interface Work {
  readonly steps: string;
  readonly links: readonly Link[];
}

/** The most links drawn under one reply. */
export const LINKS_MAX = 8;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const PREFIX = /^mcp__[a-z0-9-]+__/;
/** Tools that read one issue or pull: the line says "opened". */
const OPENS = new Set(["issue", "pull"]);
/** Tools that change one issue or pull by `repo` and `number` (`writes: true`, held by a test): the line says "changed". */
export const CHANGES = new Set(["assign", "close", "edit", "issue_teams", "keep_plan", "labels", "land_past_gate", "merge", "review", "say", "seal", "take_back", "threads", "variant"]);
/** Tools that act on a pull; the rest of the number tools name an issue unless the forge says otherwise. */
const PULL_TOOLS = new Set(["pull", "merge", "review", "land_past_gate"]);
const APPS = new Set(["new_app", "app_deploy", "make_it_yours", "fork", "variant"]);

interface Call {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

function callOf(turn: Said): Call | undefined {
  if (turn.role !== "tool" || turn.text.startsWith("{")) return undefined;
  const space = turn.text.indexOf(" ");
  const tool = (space < 0 ? turn.text : turn.text.slice(0, space)).replace(PREFIX, "");
  if (!/^[a-z0-9_]{1,60}$/.test(tool)) return undefined;
  try {
    const args: unknown = space < 0 ? {} : JSON.parse(turn.text.slice(space + 1));
    return { tool, args: typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {} };
  } catch {
    // A call cut at the stored length still counts as a step, with no link.
    return { tool, args: {} };
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/** The steps line and links for the tool turns that came before one reply; undefined when there were none. */
export function workOf(turns: readonly Said[], look: Lookup = NOTHING): Work | undefined {
  const calls = turns.map(callOf).filter((c): c is Call => c !== undefined);
  if (calls.length === 0) return undefined;
  const links = new Map<string, string>();
  const read = new Set<string>();
  const wrote = new Set<string>();
  const opened = new Map<string, { repo: string; n: number }>();
  const changed = new Map<string, { repo: string; n: number }>();
  const other = new Map<string, number>();
  const another = (tool: string): void => void other.set(tool, (other.get(tool) ?? 0) + 1);
  calls.forEach(({ tool, args }, i) => {
    const repo = str(args["repo"]);
    const good = REPO.test(repo);
    const n = args["number"];
    const path = str(args["path"]);
    const safePath = path !== "" && path.length <= 1024 && !path.split("/").some((s) => s === ".." || s === "");
    const file = good && safePath;
    if (tool === "read_file" || tool === "write_file") {
      // A malformed call still counts as one file, with no link.
      (tool === "read_file" ? read : wrote).add(file ? `${repo}:${path}` : `?${String(i)}`);
      const ref = file ? str(args[tool === "read_file" ? "ref" : "branch"]) || look.branchOf(repo) : undefined;
      if (ref !== undefined) links.set(blob(repo, ref, path), `${repo}/${path}`);
    } else if ((OPENS.has(tool) || CHANGES.has(tool)) && good && typeof n === "number" && Number.isInteger(n) && n > 0) {
      const kind = look.kindOf(repo, n) ?? (PULL_TOOLS.has(tool) ? "pull" : "issue");
      (OPENS.has(tool) ? opened : changed).set(`${repo}#${String(n)}`, { repo, n });
      links.set(`/${repo}/${kind}s/${String(n)}`, `${repo} #${String(n)}`);
    } else if (APPS.has(tool) && good) {
      another(tool);
      links.set(`/${repo}`, repo);
    } else another(tool);
  });
  // A number alone, unless the turn touched more than one repo: then each says whose.
  const repos = new Set([...opened.values(), ...changed.values()].map((r) => r.repo));
  const named = (refs: Map<string, { repo: string; n: number }>): string =>
    [...refs.values()].map(({ repo, n }) => `${repos.size > 1 ? repo : ""}#${String(n)}`).join(", ");
  const parts: string[] = [];
  if (read.size > 0) parts.push(`read ${plural(read.size, "file", "files")}`);
  if (wrote.size > 0) parts.push(`changed ${plural(wrote.size, "file", "files")}`);
  if (opened.size > 0) parts.push(`opened ${named(opened)}`);
  if (changed.size > 0) parts.push(`changed ${named(changed)}`);
  const rest = [...other];
  // One kind of other call is named; several are counted.
  if (rest.length === 1) parts.push(`${rest[0]![0].replaceAll("_", " ")}${rest[0]![1] > 1 ? ` ×${String(rest[0]![1])}` : ""}`);
  else if (rest.length > 1) parts.push(plural(rest.reduce((n, [, c]) => n + c, 0), "other step", "other steps"));
  return { steps: parts.join(", "), links: [...links].slice(0, LINKS_MAX).map(([href, label]) => ({ href, label })) };
}

const blob = (repo: string, ref: string, path: string): string =>
  `/${repo}/blob/${encodeURIComponent(ref)}/${path.split("/").map(encodeURIComponent).join("/")}`;

/** The tool turns just before position `i`: back to the last person or agent turn. */
export function workBefore(turns: readonly Said[], i: number, look?: Lookup): Work | undefined {
  let from = i;
  while (from > 0 && isCall(turns[from - 1])) from -= 1;
  return workOf(turns.slice(from, i), look);
}

const isCall = (turn: Said | undefined): boolean => turn?.role === "tool" || turn?.role === "confirm";

/** How far back a reply's calls are read when they start before the page. */
const REACH = 60;

/**
 * The work behind each agent turn of one page of a conversation, by turn id.
 * When the page opens on calls or a reply, the calls before it sit on the
 * page before, so they are read too: a reply reads the same on any page as
 * on the stream.
 */
export function worksOf(db: Database, userId: string, conversationId: string, page: readonly (Said & { readonly id: string })[]): Map<string, Work> {
  const look = lookupFrom(db);
  const first = page[0];
  const earlier =
    first !== undefined && (first.role === "agent" || isCall(first))
      ? listTurns(db, userId, conversationId, { before: first.id, limit: REACH })
      : undefined;
  const all: readonly Said[] = earlier?.ok ? [...earlier.value, ...page] : page;
  const offset = all.length - page.length;
  const works = new Map<string, Work>();
  page.forEach((turn, i) => {
    if (turn.role !== "agent") return;
    const work = workBefore(all, offset + i, look);
    if (work !== undefined) works.set(turn.id, work);
  });
  return works;
}
