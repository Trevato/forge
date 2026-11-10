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
import { NOTE_EMPTY, NOTE_FAILED } from "./note_words.ts";

/** What the panel says about a preview's freshness (#9111): the pill's words, in one table. */
export const FRESHNESS_WORDS = {
  merged: "Merged: this preview shows the pull as it landed",
  closed: "Closed without landing",
  deploying: "A newer push is deploying",
  behind: "Shows an older push than the pull's newest",
} as const;

/** The client, as plain source: no `eval`, no inline handlers. Its comments are for readers here. */
const toolbarSource = `(function () {
  if (window.__forgeToolbar) return;
  window.__forgeToolbar = true;
  var me = document.currentScript;
  // The forge's origin comes from data-forge: the script itself is served from the app's own host.
  var fo = "";
  try { fo = new URL((me.dataset || {}).forge || "").origin; } catch (e) {}
  var home = fo ? fo + "/" : "/";
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
  // One call at a time, each carrying the proof the last answer left.
  function call(url, init) {
    var run = function () {
      init.headers = Object.assign({}, init.headers);
      if (proof) init.headers["x-forge-proof"] = proof;
      // Only an answer's next proof replaces the one held: a rejected fetch, or an answer that did not spend it, keeps the chain.
      return fetch(url, init).then(function (r) {
        var next = r.headers.get("x-forge-proof");
        if (next) proof = next;
        return r;
      });
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
  var LS = "color:#8ab4ff;text-decoration:none;display:flex;align-items:center;min-height:44px";
  var pullHref = "";
  // The pull this preview shows, one tap away: built from the script's own origin, never from page text.
  if (d.env !== "production" && /^\\d{1,9}$/.test(d.pull || "") && /^[\\w.-]+\\/[\\w.-]+$/.test(d.repo || "")) {
    try { pullHref = new URL("/" + d.repo + "/pulls/" + d.pull, fo).href; } catch (e) {}
  }
  if (d.env === "production") {}
  else if (pullHref) {
    var pl = document.createElement("a");
    pl.textContent = "Preview of pull #" + d.pull;
    pl.href = pullHref;
    pl.rel = "noopener";
    pl.style.cssText = LS;
    panel.appendChild(pl);
  } else if (d.pull) line("Preview of pull #" + d.pull);
  if (d.title) line(d.title);
  // Whether this is the pull as it stands now; an open, current preview says nothing.
  var W = ${JSON.stringify(FRESHNESS_WORDS)};
  var freshness = d.state === "merged" ? W.merged
    : d.state === "closed" ? W.closed
    : d.deploying ? W.deploying
    : d.behind ? W.behind : "";
  if (freshness) line(freshness);
  var link = document.createElement("a");
  link.textContent = "Home";
  link.rel = "noopener";
  link.style.cssText = LS;
  var hasHome = false;
  try {
    var target = new URL(home);
    if (target.origin === fo) { link.href = target.href; hasHome = true; }
  } catch (e) {}
  // Tell the builders: one box, one button, no account. The note goes to
  // this app's own host (same-origin, so the sender's cookie goes along) and
  // the answer is a live status the panel keeps fresh while it is open.
  var forgeOrigin = fo;
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
  var tellPicRow = document.createElement("label");
  tellPicRow.style.cssText = "display:flex;align-items:center;gap:8px;min-height:44px";
  var tellPic = document.createElement("input");
  tellPic.type = "checkbox";
  tellPic.checked = false;
  tellPic.style.cssText = "width:20px;height:20px;margin:0";
  var tellPicText = document.createElement("span");
  tellPicText.textContent = "Include a picture of this page, visible to anyone who can read the report";
  tellPicRow.appendChild(tellPic);
  tellPicRow.appendChild(tellPicText);
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
  ring(tellPic);
  tellBox.appendChild(tellHead);
  tellBox.appendChild(tellHint);
  tellBox.appendChild(tellText);
  tellBox.appendChild(tellPicRow);
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
      var all = Array.isArray(n.replies) ? n.replies : [];
      // Only the latest few, so a long thread cannot push the panel off a phone; the rest is on the issue.
      var shown = all.slice(-5);
      if (all.length > shown.length) {
        var more = document.createElement("div");
        more.textContent = (all.length - shown.length) + " earlier on the forge";
        more.style.cssText = "opacity:.85;margin-top:2px";
        row.appendChild(more);
      }
      shown.forEach(function (r) {
        var rr = document.createElement("div");
        rr.textContent = String(r.by) + " (" + String(r.at).slice(0, 16).replace("T", " ") + "): " + String(r.text);
        rr.style.cssText = "margin-top:2px;padding-left:6px;border-left:2px solid #444c56;white-space:pre-wrap;max-height:8em;overflow:auto";
        row.appendChild(rr);
      });
      var al = n.url && link(n.url, "See it");
      if (al) row.appendChild(al);
      mine.appendChild(row);
    });
  }
  function link(u, text) {
    try {
      var l = new URL(u), el = document.createElement("a");
      if (l.origin !== forgeOrigin) return null;
      el.textContent = text; el.href = l.href; el.target = "_blank"; el.rel = "noopener"; el.style.color = "#8ab4ff";
      return el;
    } catch (e) { return null; }
  }
  function filed(n) {
    if (!n || typeof n.number !== "number") return;
    var t = "Filed as #" + n.number, a = n.url && link(n.url, t), r = n.repoUrl && link(n.repoUrl, "The repository");
    tellSay.append(" ", a || t);
    if (r) tellSay.append(" ", r);
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
  var PICTURE_MAX = 2097152;
  function shoot() {
    return new Promise(function (resolve) {
      var done = false;
      function end(blob) { if (!done) { done = true; resolve(blob || null); } }
      setTimeout(end, 8000);
      try {
        var w = window.innerWidth, h = window.innerHeight;
        var src = document.documentElement;
        var all = src.querySelectorAll("*");
        var copy = src.cloneNode(true);
        var twins = copy.querySelectorAll("*");
        for (var i = 0; i < twins.length && i < all.length; i++) {
          var t = twins[i], tag = t.tagName;
          if (tag === "SCRIPT" || tag === "NOSCRIPT" || tag === "IFRAME" || t.id === "forge-toolbar") { t.setAttribute("data-drop", "1"); continue; }
          if (i > 4000) { t.setAttribute("data-drop", "1"); continue; }
          var cs = getComputedStyle(all[i]), css = "";
          for (var k = 0; k < cs.length; k++) css += cs[k] + ":" + cs.getPropertyValue(cs[k]) + ";";
          t.setAttribute("style", css);
        }
        copy.querySelectorAll("[data-drop]").forEach(function (n) { n.remove(); });
        var cb = getComputedStyle(src);
        copy.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
        copy.setAttribute("style", "margin:0;background:" + (cb.backgroundColor || "#fff") + ";width:" + src.scrollWidth + "px;transform:translate(" + (-window.scrollX) + "px," + (-window.scrollY) + "px)");
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '"><foreignObject width="100%" height="100%">' + new XMLSerializer().serializeToString(copy) + "</foreignObject></svg>";
        var img = new Image();
        img.onload = function () {
          try {
            var c = document.createElement("canvas");
            c.width = w; c.height = h;
            c.getContext("2d").drawImage(img, 0, 0);
            c.toBlob(function (png) {
              if (png && png.size <= PICTURE_MAX) return end(png);
              c.toBlob(function (jpg) { end(jpg && jpg.size <= PICTURE_MAX ? jpg : null); }, "image/jpeg", 0.7);
            }, "image/png");
          } catch (e) { end(); }
        };
        img.onerror = function () { end(); };
        img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
      } catch (e) { end(); }
    });
  }
  // The last few console errors: message text only, cut short here and again on the server.
  var errs = [];
  function noted(m) { errs.push(String(m).slice(0, 200)); if (errs.length > 5) errs.shift(); }
  if (window.addEventListener) {
    window.addEventListener("error", function (e) { noted(e && e.message); });
    window.addEventListener("unhandledrejection", function (e) { var r = e && e.reason; noted(r && r.message ? r.message : r); });
  }
  var logged = typeof console === "object" && console ? console.error : null;
  if (logged) console.error = function () {
    try { noted(Array.prototype.map.call(arguments, function (a) { return a && a.message ? a.message : typeof a === "string" ? a : ""; }).join(" ")); } catch (x) {}
    return logged.apply(console, arguments);
  };
  tellBox.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = tellText.value.trim();
    if (!text) { tellSay.textContent = ${JSON.stringify(NOTE_EMPTY)}; return; }
    if (tellGo.disabled) return;
    var wantPicture = tellPic.checked === true;
    tellGo.disabled = true;
    tellGo.setAttribute("aria-busy", "true");
    tellGo.style.opacity = ".6";
    function idle() { tellGo.disabled = false; tellGo.removeAttribute("aria-busy"); tellGo.style.opacity = "1"; }
    var taken = wantPicture ? shoot() : Promise.resolve(null);
    taken.then(function (blob) {
      return call("/__forge/note", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: text, page: location.href, viewport: window.innerWidth + "x" + window.innerHeight, errors: errs.slice(-5) })
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (a) {
          if (!a.ok || !blob || !a.j || !a.j.note || !a.j.note.id) return { a: a, pic: false };
          return call("/__forge/note/picture?note=" + encodeURIComponent(a.j.note.id), {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": blob.type },
            body: blob
          }).then(function (r) { return { a: a, pic: r.ok }; }, function () { return { a: a, pic: false }; });
        });
    })
      .then(function (x) {
        idle();
        var a = x.a;
        if (a.ok) {
          tellText.value = "";
          tellPic.checked = false;
          tellSay.textContent = wantPicture && x.pic !== true ? "Sent, without the picture. The builders will see it." : "Sent. The builders will see it.";
          filed(a.j && a.j.note);
          refresh(true);
        }
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
  if (hasHome) panel.appendChild(link);
  // The actions live on a forge page, opened in a tab of its own: the bar
  // posts nothing and reads nothing of this page beyond its address.
  if (d.repo && /^[\\w.-]+\\/[\\w.-]+$/.test(d.repo)) {
    var act = document.createElement("a");
    act.textContent = "Comment, tell, make it yours";
    act.target = "_blank";
    act.rel = "noopener noreferrer";
    act.style.cssText = LS + ";margin-top:4px";
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
        var forge = fo;
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
            ta.style.cssText = LS;
            crew.appendChild(ta);
          }
        }
        // The other side: origin plus this path as text, so "//" cannot leave it.
        var sd = c.side;
        if (sd && typeof sd.label === "string" && typeof sd.url === "string") {
          try {
            var so = new URL(sd.url);
            if (so.protocol === "https:" || so.protocol === location.protocol) {
              var sa = document.createElement("a");
              sa.textContent = sd.label;
              sa.rel = "noopener";
              sa.href = so.origin + location.pathname + location.search;
              sa.style.cssText = LS;
              crew.appendChild(sa);
            }
          } catch (e) {}
        }
        if (typeof c.who !== "string" || typeof c.url !== "string") return;
        var u = new URL(c.url);
        if (u.origin !== forge) return;
        var a = document.createElement("a");
        a.textContent = c.who + " is working on this";
        a.rel = "noopener";
        a.href = u.href;
        a.style.cssText = LS;
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
  var NARROW_MAX = 600, CAMERA_TOP = "48px";
  function place(c) {
    corner = c;
    var top = c.charAt(0) === "t", left = c.charAt(1) === "l";
    var narrow = top && window.innerWidth <= NARROW_MAX;
    host.style.top = top ? (narrow ? CAMERA_TOP : "12px") : "auto";
    // The cssText cap assumes a pill 12px down; 36px lower, the cap drops by as much.
    panel.style.maxHeight = narrow ? "min(70vh,calc(100vh - 124px))" : "";
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
  var sr = document.createElement("div");
  sr.setAttribute("role", "status");
  sr.style.cssText = "position:absolute;opacity:0";
  box.appendChild(sr);
  pill.addEventListener("keydown", function (e) {
    var t = corner.charAt(0), l = corner.charAt(1);
    if (e.key === "ArrowLeft") l = "l";
    else if (e.key === "ArrowRight") l = "r";
    else if (e.key === "ArrowUp") t = "t";
    else if (e.key === "ArrowDown") t = "b";
    else return;
    e.preventDefault();
    if (t + l === corner) return;
    place(t + l);
    store(KEY, corner);
    sr.textContent = "Moved to the " + (t > "b" ? "top " : "bottom ") + (l > "m" ? "right" : "left");
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
    if (open) {
      // Focus goes to the panel's first link; a bare panel only when it has none.
      var first = stops().filter(function (el) { return el.tagName === "A"; })[0];
      (first || panel).focus();
    }
  }
  // The panel's own tab stops, in order (read from the panel, never the page).
  function stops() {
    var all = panel.getElementsByTagName ? Array.prototype.slice.call(panel.getElementsByTagName("*")) : [];
    return all.filter(function (el) {
      var t = el.tagName;
      return (t === "A" && el.hasAttribute("href")) || ((t === "BUTTON" || t === "INPUT" || t === "TEXTAREA") && !el.disabled);
    });
  }
  // Tab cycles inside the open panel: the last stop wraps to the first, and back.
  panel.addEventListener("keydown", function (e) {
    if (e.key !== "Tab") return;
    var s = stops();
    if (!s.length) return;
    var at = root.activeElement;
    var edge = e.shiftKey ? s[0] : s[s.length - 1];
    if (at === edge || at === panel) {
      e.preventDefault();
      (e.shiftKey ? s[s.length - 1] : s[0]).focus();
    }
  });
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

/** What is served: the source without its whole-line comments, so the notes cost the pill none of its 24 KB (#10869). */
export const toolbarJs = toolbarSource.replace(/^[ \t]*\/\/[^\n]*\n/gm, "");

const hash = sha256(toolbarJs);
const name = `toolbar-${hash.slice(0, 16)}`;

/** The path the script is served from on the forge, content-addressed. */
export const TOOLBAR_PATH = `/assets/${name}.js`;
export const TOOLBAR_NAME = name;

/** The same script on an app's own host, where a strict `script-src 'self'` allows it. */
export const TOOLBAR_ASSET_PATH = `/__forge/${name}.js`;
/** Every path under this prefix on an app host is the forge's, whether or not it names the script. */
export const TOOLBAR_ASSET_PREFIX = "/__forge/toolbar";

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
  /** Whether the pull is open, merged or closed; for a reader of the pull only. */
  state?: "open" | "merged" | "closed";
  /** The preview runs a commit that is not the pull's head (and none is deploying). */
  behind?: boolean;
  /** A newer commit is being deployed now. */
  deploying?: boolean;
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

/**
 * The nonce a response's own Content-Security-Policy admits scripts by: from
 * `script-src`, or `default-src` when a policy has no `script-src`. Only a
 * well-formed base64 value is returned; anything else is no nonce.
 */
export function cspNonce(policy: string | null): string | undefined {
  if (policy === null) return undefined;
  for (const one of policy.split(",")) {
    const directives = one.split(";").map((d) => d.trim().split(/\s+/));
    const names = (n: string) => directives.find((d) => d[0]?.toLowerCase() === n);
    const chosen = names("script-src") ?? names("default-src");
    for (const source of chosen?.slice(1) ?? []) {
      const m = /^'nonce-([A-Za-z0-9+/_-]+={0,2})'$/i.exec(source);
      if (m) return m[1];
    }
  }
  return undefined;
}

/** The script tag, with where-you-are as escaped data attributes. */
export function toolbarTag(
  forgeUrl: string,
  where?: PillWhere,
  proof?: string,
  nonce?: string,
): string {
  const data =
    where === undefined
      ? ""
      : [
          ["app", where.app],
          ["repo", where.repo],
          ["env", where.env],
          ["pull", where.pull === undefined ? undefined : String(where.pull)],
          ["title", where.title],
          ["state", where.state],
          ["behind", where.behind === true ? "1" : undefined],
          ["deploying", where.deploying === true ? "1" : undefined],
        ]
          .filter((pair): pair is [string, string] => pair[1] !== undefined)
          .map(([k, v]) => ` data-${k}="${escapeAttr(v)}"`)
          .join("");
  const token = proof === undefined ? "" : ` data-proof="${escapeAttr(proof)}"`;
  const forge = ` data-forge="${escapeAttr(new URL(forgeUrl).origin)}"`;
  const admitted = nonce === undefined ? "" : ` nonce="${escapeAttr(nonce)}"`;
  return `<script src="${TOOLBAR_ASSET_PATH}"${admitted}${forge}${data}${token} defer></script>`;
}

/**
 * The byte offset of the last `</body`, any case, or -1. Scanned from the end
 * so a page pays for its tail, not for a lowercase copy of the whole body.
 */
function lastBodyClose(buffer: Buffer): number {
  for (let i = buffer.length - 6; i >= 0; i--) {
    if (buffer[i] !== 0x3c || buffer[i + 1] !== 0x2f) continue;
    if (buffer.toString("latin1", i + 2, i + 6).toLowerCase() === "body") return i;
  }
  return -1;
}

/** The opening of the tag the proxy writes, with the hashed name: what a page that has the toolbar contains. */
const TAG_OPEN = Buffer.from(`<script src="${TOOLBAR_ASSET_PATH}"`);

/**
 * Whether a page already carries this toolbar's tag (a page served through two
 * forges, or cached with one). A byte search for the exact tag opening: a page
 * that only quotes the path in its text does not match, and nothing is decoded.
 */
export function carriesToolbar(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(TAG_OPEN);
}

/** `bytes` with the pill's tag before the last `</body>`, or at the end; a page that has one is returned as it is. */
export function withToolbar(
  bytes: Uint8Array,
  forgeUrl: string,
  where?: PillWhere,
  proof?: string,
  nonce?: string,
): Uint8Array<ArrayBuffer> {
  if (carriesToolbar(bytes)) return new Uint8Array(bytes);
  const tag = Buffer.from(toolbarTag(forgeUrl, where, proof, nonce));
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = lastBodyClose(buffer);
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
