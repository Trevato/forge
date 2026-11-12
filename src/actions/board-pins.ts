/**
 * Pinned panels, for a forge admin who is a person (anyone else is told
 * `not_found`, as for `showBoard`): pin a board's panel to home, unpin it,
 * move it one step in the owner's order, list what is pinned. The web
 * forms, the terminal, `/api/v1/boards/pins` and the `board_pins` MCP tool
 * all come through here. A pin counts toward the limit only while its panel
 * still exists: a pin whose board was deleted or panel renamed is dropped
 * the next time its owner pins.
 */
import type { App } from "../app.ts";
import { MAX_PINS, listPins, movePin, pin, pinOf, unpin, type Pin } from "../boards/pins.ts";
import { readBoard, type Board, type Panel } from "../boards/store.ts";
import type { User } from "../core/users.ts";
import { forgetRegion } from "../core/region_memory.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export type PinError = "not_found" | "invalid" | "too_many";
export type Pinned = Pin & { board: Board; panel: Panel };

const person = (actor: User | undefined): User | undefined =>
  actor?.isAdmin === true && actor.kind !== "agent" ? actor : undefined;

/** The actor's pins that still name a panel, in their order, with the board and panel. */
async function resolved(app: App, who: User): Promise<{ live: Pinned[]; gone: Pin[] }> {
  const boards = new Map<string, Board | undefined>();
  const live: Pinned[] = [];
  const gone: Pin[] = [];
  for (const p of listPins(app.db, who.id)) {
    if (!boards.has(p.slug)) boards.set(p.slug, await readBoard(app.reposRoot, p.slug));
    const board = boards.get(p.slug);
    const panel = board?.panels.find((x) => x.title === p.title);
    if (board && panel) live.push({ ...p, board, panel });
    else gone.push(p);
  }
  return { live, gone };
}

/** Every door showing these pins (home's slot, the terminal's screen) redraws: an event for its owner alone. */
export const PINS_EVENT = "board.pins";
const moved = (app: App, who: User): void => void app.bus.append({ kind: "board.pins", actorId: who.id });

export async function listPinned(app: App, actor: User | undefined): Promise<Result<Pinned[], "not_found">> {
  const who = person(actor);
  return who ? ok((await resolved(app, who)).live) : err("not_found");
}

export async function pinPanel(app: App, actor: User | undefined, slug: unknown, title: unknown): Promise<Result<Pin, PinError>> {
  const who = person(actor);
  if (!who) return err("not_found");
  const which = pinOf(slug, title);
  if (!which) return err("invalid");
  const board = await readBoard(app.reposRoot, which.slug);
  if (!board?.panels.some((p) => p.title === which.title)) return err("not_found");
  const { live, gone } = await resolved(app, who);
  for (const g of gone) unpin(app.db, who.id, g);
  if (live.length >= MAX_PINS && !live.some((p) => p.slug === which.slug && p.title === which.title)) return err("too_many");
  pin(app.db, who.id, which);
  forgetRegion(app.db, who.id, "panels");
  moved(app, who);
  return ok(which);
}

export function unpinPanel(app: App, actor: User | undefined, slug: unknown, title: unknown): Result<Pin, PinError> {
  const who = person(actor);
  if (!who) return err("not_found");
  const which = pinOf(slug, title);
  if (!which) return err("invalid");
  unpin(app.db, who.id, which);
  forgetRegion(app.db, who.id, "panels");
  moved(app, who);
  return ok(which);
}

export function movePinned(app: App, actor: User | undefined, slug: unknown, title: unknown, by: unknown): Result<Pin, PinError> {
  const who = person(actor);
  if (!who) return err("not_found");
  const which = pinOf(slug, title);
  if (!which || (by !== 1 && by !== -1)) return err("invalid");
  if (!listPins(app.db, who.id).some((x) => x.slug === which.slug && x.title === which.title)) return err("not_found");
  movePin(app.db, who.id, which, by);
  forgetRegion(app.db, who.id, "panels");
  moved(app, who);
  return ok(which);
}
