/**
 * What home paints first (#7660): a region as it was last drawn for this
 * viewer, from memory (`core/region_memory.ts`). A region whose figures are
 * current (the write clock has not moved, 30 seconds at most) is served as
 * is. After a write it is served stale, marked `data-refresh`, drawn again
 * after the response, and swapped for the fresh one by the page's script from
 * `/live/home/<region>`, but only while the viewer's access fingerprint
 * (`core/access_fingerprint.ts`) is what it was when the copy was drawn: a
 * viewer whose access changed is drawn fresh, whatever the script does.
 *
 * The variant is built by `homeVariant` from the few query parameters home
 * reads, validated, so the keys a client can make are bounded.
 */
import type { Database } from "bun:sqlite";
import { notePhase } from "../../core/route_timing.ts";
import { forgetAll, recall, remember } from "../../core/region_memory.ts";
import { writeStamp } from "../../core/write_clock.ts";
import { parseCursor } from "../../feed/feed.ts";
import { escapeHtml, raw, type Html } from "../html.ts";
import { HOME_MAX_AGE_MS } from "./home_cache.ts";

/** The regions home draws late, by name; each has a fragment at `/live/home/<name>`. */
export const HOME_REGIONS = ["kpis", "waiting", "panels", "asked", "feed"] as const;
export type HomeRegion = (typeof HOME_REGIONS)[number];

/** A region is redrawn after a response at most this often; the page's own swap draws it fresh in between. */
const REDRAW_GAP_MS = 5_000;
const drawing = new Map<string, number>();

/** The query string home's regions read, rebuilt from what validates: `all`, a feed `cursor` and its `day`. */
export function homeVariant(url: URL): string {
  const q = new URLSearchParams();
  if (url.searchParams.get("all") !== null) q.set("all", "1");
  const cursor = url.searchParams.get("cursor") ?? "";
  if (cursor.length <= 64 && parseCursor(cursor) !== undefined) {
    q.set("cursor", cursor);
    const day = url.searchParams.get("day") ?? "";
    if (/^\d{4}-\d{2}-\d{2}(T[\d:.]{1,16}Z?)?$/.test(day)) q.set("day", day);
  }
  const text = q.toString();
  return text === "" ? "" : `?${text}`;
}

/** Drop everything remembered: for tests. */
export const forgetHome = forgetAll;

/**
 * The region `name` for `viewerId`, wrapped so the page can swap it. `draw`
 * draws it here; the fragment that draws it fresh is `/live/home/<name><variant>`.
 */
export async function homeRegion(
  db: Database,
  request: Request,
  viewerId: string,
  name: HomeRegion,
  variant: string,
  access: string,
  draw: () => Html | Promise<Html>,
): Promise<Html> {
  const started = performance.now();
  const key = `${viewerId}\0${name}\0${variant}`;
  const src = `/live/home/${name}${variant}`;
  const stamp = writeStamp(db);
  const had = recall(db, viewerId, name, variant, access);
  const wrap = (body: string, stale: boolean): Html =>
    raw(
      stale
        ? `<div id="home-${name}" data-region data-refresh="${escapeHtml(src)}">${body}<noscript><p class="small muted">Shown as of a moment ago. <a href="${escapeHtml(src)}">Open the current ones</a>.</p></noscript></div>`
        : `<div id="home-${name}" data-region>${body}</div>`,
    );
  if (had !== undefined) {
    const current = stamp !== undefined && had.stamp === stamp && Date.now() - had.at < HOME_MAX_AGE_MS;
    if (!current && Date.now() - (drawing.get(key) ?? 0) >= REDRAW_GAP_MS) {
      if (drawing.size > 1024) for (const [k, at] of drawing) if (at !== Number.MAX_SAFE_INTEGER) drawing.delete(k);
      drawing.set(key, Number.MAX_SAFE_INTEGER);
      // Read when the redraw is decided, not when the timer fires: a write that lands in between must leave the copy stale, not current.
      const before = stamp;
      setTimeout(() => {
        void (async () => {
          try {
            remember(db, viewerId, name, variant, (await draw()).text, before, access);
          } catch {
            // The page's own swap asks again and shows the failure.
          } finally {
            drawing.set(key, Date.now());
          }
        })();
      }, 0);
    }
    notePhase(request, name, performance.now() - started, true);
    return wrap(had.html, !current);
  }
  const body = await draw();
  remember(db, viewerId, name, variant, body.text, stamp, access);
  return wrap(body.text, false);
}

/** A fragment's answer for `name`: drawn now, and remembered. */
export async function homeFresh(
  db: Database,
  viewerId: string,
  name: HomeRegion,
  variant: string,
  access: string,
  draw: () => Html | Promise<Html>,
): Promise<Html> {
  const stamp = writeStamp(db);
  const body = await draw();
  remember(db, viewerId, name, variant, body.text, stamp, access);
  return body;
}

/** The page's half: a region served from memory that has gone stale is drawn fresh and swapped in. */
export const refreshJs = /* js */ `
(function () {
  if (!window.fetch || !window.HTMLTemplateElement) return;
  Array.prototype.forEach.call(document.querySelectorAll('[data-refresh]'), function (el) {
    fetch(el.getAttribute('data-refresh'), { credentials: 'same-origin', headers: { accept: 'text/html' } })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (text) {
        var holder = document.createElement('template');
        holder.innerHTML = text;
        var root = holder.content.firstElementChild;
        if (!root) { el.removeAttribute('data-refresh'); return; }
        // A region that owns its element (the feed, bound once by its script) is swapped inside it.
        var inner = root.children.length === 1 ? root.firstElementChild : null;
        var mine = inner && inner.id ? el.querySelector('#' + inner.id) : null;
        if (mine) mine.innerHTML = inner.innerHTML; else el.innerHTML = root.innerHTML;
        el.removeAttribute('data-refresh');
        el.dispatchEvent(new CustomEvent('forge:swapped', { bubbles: true }));
      })
      .catch(function () { el.removeAttribute('data-refresh'); });
  });
})();
`;
