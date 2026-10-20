/**
 * The forge pill: one small script the app proxy adds to an app's HTML
 * pages. It is a file on the forge's own origin, content-addressed and
 * immutable, so the page needs no inline script and an app's CSP that
 * allows no foreign scripts simply leaves the pill out.
 *
 * The pill lives in a shadow root, sits in the bottom-right corner, and is
 * collapsed to a dot until pressed. It styles itself through the CSSOM
 * (never a `style` attribute or a `<style>` element), which a strict
 * `style-src` does not block.
 */

import { staticResponse } from "../web/asset.ts";
import { sha256 } from "../kernel/hash.ts";

/** The client, as plain source: no `eval`, no inline handlers. */
export const toolbarJs = `(function () {
  if (window.__forgeToolbar) return;
  window.__forgeToolbar = true;
  var me = document.currentScript;
  var home = "/";
  try { home = new URL(me.src).origin + "/"; } catch (e) {}
  var host = document.createElement("div");
  host.id = "forge-toolbar";
  host.style.cssText = "all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647";
  var root = host.attachShadow({ mode: "closed" });
  var box = document.createElement("div");
  box.style.cssText = "font:13px/1.3 system-ui,sans-serif;color:#fff;display:flex;align-items:center;gap:8px;flex-direction:row-reverse";
  var pill = document.createElement("button");
  pill.type = "button";
  var d = me.dataset || {};
  var where = d.env === "production" ? "production" : d.pull ? "preview of pull #" + d.pull : "";
  pill.setAttribute("aria-label", [d.app, where].filter(Boolean).join(", ") || "Forge");
  pill.setAttribute("aria-expanded", "false");
  pill.textContent = "\\u2692";
  pill.style.cssText = "all:unset;box-sizing:border-box;cursor:pointer;width:44px;height:44px;border-radius:22px;background:#1f2328;color:#fff;text-align:center;line-height:44px;font-size:20px;opacity:.85;box-shadow:0 1px 4px rgba(0,0,0,.4)";
  var panel = document.createElement("div");
  panel.hidden = true;
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Where you are");
  panel.tabIndex = -1;
  panel.style.cssText = "outline:none;background:#1f2328;color:#fff;padding:8px 12px;border-radius:14px;box-shadow:0 1px 4px rgba(0,0,0,.4);max-width:min(280px,calc(100vw - 64px));flex-direction:column;gap:2px;display:none";
  var x = document.createElement("button");
  x.type = "button";
  x.textContent = "\\u00d7";
  x.setAttribute("aria-label", "Close");
  x.style.cssText = "all:unset;box-sizing:border-box;cursor:pointer;align-self:flex-end;min-width:44px;min-height:44px;text-align:center;line-height:44px;font-size:20px;margin:-8px -12px -8px 0";
  x.addEventListener("focus", function () { x.style.outline = "3px solid #58a6ff"; });
  x.addEventListener("blur", function () { x.style.outline = "none"; });
  x.addEventListener("click", function () { set(false); pill.focus(); });
  panel.appendChild(x);
  function line(text, bold) {
    var el = document.createElement("div");
    el.textContent = text;
    el.style.cssText = "overflow-wrap:anywhere;" + (bold ? "font-weight:600" : "opacity:.85");
    panel.appendChild(el);
  }
  if (d.app) line(d.app, true);
  if (d.env === "production") line("Production");
  else if (d.pull) line("Preview of pull #" + d.pull);
  if (d.title) line(d.title);
  var link = document.createElement("a");
  link.textContent = "Home";
  link.rel = "noopener";
  link.style.cssText = "color:#8ab4ff;text-decoration:none;display:flex;align-items:center;min-height:44px";
  try {
    var target = new URL(home);
    if (target.origin === new URL(me.src).origin) link.href = target.href;
  } catch (e) {}
  // The crew line arrives late, so it lands in a polite live region.
  var crew = document.createElement("div");
  crew.setAttribute("aria-live", "polite");
  panel.appendChild(crew);
  panel.appendChild(link);
  // The actions live on a forge page, opened in a tab of its own: the bar
  // posts nothing and reads nothing of this page beyond its address.
  if (d.repo && /^[\\w.-]+\\/[\\w.-]+$/.test(d.repo)) {
    var act = document.createElement("a");
    act.textContent = "Comment, tell, make it yours";
    act.target = "_blank";
    act.rel = "noopener noreferrer";
    act.style.cssText = "color:#8ab4ff;text-decoration:none;margin-top:4px";
    try {
      var dest = new URL(home);
      dest.pathname = "/" + d.repo + "/toolbar";
      dest.searchParams.set("env", d.env === "production" ? "production" : "pull-" + d.pull);
      dest.searchParams.set("page", location.origin + location.pathname);
      act.href = dest.href;
      panel.appendChild(act);
    } catch (e) {}
  }
  // Who of the crew is working here, asked once as the pill loads, of the
  // app's own origin (same-origin, so its grant cookie goes along); nothing
  // is shown idle.
  try {
    fetch("/__forge/crew", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : {}; })
      .then(function (c) {
        if (!c) return;
        var forge = new URL(me.src).origin;
        // Signed in, the crew can be told from here. The form is the forge's
        // own page, on its own origin, with its own CSRF check: the app's
        // page only carries the address and the pull to it.
        if (typeof c.tell === "string") {
          var t = new URL(c.tell);
          if (t.origin === forge) {
            t.searchParams.set("page", location.href);
            if (d.pull) t.searchParams.set("pull", d.pull);
            var ta = document.createElement("a");
            ta.textContent = "Tell the crew";
            ta.target = "_blank";
            ta.rel = "noopener";
            ta.href = t.href;
            ta.style.cssText = "color:#8ab4ff;text-decoration:none;display:flex;align-items:center;min-height:44px";
            crew.appendChild(ta);
          }
        }
        if (typeof c.who !== "string" || typeof c.url !== "string") return;
        var u = new URL(c.url);
        if (u.origin !== forge) return;
        var a = document.createElement("a");
        a.textContent = c.who + " is working on this";
        a.rel = "noopener";
        a.href = u.href;
        a.style.cssText = "color:#8ab4ff;text-decoration:none;display:flex;align-items:center;min-height:44px";
        crew.appendChild(a);
      })
      .catch(function () {});
  } catch (e) {}
  // An inline display beats the UA [hidden] rule, so display carries the state.
  var key = "forge-pill:" + (d.app || "");
  function remember(open) {
    try { window.localStorage.setItem(key, open ? "open" : "closed"); } catch (e) {}
  }
  function set(open, quiet) {
    panel.hidden = !open;
    panel.style.display = open ? "flex" : "none";
    pill.setAttribute("aria-expanded", open ? "true" : "false");
    pill.style.opacity = open ? "1" : ".85";
    if (!quiet) remember(open);
    if (open && !quiet) panel.focus();
  }
  pill.addEventListener("click", function () { set(panel.hidden); });
  pill.addEventListener("focus", function () { pill.style.outline = "3px solid #58a6ff"; pill.style.outlineOffset = "2px"; });
  pill.addEventListener("blur", function () { pill.style.outline = "none"; });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || panel.hidden) return;
    set(false);
    pill.focus();
  });
  document.addEventListener("pointerdown", function (e) {
    if (panel.hidden) return;
    var path = e.composedPath ? e.composedPath() : [];
    if (path.indexOf(host) < 0) set(false);
  });
  box.appendChild(pill);
  box.appendChild(panel);
  root.appendChild(box);
  (document.body || document.documentElement).appendChild(host);
  set(false, true);
  try { if (window.localStorage.getItem(key) === "open") set(true, true); } catch (e) {}
})();
`;

const hash = sha256(toolbarJs);
const name = `toolbar-${hash.slice(0, 16)}`;

/** The path the script is served from on the forge, content-addressed. */
export const TOOLBAR_PATH = `/assets/${name}.js`;
export const TOOLBAR_NAME = name;

/** The forge's answer for the script: immutable, because its name is its hash. */
export function toolbarResponse(request: Request): Response {
  return staticResponse(request, toolbarJs, "text/javascript; charset=utf-8", `"${hash}"`);
}

/** The largest page the proxy will hold in memory to add the tag to. */
export const REWRITE_MAX = 4 * 1024 * 1024;

const SAFE_CHARSETS = new Set(["utf-8", "utf8", "us-ascii", "iso-8859-1", "latin1", "windows-1252"]);

/**
 * Whether a response's headers say its body can be rewritten byte-wise:
 * HTML, not compressed, not an attachment, in a charset where `</body>`
 * is plain ASCII, and of a length that is declared and bounded.
 */
export function rewritable(headers: Headers, status: number): boolean {
  if (status < 200 || status === 204 || status === 205 || status === 206 || status === 304)
    return false;
  // A byte range cannot be rewritten: Content-Range would stop matching.
  if (headers.has("content-range")) return false;
  const type = (headers.get("content-type") ?? "").toLowerCase();
  if (!type.startsWith("text/html")) return false;
  const charset = /charset\s*=\s*"?([^";\s]+)/.exec(type)?.[1];
  if (charset !== undefined && !SAFE_CHARSETS.has(charset)) return false;
  const encoding = (headers.get("content-encoding") ?? "").toLowerCase();
  if (encoding !== "" && encoding !== "identity") return false;
  if ((headers.get("content-disposition") ?? "").toLowerCase().startsWith("attachment"))
    return false;
  const length = headers.get("content-length");
  if (length === null || !/^\d{1,9}$/.test(length)) return false;
  return Number(length) <= REWRITE_MAX;
}

/** What the pill says about where it is; the title only for a reader of the pull. */
export type PillWhere = {
  app: string;
  /** `owner/name`, where the forge page of the bar's actions lives. */
  repo?: string;
  env: string;
  pull?: number;
  title?: string;
};

/** `text` safe inside a double-quoted HTML attribute. */
export function escapeAttr(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&#39;");
}

/** The script tag, with where-you-are as escaped data attributes. */
export function toolbarTag(forgeUrl: string, where?: PillWhere): string {
  const data =
    where === undefined
      ? ""
      : [
          ["app", where.app],
          ["repo", where.repo],
          ["env", where.env],
          ["pull", where.pull === undefined ? undefined : String(where.pull)],
          ["title", where.title],
        ]
          .filter((pair): pair is [string, string] => pair[1] !== undefined)
          .map(([k, v]) => ` data-${k}="${escapeAttr(v)}"`)
          .join("");
  return `<script src="${new URL(TOOLBAR_PATH, forgeUrl).href}"${data} defer></script>`;
}

/** `bytes` with the pill's tag before the last `</body>`, or at the end. */
export function withToolbar(
  bytes: Uint8Array,
  forgeUrl: string,
  where?: PillWhere,
): Uint8Array<ArrayBuffer> {
  const tag = Buffer.from(toolbarTag(forgeUrl, where));
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // latin1 is one character per byte, so an index in it is a byte offset.
  const at = buffer.toString("latin1").toLowerCase().lastIndexOf("</body");
  const cut = at < 0 ? buffer.length : at;
  return Buffer.concat([buffer.subarray(0, cut), tag, buffer.subarray(cut)]);
}
