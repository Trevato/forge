/**
 * The /talk page's own stylesheet and script (#7652), kept apart from the
 * page so each is one idea. The script is static code, never built from
 * user text; every turn it draws arrives as markup the server escaped.
 */

export const talkCss = /* css */ `
.talk { display: grid; grid-template-rows: auto 1fr auto; gap: 0.75rem; max-width: min(48rem, 100%); margin: 0 auto; min-width: 0; }
.talk-log { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.625rem; min-width: 0; align-content: start; min-height: 40dvh; }
.talk-turn { min-width: 0; max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
.talk-turn p { margin: 0 0 8px; }
.talk-turn p:last-child { margin-bottom: 0; }
.talk-turn pre { max-width: 100%; overflow-x: auto; }
.talk-body.prose { padding: 0; font-size: inherit; }
.talk-body.prose > * { max-width: none; }
.talk-body.prose table { display: block; max-width: 100%; overflow-x: auto; }
.talk-body.prose :is(p, ul, ol, pre, table, blockquote) { margin: 0 0 8px; }
.talk-body.prose > :last-child { margin-bottom: 0; }
.talk-person { justify-self: end; max-width: 85%; background: var(--muted); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 0.5rem 0.75rem; white-space: pre-wrap; }
.talk-agent { justify-self: start; max-width: 100%; padding: 4px 0; }
.talk-tool { color: var(--muted); font-size: var(--fs-min); padding: 0 4px; }
.talk-confirm { border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 0.75rem; background: var(--card); }
.talk-confirm .bar { margin-top: 8px; gap: 8px; }
.talk-confirm .btn { min-height: 2.75rem; flex: 1 1 8rem; }
.talk-compose { position: sticky; bottom: 0; background: var(--bg); padding: 0.5rem 0 max(0.5rem, env(safe-area-inset-bottom)); border-top: 1px solid var(--border); z-index: 8; }
.talk-compose textarea { width: 100%; min-height: 44px; max-height: 40dvh; font-size: 16px; resize: none; overflow-y: auto; box-sizing: border-box; }
.talk-compose .bar { margin-top: 6px; gap: 8px; align-items: center; }
.talk-compose .btn { min-height: 2.75rem; }
.talk-status { min-height: 1.5em; margin: 0; }
.talk-context, .talk-cost { margin: 0; }
.talk-meta { margin: 4px 0 0; display: flex; gap: 6px; align-items: center; }
.talk-copy { margin-left: auto; background: none; border: 0; color: inherit; font: inherit; cursor: pointer; padding: 6px 8px; min-height: 2rem; opacity: 0.7; }
.talk-copy:hover { opacity: 1; text-decoration: underline; }
.talk-plain { white-space: pre-wrap; }
.talk-tool details { border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 2px 10px; }
.talk-tool summary { cursor: pointer; padding: 6px 0; min-height: 1.5rem; }
.talk-tool details p { margin: 0 0 8px; white-space: pre-wrap; }
.talk-suggest { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.talk-suggest .btn { min-height: 2.75rem; }
.talk-jump { position: absolute; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%); z-index: 9; min-height: 2.75rem; }
.talk-jump[hidden] { display: none; }
.talk-body pre { position: relative; }
.talk-body pre .talk-copy { position: absolute; top: 2px; right: 2px; }
.talk-more { text-align: center; }
.talk-replaced { opacity: 0.55; }
.talk-failed form { margin-top: 6px; }
.talk-failed .btn, .talk-act { min-height: 2.75rem; }
.talk-acts { display: flex; gap: 6px; justify-content: flex-end; margin-top: 4px; }
.talk-agent .talk-acts { justify-content: flex-start; }
`;

/** Runs after DOMContentLoaded (`pageScriptAsset`). Reads the page's own `data-talk-*`; sends with fetch, follows with EventSource. */
export const talkJs = `
const root = document.querySelector("[data-talk]");
if (root) {
  const log = root.querySelector(".talk-log");
  const form = root.querySelector("form.talk-compose");
  const box = form.querySelector("textarea");
  const status = root.querySelector(".talk-status");
  let last = log.dataset.last || "";
  let source = null;
  let retry = 0;
  const paged = root.dataset.paged === "1";
  const say = (words) => { status.textContent = words; };
  const hint = root.querySelector("[data-hint]");
  if (hint) hint.textContent = "Enter sends, Shift+Enter adds a line";
  const jump = Object.assign(document.createElement("button"), { type: "button", className: "btn talk-jump", textContent: "Latest ↓", hidden: true });
  jump.setAttribute("aria-label", "Jump to the latest message");
  form.appendChild(jump);
  const nearEnd = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 120;
  let stuck = true;
  const toEnd = (force) => {
    if (!force && !stuck) { jump.hidden = false; say("New message"); return; }
    const end = document.getElementById("end");
    if (end) end.scrollIntoView({ block: "end" });
    jump.hidden = true;
  };
  window.addEventListener("scroll", () => { stuck = nearEnd(); if (stuck) jump.hidden = true; }, { passive: true });
  jump.addEventListener("click", () => { stuck = true; toEnd(true); box.focus(); });
  const draftKey = "talk-draft:" + (root.dataset.user || "");
  try { if (!box.value) box.value = localStorage.getItem(draftKey) || ""; } catch (_) {}
  const grow = () => { box.style.height = "auto"; box.style.height = Math.min(box.scrollHeight, window.innerHeight * 0.4) + "px"; };
  box.addEventListener("input", () => { grow(); try { localStorage.setItem(draftKey, box.value); } catch (_) {} });
  grow();
  const copyButton = (label) => {
    const b = Object.assign(document.createElement("button"), { type: "button", className: "talk-copy", textContent: "Copy" });
    b.setAttribute("data-copy", "");
    b.setAttribute("aria-label", label);
    return b;
  };
  root.addEventListener("click", async (e) => {
    const s = e.target.closest("[data-suggest]");
    if (s) { e.preventDefault(); box.value = s.dataset.suggest; grow(); box.focus(); return; }
    const a = e.target.closest("[data-act]");
    if (a) {
      e.preventDefault();
      editing = true;
      box.value = a.closest(".talk-turn").querySelector(".talk-body").textContent;
      grow();
      box.focus();
      say("Editing your last message. Send resends it; Escape keeps it as it was.");
      return;
    }
    const c = e.target.closest("[data-copy]");
    if (!c) return;
    const pre = c.closest("pre");
    const src = pre ? pre.querySelector("code") : c.closest(".talk-turn").querySelector(".talk-body");
    try { await navigator.clipboard.writeText(src.textContent); c.textContent = "Copied"; say("Copied."); } catch (_) { say("Copy is not allowed here."); }
    setTimeout(() => { c.textContent = "Copy"; }, 1500);
  });
  // Copy buttons are drawn here, not by the server: without the script they would do nothing.
  const decorate = (scope) => {
    scope.querySelectorAll(".talk-body pre:not([data-c])").forEach((pre) => {
      pre.dataset.c = "1";
      pre.insertBefore(copyButton("Copy this code"), pre.firstChild);
    });
    scope.querySelectorAll(".talk-turn:not([data-m]) > .talk-meta").forEach((m) => {
      m.parentNode.dataset.m = "1";
      m.appendChild(copyButton("Copy this message"));
    });
  };
  decorate(log);
  // Edit, Regenerate and Retry are drawn by the server (forms and a link that work without
  // this script); here they only act in place. They are taken away while a turn runs and
  // the server sends the new ones with done.
  let editing = form.hasAttribute("data-edit");
  const dropActs = () => log.querySelectorAll(".talk-acts").forEach((a) => a.remove());
  const again = async (how, body) => {
    say(how === "edit" ? "Sending…" : "Asking again…");
    try {
      const res = await fetch("/talk/again/" + how, { method: "POST", headers: { accept: "application/json" }, body });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { say(out.message || "That was not done."); return false; }
      stuck = true;
      location.reload();
      return true;
    } catch (_) {
      say("That was not sent: no connection.");
      return false;
    }
  };
  // While a reply streams, Send is Stop; Escape stops too.
  const action = form.querySelector(".bar button.btn");
  const sendLabel = action.textContent;
  let answering = false;
  const mode = (on) => {
    answering = on;
    action.textContent = on ? "Stop" : sendLabel;
    action.dataset.stop = on ? "1" : "";
  };
  const stop = async () => {
    say("Stopping…");
    try {
      const res = await fetch("/api/v1/conversation/stop", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      if (!res.ok) { const body = await res.json().catch(() => ({})); say(body.message || "Nothing to stop."); }
    } catch (_) {
      say("That was not sent: no connection.");
    }
  };
  action.addEventListener("click", (e) => { if (answering) { e.preventDefault(); stop(); } });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && answering) { e.preventDefault(); stop(); } });
  const follow = () => {
    if (paged) return;
    if (source) source.close();
    dropActs();
    source = new EventSource("/talk/stream?after=" + encodeURIComponent(last));
    source.addEventListener("turn", (e) => {
      const turn = JSON.parse(e.data);
      last = turn.id;
      if (!document.getElementById("t-" + turn.id)) { log.insertAdjacentHTML("beforeend", turn.html); decorate(log); }
      retry = 0;
      toEnd();
    });
    source.addEventListener("running", () => { dropActs(); mode(true); say("The forge is answering…"); });
    source.addEventListener("done", (e) => {
      mode(false); dropActs(); say(""); source.close(); source = null;
      const o = JSON.parse(e.data), c = root.querySelector("[data-context]");
      for (const k of o.costs || []) { const li = document.getElementById(k.id); if (li && !li.querySelector(".talk-cost")) li.insertAdjacentHTML("beforeend", k.html); }
      if (o.context && c) { c.hidden = false; c.textContent = o.context; }
      for (const a of o.acts || []) {
        const li = document.getElementById(a.id);
        if (li) li.insertAdjacentHTML("beforeend", '<div class="talk-acts">' + a.html + "</div>");
      }
    });
    source.addEventListener("more", () => { source.close(); follow(); });
    source.addEventListener("drain", () => { source.close(); setTimeout(follow, 1000); });
    source.onerror = () => {
      source.close();
      source = null;
      if (++retry < 6) setTimeout(follow, Math.min(1000 * retry, 5000));
      else say("Lost the connection. Reload to see the rest.");
    };
  };
  const send = async (e) => {
    e.preventDefault();
    const text = box.value.trim();
    if (!text) return;
    if (editing) {
      if (await again("edit", new URLSearchParams({ text }))) { try { localStorage.removeItem(draftKey); } catch (_) {} }
      return;
    }
    say("Sending…");
    try {
      const res = await fetch("/api/v1/conversation/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        say(body.message || "That was not sent.");
        return;
      }
      box.value = "";
      grow();
      try { localStorage.removeItem(draftKey); } catch (_) {}
      stuck = true;
      if (paged) { location.href = "/talk"; return; }
      follow();
    } catch (_) {
      say("That was not sent: no connection.");
    }
  };
  form.addEventListener("submit", send);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && editing) { editing = false; box.value = ""; grow(); say(""); return; }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
  });
  log.addEventListener("submit", async (e) => {
    const r = e.target.closest("form[data-again]");
    if (r) { e.preventDefault(); again(r.dataset.again, new URLSearchParams()); return; }
    const f = e.target.closest("form[data-confirm]");
    if (!f) return;
    e.preventDefault();
    const answer = e.submitter ? e.submitter.value : "no";
    const body = new URLSearchParams({ answer });
    say(answer === "yes" ? "Confirming…" : "Cancelling…");
    try {
      const res = await fetch(f.action, { method: "POST", headers: { accept: "application/json" }, body });
      const out = await res.json().catch(() => ({}));
      say(res.ok ? "" : out.message || "Nothing was done.");
      f.replaceWith(Object.assign(document.createElement("p"), { className: "muted small", textContent: res.ok ? (answer === "yes" ? "Confirmed." : "Cancelled.") : "Not done." }));
      follow();
    } catch (_) {
      say("That was not sent: no connection.");
    }
  });
  toEnd(true);
  if (root.dataset.running === "1" && !paged) follow();
}
`;
