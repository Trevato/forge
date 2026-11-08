/**
 * Boards, made and changed by a forge admin who is a person (an agent never
 * edits what the admins look at). Everyone else is told `not_found`. A board
 * is a file in `forge/boards` (`boards/store.ts`); the repo and the `forge`
 * organization that owns it are made by the first save, so a forge that
 * never makes a board never has either. Each change is one commit authored
 * as the admin who made it, and leaves a `board.saved` or `board.deleted`
 * event.
 */
import type { App } from "../app.ts";
import { applyEdit, type Edit } from "../boards/edit.ts";
import { runQuery } from "../boards/query.ts";
import {
  BOARDS_OWNER, BOARDS_REPO, emptyBoard, isSlug, listBoards, parseBoard, readBoard, removeBoard, saveBoard, slugOf,
  type Board, type Stored, type StoreError,
} from "../boards/store.ts";
import { OFFERED_FILE, readOffered, STARTING_BOARDS } from "../boards/starting.ts";
import { commitFiles } from "../git/write.ts";
import { repoDir } from "../git/repos.ts";
import { commitIdentity, forgeHost } from "../core/commit_identity.ts";
import { createOrg } from "../core/orgs.ts";
import { createRepo, getRepo } from "../core/repos.ts";
import { getUserById, getUserByName, type User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export type BoardError = StoreError | "not_found" | "no_slug" | "repo" | { refused: string };

/** A refusal in words, for every door (the page, the terminal). A refused panel's text is the caller's to clean. */
export function boardRefusal(e: BoardError): string {
  if (typeof e === "object") return `That was refused: ${e.refused}.`;
  const words: Partial<Record<string, string>> = {
    not_found: "That board is gone.",
    invalid: "That is not a board.",
    exists: "A board with that name is already there.",
    no_slug: "A title needs letters or digits.",
    too_many: "There are too many boards already.",
    branch_moved: "The boards changed while you were saving; try again.",
    repo: "The boards repo could not be made.",
  };
  return words[e] ?? "That could not be saved.";
}

function admin(actor: User | undefined): Result<User, "not_found"> {
  return actor?.isAdmin === true && actor.kind !== "agent" ? ok(actor) : err("not_found");
}

/** The forge's boards repo, made if it is not there yet. */
export async function ensureRepo(app: App, who: User): Promise<boolean> {
  if (getRepo(app.db, BOARDS_OWNER, BOARDS_REPO)) return true;
  let owner = getUserByName(app.db, BOARDS_OWNER);
  if (!owner) {
    const org = createOrg(app.db, BOARDS_OWNER, who.id, { allowReserved: true });
    if (!org.ok) return false;
    owner = org.value;
  }
  if (owner.kind !== "org") return false;
  const made = await createRepo(app.db, app.reposRoot, {
    ownerId: owner.id,
    name: BOARDS_REPO,
    description: "The boards of this forge: one JSON file each.",
  });
  return made.ok;
}

export async function listAllBoards(app: App, actor: User | undefined): Promise<Result<Stored[], "not_found">> {
  const who = admin(actor);
  if (!who.ok) return who;
  return ok(getRepo(app.db, BOARDS_OWNER, BOARDS_REPO) ? await listBoards(app.reposRoot) : []);
}

export async function showBoard(app: App, actor: User | undefined, slug: string): Promise<Result<Board, "not_found">> {
  const who = admin(actor);
  if (!who.ok) return who;
  const board = await readBoard(app.reposRoot, slug);
  return board ? ok(board) : err("not_found");
}

/** Commit, then say so on the outbox. */
async function save(
  app: App, who: User, slug: string, board: unknown, message: string, mode: "create" | "update",
): Promise<Result<Board, BoardError>> {
  // Judge the board before any query runs; a panel that cannot run is refused on the way in.
  const parsed = parseBoard(board);
  if (!parsed.ok) return err({ refused: parsed.error });
  for (const p of parsed.value.panels) {
    const ran = runQuery(app.db, p.query, { repoIds: "all" });
    if (!ran.ok) return err({ refused: `${p.title}: ${ran.error}` });
  }
  const done = await saveBoard(app.reposRoot, slug, board, commitIdentity(app.config, who), message, mode);
  if (!done.ok) return done;
  app.bus.append({ kind: "board.saved", actorId: who.id, payload: { slug } });
  return done;
}

/** Make an empty board from a title; its slug is the title's, with a number if taken. */
export async function makeBoard(app: App, actor: User | undefined, title: string): Promise<Result<string, BoardError>> {
  const who = admin(actor);
  if (!who.ok) return who;
  const base = slugOf(title);
  if (base === "") return err("no_slug");
  if (!(await ensureRepo(app, who.value))) return err("repo");
  const board = emptyBoard(title);
  for (let n = 1; n <= 20; n++) {
    const slug = n === 1 ? base : `${base.slice(0, 36)}-${n}`;
    const done = await save(app, who.value, slug, board, `Make board ${slug}`, "create");
    if (done.ok) return ok(slug);
    if (done.error !== "exists") return done;
  }
  return err("exists");
}

/** Write a whole board under a slug (the API's door): made if new, replaced if there. */
export async function writeBoard(
  app: App, actor: User | undefined, slug: string, board: unknown,
): Promise<Result<Board, BoardError>> {
  const who = admin(actor);
  if (!who.ok) return who;
  if (!isSlug(slug)) return err("invalid");
  if (!(await ensureRepo(app, who.value))) return err("repo");
  const there = (await readBoard(app.reposRoot, slug)) !== undefined;
  return save(app, who.value, slug, board, `${there ? "Write" : "Make"} board ${slug}`, there ? "update" : "create");
}

/** Apply one edit to a board and commit it. */
export async function changeBoard(
  app: App, actor: User | undefined, slug: string, edit: Edit,
): Promise<Result<Board, BoardError>> {
  const who = admin(actor);
  if (!who.ok) return who;
  const board = await readBoard(app.reposRoot, slug);
  if (!board) return err("not_found");
  const next = applyEdit(board, edit);
  if (!next.ok) return err({ refused: next.error });
  return save(app, who.value, slug, next.value, `Change board ${slug}: ${edit.kind}`, "update");
}

/** Copy a board under a new slug (`<slug>-copy`, numbered if taken). */
export async function duplicateBoard(app: App, actor: User | undefined, slug: string): Promise<Result<string, BoardError>> {
  const who = admin(actor);
  if (!who.ok) return who;
  const board = await readBoard(app.reposRoot, slug);
  if (!board) return err("not_found");
  const copy: Board = { ...board, title: `${board.title} (copy)`.slice(0, 80) };
  for (let n = 1; n <= 20; n++) {
    const to = `${slug.slice(0, 33)}-copy${n === 1 ? "" : `-${n}`}`;
    if (!isSlug(to)) return err("no_slug");
    const done = await save(app, who.value, to, copy, `Duplicate board ${slug} as ${to}`, "create");
    if (done.ok) return ok(to);
    if (done.error !== "exists") return done;
  }
  return err("exists");
}

export async function deleteBoard(app: App, actor: User | undefined, slug: string): Promise<Result<true, BoardError>> {
  const who = admin(actor);
  if (!who.ok) return who;
  const done = await removeBoard(app.reposRoot, slug, commitIdentity(app.config, who.value), `Delete board ${slug}`);
  if (done.ok) app.bus.append({ kind: "board.deleted", actorId: who.value.id, payload: { slug } });
  return done;
}

/**
 * Write the starting boards the forge has not offered yet, in one commit
 * that also records them in `.offered`. A board that was offered is never
 * written again, so an edit stays and a deletion sticks. Needs a person who
 * is an admin to found the repo; without one nothing is written and the
 * next boot tries again. Returns the slugs written.
 */
export async function offerStartingBoards(app: App): Promise<string[]> {
  const founder = app.db
    .query<{ id: string }, []>("SELECT id FROM user WHERE is_admin = 1 AND is_agent = 0 AND kind = 'user' ORDER BY created_at LIMIT 1")
    .get();
  const person = founder ? getUserById(app.db, founder.id) : undefined;
  if (!person) return [];
  if (!(await ensureRepo(app, person))) return [];
  const offered = await readOffered(app.reposRoot);
  const fresh = Object.keys(STARTING_BOARDS).filter((slug) => !offered.includes(slug));
  if (fresh.length === 0) return [];
  // A board a person already made under that slug is theirs: recorded as offered, not written.
  const free: string[] = [];
  for (const slug of fresh) if ((await readBoard(app.reposRoot, slug)) === undefined) free.push(slug);
  const done = await commitFiles(repoDir(app.reposRoot, BOARDS_OWNER, BOARDS_REPO), {
    branch: "main",
    message: `Offer the starting boards: ${fresh.join(", ")}`,
    files: [
      ...free.map((slug) => ({ path: `${slug}.json`, content: `${JSON.stringify(STARTING_BOARDS[slug], null, 2)}\n` })),
      { path: OFFERED_FILE, content: `${JSON.stringify([...offered, ...fresh])}\n` },
    ],
    author: { name: "forge", email: `forge@${forgeHost(app.config)}` },
  });
  if (!done.ok) return [];
  return free;
}
