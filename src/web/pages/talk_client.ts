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
.talk-person { justify-self: end; max-width: 85%; background: var(--muted); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 0.5rem 0.75rem; white-space: pre-wrap; }
.talk-agent { justify-self: start; max-width: 100%; padding: 4px 0; }
.talk-tool { color: var(--muted); font-size: var(--fs-min); padding: 0 4px; }
.talk-confirm { border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 0.75rem; background: var(--card); }
.talk-confirm .bar { margin-top: 8px; gap: 8px; }
.talk-confirm .btn { min-height: 2.75rem; flex: 1 1 8rem; }
.talk-compose { position: sticky; bottom: 0; background: var(--bg); padding: 0.5rem 0 max(0.5rem, env(safe-area-inset-bottom)); border-top: 1px solid var(--border); z-index: 8; }
.talk-compose textarea { width: 100%; min-height: 56px; max-height: 40dvh; font-size: 16px; resize: vertical; box-sizing: border-box; }
.talk-compose .bar { margin-top: 6px; gap: 8px; align-items: center; }
.talk-compose .btn { min-height: 2.75rem; }
.talk-status { min-height: 1.5em; margin: 0; }
.talk-more { text-align: center; }
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
  const toEnd = () => { const end = document.getElementById("end"); if (end) end.scrollIntoView({ block: "end" }); };
  const follow = () => {
    if (paged) return;
    if (source) source.close();
    source = new EventSource("/talk/stream?after=" + encodeURIComponent(last));
    source.addEventListener("turn", (e) => {
      const turn = JSON.parse(e.data);
      last = turn.id;
      if (!document.getElementById("t-" + turn.id)) log.insertAdjacentHTML("beforeend", turn.html);
      retry = 0;
      toEnd();
    });
    source.addEventListener("running", () => say("The forge is answering…"));
    source.addEventListener("done", () => { say(""); source.close(); source = null; });
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
      if (paged) { location.href = "/talk"; return; }
      follow();
    } catch (_) {
      say("That was not sent: no connection.");
    }
  };
  form.addEventListener("submit", send);
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) form.requestSubmit();
  });
  log.addEventListener("submit", async (e) => {
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
  toEnd();
  if (root.dataset.running === "1" && !paged) follow();
}
`;
