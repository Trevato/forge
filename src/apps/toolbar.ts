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
  pill.setAttribute("aria-label", "Forge");
  pill.setAttribute("aria-expanded", "false");
  pill.textContent = "\\u2692";
  pill.style.cssText = "all:unset;box-sizing:border-box;cursor:pointer;width:28px;height:28px;border-radius:14px;background:#1f2328;color:#fff;text-align:center;line-height:28px;font-size:14px;opacity:.55;box-shadow:0 1px 4px rgba(0,0,0,.4)";
  var panel = document.createElement("a");
  panel.href = home;
  panel.target = "_blank";
  panel.rel = "noopener";
  panel.textContent = "Built on forge";
  panel.hidden = true;
  panel.style.cssText = "background:#1f2328;color:#fff;padding:6px 10px;border-radius:14px;text-decoration:none;white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.4)";
  function set(open) {
    panel.hidden = !open;
    pill.setAttribute("aria-expanded", open ? "true" : "false");
    pill.style.opacity = open ? "1" : ".55";
  }
  pill.addEventListener("click", function () { set(panel.hidden); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") set(false); });
  box.appendChild(pill);
  box.appendChild(panel);
  root.appendChild(box);
  (document.body || document.documentElement).appendChild(host);
})();
`;

const name = `toolbar-${sha256(toolbarJs).slice(0, 16)}`;

/** The path the script is served from on the forge, content-addressed. */
export const TOOLBAR_PATH = `/assets/${name}.js`;
export const TOOLBAR_NAME = name;

/** The forge's answer for the script: immutable, because its name is its hash. */
export function toolbarResponse(): Response {
  return new Response(toolbarJs, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
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
  if (status < 200 || status === 204 || status === 205 || status === 304)
    return false;
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

/** `bytes` with the pill's tag before the last `</body>`, or at the end. */
export function withToolbar(bytes: Uint8Array, forgeUrl: string): Uint8Array {
  const tag = Buffer.from(
    `<script src="${new URL(TOOLBAR_PATH, forgeUrl).href}" defer></script>`,
  );
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // latin1 is one character per byte, so an index in it is a byte offset.
  const at = buffer.toString("latin1").toLowerCase().lastIndexOf("</body");
  const cut = at < 0 ? buffer.length : at;
  return Buffer.concat([buffer.subarray(0, cut), tag, buffer.subarray(cut)]);
}
