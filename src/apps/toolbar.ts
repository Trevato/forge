/**
 * The forge pill: one small script the app proxy adds to an app's HTML
 * pages. It is a file on the forge's own origin, content-addressed and
 * immutable, so the page needs no inline script and an app's CSP that
 * allows no foreign scripts simply leaves the pill out.
 *
 * The pill lives in a shadow root and is collapsed to a dot until pressed.
 * It sits bottom-right until dragged or arrow-keyed to another corner; the
 * corner is kept per app host in localStorage. It styles itself through the CSSOM
 * (never a `style` attribute or a `<style>` element), which a strict
 * `style-src` does not block.
 */

import { staticResponse } from "../web/asset.ts";
import { sha256 } from "../kernel/hash.ts";
import { NOTE_EMPTY, NOTE_FAILED, PROOF_LOST } from "./note_words.ts";

/** The client, as plain source: no `eval`, no inline handlers. */
export const toolbarJs = `(function () {
  if (window.__forgeToolbar) return;
  window.__forgeToolbar = true;
  var me = document.currentScript;
  var home = "/";
  try { home = new URL(me.src).origin + "/"; } catch (e) {}
  var host = document.createElement("div");
  host.id = "forge-toolbar";
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647";
  var root = host.attachShadow({ mode: "closed" });
  var box = document.createElement("div");
  box.style.cssText = "font:13px/1.3 system-ui,sans-serif;color:#fff;display:flex;align-items:flex-end;gap:8px;flex-direction:row-reverse";
  var pill = document.createElement("button");
  pill.type = "button";
  var d = me.dataset || {};
  // The one-use proof the forge put on this page load: taken, then gone from the page.
  var proof = d.proof || "";
  if (me.removeAttribute) me.removeAttribute("data-proof");
  var queue = Promise.resolve();
  var lost = false;
  // The chain broke (a failed call, or an answer with no next proof): say so once, in the panel.
  function broke() {
    proof = "";
    lost = true;
    if (typeof tellSay !== "undefined") tellSay.textContent = ${JSON.stringify(PROOF_LOST)};
  }
  // One call at a time, each carrying the proof the last answer left.
  function call(url, init) {
    var run = function () {
      init.headers = Object.assign({}, init.headers);
      var sent = proof;
      if (sent) init.headers["x-forge-proof"] = sent;
      return fetch(url, init).then(function (r) {
        var next = r.headers.get("x-forge-proof");
        if (next) proof = next;
        else if (sent) broke();
        return r;
      }, function (e) { if (sent) broke(); throw e; });
    };
    var p = queue.then(run, run);
    queue = p.catch(function () {});
    return p;
  }
  var where = d.env === "production" ? "production" : d.pull ? "preview of pull #" + d.pull : "";
  pill.setAttribute("aria-label", [d.app, where].filter(Boolean).join(", ") || "Forge");
  pill.setAttribute("aria-expanded", "false");
  pill.textContent = "\\u2692";
  pill.style.cssText = "all:unset;box-sizing:border-box;cursor:pointer;width:44px;height:44px;border-radius:22px;background:#1f2328;color:#fff;text-align:center;line-height:44px;font-size:20px;opacity:.85;box-shadow:0 1px 4px rgba(0,0,0,.4);touch-action:none";
  var panel = document.createElement("div");
  panel.hidden = true;
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-label", "Where you are");
  panel.tabIndex = -1;
  panel.style.cssText = "outline:none;background:#1f2328;color:#fff;padding:8px 12px;border-radius:14px;box-shadow:0 1px 4px rgba(0,0,0,.4);max-width:min(320px,calc(100vw - 64px));max-height:min(70vh,calc(100vh - 88px));overflow:auto;flex-direction:column;gap:2px;display:none";
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
  // Tell the builders: one box, one button, no account. The note goes to
  // this app's own host (same-origin, so the sender's cookie goes along) and
  // the answer is a live status the panel keeps fresh while it is open.
  var forgeOrigin = "";
  try { forgeOrigin = new URL(me.src).origin; } catch (e) {}
  var tellBox = document.createElement("form");
  tellBox.setAttribute("aria-label", "Tell the builders");
  tellBox.style.cssText = "display:flex;flex-direction:column;gap:6px;margin:6px 0";
  var tellHead = document.createElement("div");
  tellHead.textContent = "Tell the builders";
  tellHead.style.cssText = "font-weight:600;font-size:15px";
  var tellHint = document.createElement("label");
  tellHint.textContent = "What should be better here? The people who build this will read it.";
  tellHint.style.cssText = "opacity:.85";
  var tellText = document.createElement("textarea");
  tellText.maxLength = 2000;
  tellText.rows = 3;
  tellText.required = true;
  tellText.setAttribute("aria-label", "Your note to the builders");
  tellText.style.cssText = "box-sizing:border-box;width:100%;font:16px/1.3 system-ui,sans-serif;padding:8px;border-radius:8px;border:1px solid #57606a;background:#0d1117;color:#fff;resize:vertical";
  var tellGo = document.createElement("button");
  tellGo.type = "submit";
  tellGo.textContent = "Send";
  tellGo.style.cssText = "all:unset;box-sizing:border-box;cursor:pointer;min-height:44px;text-align:center;line-height:44px;border-radius:8px;background:#238636;color:#fff;font-weight:600";
  var tellSay = document.createElement("div");
  tellSay.setAttribute("aria-live", "polite");
  tellSay.style.cssText = "overflow-wrap:anywhere";
  var mine = document.createElement("div");
  mine.style.cssText = "display:flex;flex-direction:column;gap:6px";
  ring(tellGo);
  ring(tellText);
  tellBox.appendChild(tellHead);
  tellBox.appendChild(tellHint);
  tellBox.appendChild(tellText);
  tellBox.appendChild(tellGo);
  tellBox.appendChild(tellSay);
  tellBox.appendChild(mine);
  var what = document.createElement("div");
  what.style.cssText = "opacity:.85;font-size:12px";
  var whatText = document.createElement("span");
  whatText.textContent = "What is this? This is the forge, where this app is made. ";
  what.appendChild(whatText);
  var whatLink = document.createElement("a");
  whatLink.textContent = "Visit it";
  whatLink.target = "_blank";
  whatLink.rel = "noopener";
  whatLink.style.cssText = "color:#8ab4ff";
  if (forgeOrigin) { whatLink.href = forgeOrigin + "/"; what.appendChild(whatLink); }
  function show(notes) {
    mine.textContent = "";
    if (!notes.length) return;
    var h = document.createElement("div");
    h.textContent = "Your notes";
    h.style.cssText = "font-weight:600;margin-top:4px";
    mine.appendChild(h);
    notes.forEach(function (n) {
      var row = document.createElement("div");
      row.style.cssText = "border-top:1px solid #444c56;padding-top:4px;overflow-wrap:anywhere";
      var t = document.createElement("div");
      t.textContent = n.text;
      var st = document.createElement("div");
      st.textContent = n.status && n.status.label ? n.status.label : "";
      st.style.cssText = "opacity:.85";
      row.appendChild(t);
      row.appendChild(st);
      try {
        var u = new URL(n.url);
        if (u.origin === forgeOrigin) {
          var al = document.createElement("a");
          al.textContent = "See it";
          al.href = u.href;
          al.target = "_blank";
          al.rel = "noopener";
          al.style.cssText = "color:#8ab4ff";
          row.appendChild(al);
        }
      } catch (e) {}
      mine.appendChild(row);
    });
  }
  function refresh(sent) {
    call("/__forge/notes", { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !Array.isArray(j.notes)) return;
        show(j.notes);
        // A browser that keeps no cookie cannot be told which notes are its own.
        if (sent === true && !j.notes.length) tellSay.textContent = "Sent. Your browser is not keeping cookies, so your notes will not be listed here.";
      })
      .catch(function () {});
  }
  tellBox.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = tellText.value.trim();
    if (!text) { tellSay.textContent = ${JSON.stringify(NOTE_EMPTY)}; return; }
    if (tellGo.disabled) return;
    tellGo.disabled = true;
    tellGo.setAttribute("aria-busy", "true");
    tellGo.style.opacity = ".6";
    function idle() { tellGo.disabled = false; tellGo.removeAttribute("aria-busy"); tellGo.style.opacity = "1"; }
    call("/__forge/note", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: text, page: location.href, viewport: window.innerWidth + "x" + window.innerHeight })
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (a) {
        idle();
        if (a.ok) { tellText.value = ""; tellSay.textContent = "Sent. The builders will see it."; refresh(true); }
        else tellSay.textContent = a.j && a.j.message ? a.j.message : ${JSON.stringify(NOTE_FAILED)};
      })
      .catch(function () { idle(); tellSay.textContent = ${JSON.stringify(NOTE_FAILED)}; });
  });
  var poll = 0;
  function watch(open) {
    if (poll) { clearInterval(poll); poll = 0; }
    if (!open) return;
    refresh();
    poll = setInterval(refresh, 15000);
  }
  panel.appendChild(tellBox);
  panel.appendChild(what);
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
  // Where the pill sits: one of four corners, kept per app host (localStorage
  // is per origin), so a page's own controls can be left uncovered.
  var KEY = "forge-pill-corner";
  var CORNERS = ["tl", "tr", "bl", "br"];
  var corner = "br";
  function store(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
  try {
    var saved = window.localStorage.getItem(KEY);
    if (CORNERS.indexOf(saved) >= 0) corner = saved;
  } catch (e) {}
  function place(c) {
    corner = c;
    var top = c.charAt(0) === "t", left = c.charAt(1) === "l";
    host.style.top = top ? "12px" : "auto";
    host.style.bottom = top ? "auto" : "12px";
    host.style.left = left ? "12px" : "auto";
    host.style.right = left ? "auto" : "12px";
    // The panel opens toward the inside of the screen.
    box.style.flexDirection = left ? "row" : "row-reverse";
    box.style.alignItems = top ? "flex-start" : "flex-end";
  }
  place(corner);
  var drag = null, moved = false, until = 0;
  pill.addEventListener("pointerdown", function (e) {
    drag = { x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
    moved = false;
    try { pill.setPointerCapture(e.pointerId); } catch (x) {}
  });
  pill.addEventListener("pointermove", function (e) {
    if (!drag) return;
    drag.dx = e.clientX - drag.x;
    drag.dy = e.clientY - drag.y;
    if (!moved && Math.abs(drag.dx) + Math.abs(drag.dy) < 8) return;
    if (!moved) { moved = true; set(false); }
    host.style.right = "auto";
    host.style.bottom = "auto";
    host.style.left = Math.max(0, Math.min(window.innerWidth - 44, e.clientX - 22)) + "px";
    host.style.top = Math.max(0, Math.min(window.innerHeight - 44, e.clientY - 22)) + "px";
  });
  function drop(e) {
    if (!drag) return;
    drag = null;
    if (!moved) return;
    moved = false;
    // A release is followed at once by a click on the pill; that is not a
    // request to open. A cancel is not, and a later keyboard click must work.
    if (e.type === "pointerup") until = Date.now() + 50;
    var c = (e.clientY < window.innerHeight / 2 ? "t" : "b") + (e.clientX < window.innerWidth / 2 ? "l" : "r");
    place(c);
    store(KEY, c);
  }
  pill.addEventListener("pointerup", drop);
  pill.addEventListener("pointercancel", drop);
  pill.addEventListener("keydown", function (e) {
    var t = corner.charAt(0), l = corner.charAt(1);
    if (e.key === "ArrowLeft") l = "l";
    else if (e.key === "ArrowRight") l = "r";
    else if (e.key === "ArrowUp") t = "t";
    else if (e.key === "ArrowDown") t = "b";
    else return;
    e.preventDefault();
    place(t + l);
    store(KEY, corner);
  });
  // An inline display beats the UA [hidden] rule, so display carries the state.
  function ring(b) {
    b.addEventListener("focus", function () { b.style.outline = "3px solid #58a6ff"; b.style.outlineOffset = "2px"; });
    b.addEventListener("blur", function () { b.style.outline = "none"; });
  }
  var x = document.createElement("button");
  x.type = "button";
  x.textContent = "\\u00d7";
  x.setAttribute("aria-label", "Close");
  x.style.cssText = "all:unset;box-sizing:border-box;cursor:pointer;align-self:flex-end;min-width:44px;min-height:44px;text-align:center;line-height:44px;font-size:20px;margin:-8px -12px -8px 0";
  ring(x);
  x.addEventListener("click", function () { set(false); pill.focus(); });
  panel.appendChild(x);
  panel.style.display = "none";
  function set(open) {
    panel.hidden = !open;
    panel.style.display = open ? "flex" : "none";
    pill.setAttribute("aria-expanded", open ? "true" : "false");
    pill.style.opacity = open ? "1" : ".85";
    watch(open);
    if (open) panel.focus();
  }
  pill.addEventListener("click", function () {
    if (Date.now() < until) return;
    set(panel.hidden);
  });
  ring(pill);
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

/** How long a streamed page may take to show its first bytes and its end. */
export const STREAM_WAIT_MS = 100;

/**
 * Whether a response's headers say its body can be rewritten byte-wise,
 * length aside: HTML, not compressed, not an attachment, in a charset where
 * `</body>` is plain ASCII.
 */
export function htmlAnswer(headers: Headers, status: number): boolean {
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
  return true;
}

/** An `htmlAnswer` whose length is declared and bounded. */
export function rewritable(headers: Headers, status: number): boolean {
  if (!htmlAnswer(headers, status)) return false;
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
export function toolbarTag(forgeUrl: string, where?: PillWhere, proof?: string): string {
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
  const token = proof === undefined ? "" : ` data-proof="${escapeAttr(proof)}"`;
  return `<script src="${new URL(TOOLBAR_PATH, forgeUrl).href}"${data}${token} defer></script>`;
}

/** `bytes` with the pill's tag before the last `</body>`, or at the end. */
export function withToolbar(
  bytes: Uint8Array,
  forgeUrl: string,
  where?: PillWhere,
  proof?: string,
): Uint8Array<ArrayBuffer> {
  const tag = Buffer.from(toolbarTag(forgeUrl, where, proof));
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // latin1 is one character per byte, so an index in it is a byte offset.
  const at = buffer.toString("latin1").toLowerCase().lastIndexOf("</body");
  const cut = at < 0 ? buffer.length : at;
  return Buffer.concat([buffer.subarray(0, cut), tag, buffer.subarray(cut)]);
}

type Read = { done: boolean; value?: Uint8Array | undefined };

/** What `readPage` found: the whole page, or every byte as a stream. */
export type PageRead =
  | { whole: true; bytes: Uint8Array<ArrayBuffer> }
  | { whole: false; rest: ReadableStream<Uint8Array> };

/** Whether a first chunk looks like markup: optional BOM and space, then `<`. */
function htmlShaped(chunk: Uint8Array): boolean {
  let i = 0;
  if (chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) i = 3;
  while (i < chunk.length && [0x20, 0x09, 0x0a, 0x0d].includes(chunk[i]!)) i++;
  return chunk[i] === 0x3c;
}

/**
 * Read a streamed page of unknown length. If it ends within `max` bytes and
 * `wait` milliseconds, and begins like HTML, it is returned whole. Otherwise
 * `rest` carries every byte, those already read first, in order.
 */
export async function readPage(
  body: ReadableStream<Uint8Array>,
  max = REWRITE_MAX,
  wait = STREAM_WAIT_MS,
): Promise<PageRead> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let pending: Promise<Read> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(resolve, wait, "late");
  });
  let whole = false;
  try {
    for (;;) {
      pending ??= reader.read();
      const got = await Promise.race([pending, late]);
      if (got === "late") break;
      pending = undefined;
      if (got.done) {
        whole = true;
        break;
      }
      const first = chunks.length === 0;
      chunks.push(got.value!);
      size += got.value!.length;
      if ((first && !htmlShaped(got.value!)) || size > max) break;
    }
  } catch (error) {
    reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (whole) return { whole: true, bytes: new Uint8Array(Buffer.concat(chunks)) };
  return {
    whole: false,
    rest: new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = chunks.shift();
        if (next !== undefined) return controller.enqueue(next);
        const got = await (pending ?? reader.read());
        pending = undefined;
        if (got.done) controller.close();
        else controller.enqueue(got.value!);
      },
      cancel: (reason) => reader.cancel(reason),
    }),
  };
}
