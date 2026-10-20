/**
 * A board is one JSON file in `forge/boards`, a repo the forge owns: the
 * file's name is the board's slug, each save is a commit by the admin who
 * made it, and git is the only place a board lives. `parseBoard` is the one
 * door in and out — a file that does not pass it is not a board, whoever
 * wrote it (a push can put anything in the repo).
 */
import { repoDir } from "../git/repos.ts";
import { listTree, readerFor } from "../git/read.ts";
import { commitFiles, type CommitFilesError } from "../git/write.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { CHARTS, type Chart } from "./chart.ts";
import { SOURCES } from "./sources.ts";

export const BOARDS_OWNER = "forge";
export const BOARDS_REPO = "boards";
const BRANCH = "main";

export const RANGES = ["1h", "24h", "7d", "30d", "all"] as const;
export const REFRESHES = ["off", "10s", "1m"] as const;
export type Range = (typeof RANGES)[number];
export type Refresh = (typeof REFRESHES)[number];

export type Panel = {
  title: string;
  chart: Chart;
  query: Record<string, unknown>;
  w: number;
  h: number;
};
export type Board = { title: string; range: Range; refresh: Refresh; panels: Panel[] };

export const MAX_TITLE = 80;
export const MAX_PANELS = 24;
export const MAX_W = 3;
export const MAX_H = 3;
const MAX_QUERY_BYTES = 4096;
const MAX_FILE = 256 * 1024;
const MAX_BOARDS = 200;

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === "string" && (list as readonly string[]).includes(v);
const title = (v: unknown): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= MAX_TITLE && !/[\u0000-\u001f\u007f]/.test(v);
const span = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max;

/** Names that belong to a page or an API door of their own, never a board's. */
const TAKEN = new Set(["data", "sources", "query", "pins"]);

/** A slug is a file name: lowercase, short, and never one of `TAKEN`. */
export const isSlug = (s: unknown): s is string =>
  typeof s === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(s) && !TAKEN.has(s);

/** A board's slug from its title, or "" when the title has no letters or digits. */
export function slugOf(t: string): string {
  const s = t.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return isSlug(s) ? s : TAKEN.has(s) ? `${s}-board` : "";
}

/** A panel, judged: the plain value or the reason it is not one. */
export function parsePanel(raw: unknown): Result<Panel, string> {
  if (!isObject(raw)) return err("a panel must be an object");
  if (!title(raw.title)) return err("a panel needs a title of up to 80 characters");
  if (!oneOf(CHARTS, raw.chart)) return err(`chart must be one of ${CHARTS.join(", ")}`);
  if (!isObject(raw.query)) return err("a panel's query must be an object");
  if (typeof raw.query.source !== "string" || !has(SOURCES, raw.query.source)) {
    return err("a panel's query needs a known source");
  }
  if (JSON.stringify(raw.query).length > MAX_QUERY_BYTES) return err("a panel's query is too long");
  if (!span(raw.w, MAX_W)) return err(`w must be a whole number from 1 to ${MAX_W}`);
  if (!span(raw.h, MAX_H)) return err(`h must be a whole number from 1 to ${MAX_H}`);
  return ok({ title: raw.title.trim(), chart: raw.chart, query: raw.query, w: raw.w, h: raw.h });
}

/** A board, judged: the plain value (unknown keys dropped) or the reason it is not one. */
export function parseBoard(raw: unknown): Result<Board, string> {
  if (!isObject(raw)) return err("a board must be an object");
  if (!title(raw.title)) return err("a board needs a title of up to 80 characters");
  if (!oneOf(RANGES, raw.range)) return err(`range must be one of ${RANGES.join(", ")}`);
  if (!oneOf(REFRESHES, raw.refresh)) return err(`refresh must be one of ${REFRESHES.join(", ")}`);
  if (!Array.isArray(raw.panels) || raw.panels.length > MAX_PANELS) {
    return err(`a board holds at most ${MAX_PANELS} panels`);
  }
  const panels: Panel[] = [];
  for (const p of raw.panels) {
    const one = parsePanel(p);
    if (!one.ok) return one;
    panels.push(one.value);
  }
  return ok({ title: raw.title.trim(), range: raw.range, refresh: raw.refresh, panels });
}

export const emptyBoard = (t: string): Board => ({ title: t.trim(), range: "7d", refresh: "off", panels: [] });

export type StoreError = CommitFilesError["kind"] | "invalid" | "not_found" | "exists" | "too_many";
export type Stored = { slug: string; board: Board };
export type Author = { name: string; email: string };

const file = (slug: string) => `${slug}.json`;
const dirOf = (reposRoot: string) => repoDir(reposRoot, BOARDS_OWNER, BOARDS_REPO);

/** One board by slug, or undefined when there is none or the file is not a board. */
export async function readBoard(reposRoot: string, slug: string): Promise<Board | undefined> {
  if (!isSlug(slug)) return undefined;
  const got = await readerFor(dirOf(reposRoot)).object(`${BRANCH}:${file(slug)}`);
  if (!got.ok || got.value.type !== "blob" || got.value.size > MAX_FILE) return undefined;
  try {
    const parsed = parseBoard(JSON.parse(new TextDecoder().decode(got.value.body)));
    return parsed.ok ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}

/** Every board in the repo, by slug; files that are not boards are left out. */
export async function listBoards(reposRoot: string): Promise<Stored[]> {
  const tree = await listTree(dirOf(reposRoot), BRANCH, "");
  if (!tree.ok) return [];
  const slugs = tree.value
    .filter((e) => e.type === "blob" && e.name.endsWith(".json") && isSlug(e.name.slice(0, -5)))
    .map((e) => e.name.slice(0, -5))
    .sort()
    .slice(0, MAX_BOARDS);
  const read = await Promise.all(slugs.map(async (slug) => ({ slug, board: await readBoard(reposRoot, slug) })));
  return read.filter((s): s is Stored => s.board !== undefined);
}

/**
 * Validate and commit `board` as `slug`. `create` refuses a slug already in
 * use; without it the board must already exist. One commit, one file, the
 * author's name on it; the branch moving under us is an error, not a merge.
 */
export async function saveBoard(
  reposRoot: string,
  slug: string,
  board: unknown,
  author: Author,
  message: string,
  mode: "create" | "update" = "update",
): Promise<Result<Board, StoreError>> {
  if (!isSlug(slug)) return err("invalid");
  const parsed = parseBoard(board);
  if (!parsed.ok) return err("invalid");
  const there = (await readBoard(reposRoot, slug)) !== undefined;
  if (mode === "create" && there) return err("exists");
  if (mode === "update" && !there) return err("not_found");
  if (mode === "create" && (await listBoards(reposRoot)).length >= MAX_BOARDS) return err("too_many");
  const done = await commitFiles(dirOf(reposRoot), {
    branch: BRANCH,
    message,
    files: [{ path: file(slug), content: `${JSON.stringify(parsed.value, null, 2)}\n` }],
    author,
  });
  return done.ok ? ok(parsed.value) : err(done.error.kind);
}

/** Delete a board's file in one commit. */
export async function removeBoard(
  reposRoot: string,
  slug: string,
  author: Author,
  message: string,
): Promise<Result<true, StoreError>> {
  if (!isSlug(slug)) return err("invalid");
  if ((await readBoard(reposRoot, slug)) === undefined) return err("not_found");
  const done = await commitFiles(dirOf(reposRoot), {
    branch: BRANCH,
    message,
    files: [{ path: file(slug), content: null }],
    author,
  });
  return done.ok ? ok(true) : err(done.error.kind);
}
