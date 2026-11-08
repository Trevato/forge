/**
 * The forms of `/boards`: make a board, pin a query to one, and the changes
 * `/boards/:slug/:op` takes (rename, settings, add, edit, remove, move,
 * duplicate, delete). Each one is same-origin checked by `readForm` before
 * anything is read, answers with a redirect and a flash, and leaves the
 * work to `actions/boards.ts`.
 */
import {
  boardRefusal, changeBoard, deleteBoard, duplicateBoard, makeBoard, type BoardError,
} from "../../actions/boards.ts";
import type { Edit } from "../../boards/edit.ts";
import { movePinned, pinPanel, unpinPanel } from "../../actions/board-pins.ts";
import { isSlug } from "../../boards/store.ts";
import type { Ctx } from "../../http/context.ts";
import { notFoundPage } from "../chrome.ts";
import { backTo, field, readForm, type Form } from "../form.ts";
import { flashTo } from "../layout.ts";
import { PANEL_FIELDS, readParams, toQuery } from "./boards.ts";

const num = (v: string) => (/^-?\d{1,4}$/.test(v) ? Number(v) : NaN);

/** A panel as the form says it: title, size, chart, and the query the shared fields build. */
function panelOf(form: Form): Record<string, unknown> {
  const search = new URLSearchParams();
  for (const k of PANEL_FIELDS) search.set(k, field(form, k));
  const p = readParams(search);
  return { title: field(form, "title"), chart: p.chart, query: toQuery(p), w: num(field(form, "w")), h: num(field(form, "h")) };
}

/** A panel to remove: from the form, or from the query the confirm page posts to (#8030). */
function removeOf(form: Form, query: URLSearchParams): Edit {
  const fromForm = field(form, "index") !== "";
  const index = fromForm ? field(form, "index") : query.get("index") ?? "";
  const title = fromForm ? field(form, "title") : query.get("title") ?? "";
  return title === "" ? { kind: "remove", index: num(index) } : { kind: "remove", index: num(index), title };
}

function editOf(op: string, form: Form, query: URLSearchParams): Edit | undefined {
  switch (op) {
    case "rename": return { kind: "title", title: field(form, "title") };
    case "settings": return { kind: "settings", range: field(form, "range"), refresh: field(form, "refresh") };
    case "add": return { kind: "add", panel: panelOf(form) };
    case "edit": return { kind: "edit", index: num(field(form, "index")), panel: panelOf(form) };
    case "remove": return removeOf(form, query);
    case "move": {
      const by = num(field(form, "by"));
      return by === 1 || by === -1 ? { kind: "move", index: num(field(form, "index")), by } : undefined;
    }
    default: return undefined;
  }
}

const done = (ctx: Ctx, to: string, message: string) => flashTo(ctx, to, { message });
const failed = (ctx: Ctx, to: string, e: BoardError) =>
  e === "not_found" ? notFoundPage(ctx) : flashTo(ctx, to, { tone: "danger", message: boardRefusal(e) });

// POST /boards/new
export async function boardNew(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const made = await makeBoard(ctx.app, ctx.auth.user, field(form, "title"));
  if (!made.ok) return failed(ctx, "/boards", made.error);
  return done(ctx, `/boards/${made.value}`, "Board made.");
}

// POST /boards/pin — a query from /boards/data, added to the board `slug`
export async function boardPin(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const slug = field(form, "slug");
  if (!isSlug(slug)) return notFoundPage(ctx);
  const changed = await changeBoard(ctx.app, ctx.auth.user, slug, { kind: "add", panel: panelOf(form) });
  if (!changed.ok) return failed(ctx, "/boards/data", changed.error);
  return done(ctx, `/boards/${slug}`, "Panel added.");
}

// POST /boards/:slug/:op
export async function boardPost(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const slug = ctx.params.slug ?? "";
  const op = ctx.params.op ?? "";
  if (!isSlug(slug)) return notFoundPage(ctx);
  const back = `/boards/${slug}`;
  if (op === "duplicate") {
    const copy = await duplicateBoard(ctx.app, ctx.auth.user, slug);
    return copy.ok ? done(ctx, `/boards/${copy.value}`, "Board duplicated.") : failed(ctx, back, copy.error);
  }
  if (op === "delete") {
    const gone = await deleteBoard(ctx.app, ctx.auth.user, slug);
    return gone.ok ? done(ctx, "/boards", "Board deleted.") : failed(ctx, back, gone.error);
  }
  const edit = editOf(op, form, ctx.url.searchParams);
  if (!edit) return notFoundPage(ctx);
  const changed = await changeBoard(ctx.app, ctx.auth.user, slug, edit);
  return changed.ok ? done(ctx, back, "Saved.") : failed(ctx, back, changed.error);
}

/**
 * POST /boards/pin-panel, /boards/unpin-panel, /boards/move-pin — the
 * signed-in admin's own pins for home, through `actions/board-pins.ts`.
 */
export async function pinPost(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx, "admin");
  if (form instanceof Response) return form;
  const op = ctx.url.pathname.slice("/boards/".length);
  const [slug, title] = [field(form, "slug"), field(form, "title")];
  const back = backTo(form, "/");
  const by = num(field(form, "by"));
  const run = {
    "pin-panel": () => pinPanel(ctx.app, ctx.auth.user, slug, title),
    "unpin-panel": () => unpinPanel(ctx.app, ctx.auth.user, slug, title),
    "move-pin": () => movePinned(ctx.app, ctx.auth.user, slug, title, by),
  }[op];
  if (!run) return notFoundPage(ctx);
  const done = await run();
  if (done.ok) return flashTo(ctx, back, { message: { "pin-panel": "Pinned to home.", "unpin-panel": "Unpinned.", "move-pin": "Moved." }[op]! });
  if (done.error === "not_found") return notFoundPage(ctx);
  return flashTo(ctx, back, { tone: "danger", message: done.error === "too_many" ? "That is too many pins." : "That is not a panel." });
}
