/**
 * The forge's boards over the API: `/api/v1/boards` and what hangs under it —
 * the sources a query may read, a query run once, the board list, the home
 * pins, one board, one panel's data, and a board written or deleted. Moved
 * out of `api.ts` (#6326); the rules live in `actions/boards.ts`,
 * `actions/board-pins.ts` and `boards/`.
 */

import { listPinned as listPinnedPanels, movePinned, pinPanel, unpinPanel, type PinError } from "../../actions/board-pins.ts";
import { deleteBoard, listAllBoards, showBoard, writeBoard, type BoardError } from "../../actions/boards.ts";
import { BOARD_NOT_SAVED } from "../../actions/board_words.ts";
import { panelData, parseWindow, rowsCsv } from "../../boards/panel_data.ts";
import { runQuery } from "../../boards/query.ts";
import { SOURCES } from "../../boards/sources.ts";
import { PIN_OP_WORDS } from "../../core/arg_words.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { boardsAdmin } from "../api.ts";
import type { Handler } from "../context.ts";
import { holds, weakEtag } from "../etag.ts";
import { bodyCapFor, readBounded } from "../limits.ts";
import { apiError, json, notFound, requireAccount } from "../respond.ts";
import type { Router } from "../router.ts";

/**
 * An owner-scoped JSON answer tagged by its exact bytes: a repeat holding the
 * tag gets 304. Callers check access first, so a 304 confirms nothing to
 * someone who may not read it.
 */
function tagged(request: Request, data: unknown): Response {
  const text = JSON.stringify(data);
  const etag = weakEtag(text);
  const headers = { etag, "cache-control": "private, no-cache", vary: "authorization, cookie" };
  if (holds(request, etag)) return new Response(null, { status: 304, headers });
  return new Response(text, { headers: { "content-type": "application/json", ...headers } });
}

export function boardRoutes(router: Router<Handler>): void {
  router.add("GET", "/api/v1/boards/sources", (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = boardsAdmin(ctx);
    if (denied) return denied;
    const sources = timePhase(ctx.request, "sources", () =>
      Object.entries(SOURCES).map(([name, s]) => ({
        name,
        time: s.time,
        columns: s.columns,
        ...(s.docs ? { docs: s.docs } : {}),
      })));
    return timePhase(ctx.request, "render", () => json({ sources }));
  });

  router.add("POST", "/api/v1/boards/query", async (ctx) => {
    const denied = boardsAdmin(ctx) ?? requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const bytes = await readBounded(ctx.request, bodyCapFor(ctx.request));
    if (bytes === "too_large") return apiError("too_large", 413, "that is too large to read here");
    let query: unknown;
    try {
      query = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return apiError("bad_json", 400, "the body must be a JSON query object");
    }
    const answer = runQuery(ctx.app.db, query, { repoIds: "all" });
    return answer.ok
      ? json({ rows: answer.rows })
      : apiError("bad_query", 400, answer.error);
  });

  const boardFailed = (e: BoardError): Response => {
    if (e === "not_found") return notFound();
    if (typeof e === "object") return apiError("refused", 422, e.refused);
    return apiError(e, e === "exists" || e === "branch_moved" ? 409 : 422, BOARD_NOT_SAVED);
  };

  router.add("GET", "/api/v1/boards", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = boardsAdmin(ctx);
    if (denied) return denied;
    const listed = await timePhaseAsync(ctx.request, "boards", () => listAllBoards(ctx.app, ctx.auth.user));
    return timePhase(ctx.request, "render", () =>
      listed.ok
        ? tagged(ctx.request, { boards: listed.value.map((b) => ({ slug: b.slug, ...b.board })) })
        : notFound());
  });

  // The signed-in admin's pins for home: GET lists them in order, POST
  // {op: pin|unpin|move, slug, title, by?} changes them. Above `:slug`.
  router.add("GET", "/api/v1/boards/pins", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = boardsAdmin(ctx);
    if (denied) return denied;
    const listed = await timePhaseAsync(ctx.request, "boards", () => listPinnedPanels(ctx.app, ctx.auth.user));
    return timePhase(ctx.request, "render", () =>
      listed.ok ? tagged(ctx.request, { pins: listed.value.map((p) => ({ slug: p.slug, title: p.title, panel: p.panel })) }) : notFound());
  });

  router.add("POST", "/api/v1/boards/pins", async (ctx) => {
    const denied = boardsAdmin(ctx) ?? requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const bytes = await readBounded(ctx.request, bodyCapFor(ctx.request));
    if (bytes === "too_large") return apiError("too_large", 413, "that is too large to read here");
    let input: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      input = parsed as Record<string, unknown>;
    } catch {
      return apiError("bad_json", 400, "the body must be a JSON object");
    }
    const { op, slug, title, by } = input;
    const done =
      op === "pin" ? await pinPanel(ctx.app, ctx.auth.user, slug, title)
      : op === "unpin" ? unpinPanel(ctx.app, ctx.auth.user, slug, title)
      : op === "move" ? movePinned(ctx.app, ctx.auth.user, slug, title, by)
      : undefined;
    if (!done) return apiError("invalid", 422, PIN_OP_WORDS);
    if (done.ok) return json({ ...done.value });
    const e: PinError = done.error;
    return e === "not_found" ? notFound() : apiError(e, 422, e === "too_many" ? "too many pins" : "that is not a panel");
  });

  router.add("GET", "/api/v1/boards/:slug", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = boardsAdmin(ctx);
    if (denied) return denied;
    const shown = await timePhaseAsync(ctx.request, "boards", () => showBoard(ctx.app, ctx.auth.user, ctx.params.slug!));
    return timePhase(ctx.request, "render", () =>
      shown.ok ? tagged(ctx.request, { slug: ctx.params.slug, ...shown.value }) : notFound());
  });

  // One panel's data (`boards/panel_data.ts`): `:id` is its place on the
  // board from 0; `from`, `to` and `step` (300, 5m, 1h) the window;
  // `format=csv` the same rows as a table file.
  router.add("GET", "/api/v1/boards/:slug/panels/:id", async (ctx) => {
    notePhase(ctx.request, "session", takeSessionTime(ctx.request));
    const denied = boardsAdmin(ctx);
    if (denied) return denied;
    const shown = await timePhaseAsync(ctx.request, "board", () =>
      showBoard(ctx.app, ctx.auth.user, ctx.params.slug!),
    );
    const id = ctx.params.id!;
    const panel = shown.ok && /^\d{1,2}$/.test(id) ? shown.value.panels[Number(id)] : undefined;
    if (!shown.ok || !panel) return notFound();
    const format = ctx.url.searchParams.get("format") ?? "json";
    if (format !== "json" && format !== "csv") return apiError("invalid_format", 422, "format must be json or csv");
    const window = parseWindow(ctx.url.searchParams);
    if (!window.ok) return apiError("invalid_window", 422, window.error);
    const data = timePhase(ctx.request, "query", () =>
      panelData(ctx.app.db, shown.value, panel, window.window),
    );
    if (!data.ok) return apiError("bad_query", 400, data.error);
    const headers = { "cache-control": "private, no-store" };
    return timePhase(ctx.request, "render", () => {
      if (format === "csv") {
        return new Response(rowsCsv(data.rows), {
          headers: {
            ...headers,
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="${ctx.params.slug}-${id}.csv"`,
          },
        });
      }
      const { ok: _, ...out } = data;
      return json({ board: ctx.params.slug, panel: Number(id), title: panel.title, chart: panel.chart, ...out }, 200, headers);
    });
  });

  router.add("PUT", "/api/v1/boards/:slug", async (ctx) => {
    const denied = boardsAdmin(ctx) ?? requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const bytes = await readBounded(ctx.request, bodyCapFor(ctx.request));
    if (bytes === "too_large") return apiError("too_large", 413, "that is too large to read here");
    let input: unknown;
    try {
      input = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return apiError("bad_json", 400, "the body must be a JSON board");
    }
    const done = await writeBoard(ctx.app, ctx.auth.user, ctx.params.slug!, input);
    return done.ok ? json({ slug: ctx.params.slug, ...done.value }) : boardFailed(done.error);
  });

  router.add("DELETE", "/api/v1/boards/:slug", async (ctx) => {
    const denied = boardsAdmin(ctx) ?? requireAccount(ctx, { adminToken: true });
    if (denied) return denied;
    const done = await deleteBoard(ctx.app, ctx.auth.user, ctx.params.slug!);
    return done.ok ? json({ deleted: true }) : boardFailed(done.error);
  });
}
