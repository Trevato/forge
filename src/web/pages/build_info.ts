/**
 * One build's player and info panel, as the Iterations page draws them: the
 * facts a build is drawn from (`buildOf`), the player (`playerOf`), the info
 * panel with its Notes and Actions (`infoOf`), their style, and the script
 * that runs the panel's dialogs and its notes edited in place (`INFO_JS`).
 * Captured pages, screenshots and displays are not on this forge yet: a
 * build plays as a build preview, or not at all.
 */

import { holdsNotes, NOTES_MAX, type BuildNote } from "../../git/builds.ts";
import type { Ctx } from "../../http/context.ts";
import { html, raw, when, type Html } from "../html.ts";
import { repoDir } from "../../git/repos.ts";
import { renderMarkdown } from "../markdown.ts";
import { btn } from "../ui.ts";
import type { IterationBuild } from "../../core/iterations.ts";



/** "Oct 24", read in UTC so every viewer sees one date. */
export const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });


/** What a build's info panel says it plays. */
export function playsText(b: IterationBuild): string {
  if (b.plays === "env") return "build preview";
  return "nothing: not an app";
}

export function playerOf(b: IterationBuild): Html {
  const title = html`<b>${b.repo.split("/")[1]} ${b.label}</b>`;
  const foot = html`<div class="it-foot">${b.note === "" ? null : html`${b.note} · `}${b.repo} · ${b.branch === "" ? null : html`${b.branch} @ `}<span class="mono">${b.oid.slice(0, 7)}</span> · ${shortDate(b.at)}</div>`;
  const body =
    b.plays === "none"
      ? html`<div class="it-empty">Nothing to play: ${b.repo} is not an app.</div>`
      : b.preview
        ? html`<div class="it-empty"><form method="post" action="/${b.repo}/builds/preview">
            <input type="hidden" name="sha" value="${b.oid}" />
            ${btn("Open build preview", { variant: "primary", size: "sm" })}
          </form></div>`
        : html`<div class="it-empty">Opening a build preview requires write access.</div>`;
  return html`<div class="it-bar">${title}</div>${body}${foot}`;
}

/** A button that opens one of the build's dialogs; nothing happens until the dialog is confirmed. */
export const ask = (id: string, label: string): Html =>
  html`<button type="button" class="btn" data-size="sm" data-ask="it-dlg-${id}">${label}</button>`;

/** A dialog that says what will happen, with Cancel and the one button that does it. */
export const dialog = (id: string, title: string, body: Html, confirm: Html): Html =>
  html`<dialog class="dialog it-dlg" id="it-dlg-${id}" aria-labelledby="it-dlg-${id}-title">
    <div class="dialog-head"><h2 id="it-dlg-${id}-title">${title}</h2></div>
    <div class="dialog-body">${body}</div>
    <div class="dialog-foot"><button type="button" class="btn" data-cancel>Cancel</button>${confirm}</div>
  </dialog>`;

/** What the fork dialog says a fork carries of the build's commit. */
function forkCarries(b: IterationBuild): string {
  const sha7 = b.oid.slice(0, 7);
  if (b.forkHas.branch !== null) return `${b.label}'s commit ${sha7} is on branch ${b.forkHas.branch}.`;
  return `${b.label}'s commit ${sha7} is on no branch; the copied pin keeps it.`;
}

/** A quiet Edit link at the right of a section's heading, Forgejo style. */
const editLink = (hide = false, label = "Edit"): Html =>
  html`<button type="button" class="it-edit" data-edit ${hide ? raw("hidden") : null}>${label}</button>`;

/** One note: its author and day, then its first line as a title; the rest opens on a click. */
function noteItem(cls: string, who: Html, text: string): Html {
  const at = text.indexOf("\n");
  const first = at === -1 ? text : text.slice(0, at);
  const more = at === -1 ? "" : text.slice(at + 1).trim();
  return more === ""
    ? html`<div class="it-note ${cls}">${who} · ${first}</div>`
    : html`<details class="it-note ${cls}"><summary>${who} · ${first}</summary><div class="prose it-body">${renderMarkdown(more)}</div></details>`;
}

/** A build's notes as one list: people's notes first, highlighted, then agents', then the pin's own tag note. */
export function noteListOf(b: { readonly notes: readonly BuildNote[]; readonly tag: string; readonly by: string; readonly at: string }): Html | null {
  const items = b.notes.map((n) =>
    noteItem(`it-note-${n.kind}`, html`<b>${n.by}</b>${n.kind === "agent" ? html` <i>agent</i>` : null} · ${shortDate(n.at)}`, n.text),
  );
  if (b.tag !== "") items.push(noteItem("it-note-pin", html`<b>${b.by}</b> <i>pin</i> · ${shortDate(b.at)}`, b.tag));
  return items.length === 0 ? null : html`${items}`;
}

/** The Notes section: one list, people's notes first; for a writer, Add a note opens a box with Save and Cancel, in place. */
function notesOf(b: IterationBuild, back: string): Html {
  const list = noteListOf(b);
  const empty = list === null;
  const view = html`<div class="it-notelist" data-view ${empty ? raw("hidden") : null}>${list}</div>`;
  if (!b.canNote) return html`<section class="it-notes" data-section="notes"><h4>Notes</h4>${empty ? html`<p>None</p>` : view}</section>`;
  return html`<section class="it-notes" data-section="notes" data-field="notes" data-empty="${empty ? "1" : "0"}"><h4>Notes${editLink(empty, "Add a note")}</h4>
      ${view}
      <p class="muted it-none" data-none ${empty ? null : raw("hidden")}>None. ${editLink(false, "Add a note")}</p>
      <form class="it-ed" method="post" action="/${b.repo}/builds/${encodeURIComponent(b.label)}/note" hidden>
        <input type="hidden" name="back" value="${back}" />
        <textarea class="input" name="notes" rows="5" maxlength="${String(NOTES_MAX)}" aria-label="Your note: the first line is its title" placeholder="The first line is its title"></textarea>
        <div class="it-ed-foot"><button type="button" class="btn" data-size="sm" data-cancel-edit>Cancel</button>${btn("Save note", { variant: "primary", size: "sm" })}</div>
      </form>
      <p class="it-saved" data-saved role="status" hidden></p></section>`;
}

export function infoOf(ctx: Ctx, b: IterationBuild, forkOf: string | null, link: string, back: string): Html {
  const name = b.repo.split("/")[1] ?? b.repo;
  const lineage = [
    ...(forkOf === null ? [] : [`fork of ${forkOf}`]),
    ...(b.parent === null ? [] : [`${b.edge === "concept" ? "built on" : "after"} ${b.parent}`]),
  ];
  // The forge's refs ride along: pins, and their notes when the repository holds any (a missing ref fails the fetch).
  const [owner = "", rname = ""] = b.repo.split("/");
  const notes = holdsNotes(repoDir(ctx.app.reposRoot, owner, rname)) ? " 'refs/forge/notes:refs/forge/notes'" : "";
  const clone = `git clone ${ctx.url.origin}/${b.repo}.git\ngit -C ${name} fetch origin 'refs/builds/*:refs/builds/*'${notes}\ngit -C ${name} checkout ${b.oid}`;
  const fact = (label: string, value: Html | string) => html`<dt>${label}</dt><dd>${value}</dd>`;
  return html`<h3>${name} ${b.label}</h3>
    <section data-section="build"><h4>Build</h4><dl>
      ${fact("Pin", `refs/builds/${b.label}`)}
      ${fact("Commit", html`<a class="mono" href="/${b.repo}/commit/${b.oid}">${b.oid.slice(0, 12)}</a>`)}
      ${fact("Branch", b.branch === "" ? "None" : b.branch)}
      ${fact("Repository", html`<a href="/${b.repo}">${b.repo}</a>`)}
      ${fact("Lineage", lineage.length === 0 ? "first pin" : lineage.join(" · "))}
      ${fact("Pinned", `${b.by} · ${b.at.slice(0, 10)}`)}
      ${fact("Plays", playsText(b))}
    </dl></section>
    ${notesOf(b, back)}
    <section data-section="actions"><h4>Actions</h4><div class="it-acts">
      ${ask("link", "Copy link")}
      ${ask("clone", "Clone")}
      ${ask("fork", "Fork")}
      ${when(b.canNote, () => ask("delete", "Delete pin"))}
    </div></section>
    ${dialog(
      "link",
      "Copy link",
      html`<p>The link to ${name} ${b.label} on this page.</p><input class="input mono it-cmd" id="it-link" type="text" value="${link}" readonly aria-label="Link" />`,
      html`<button type="button" class="btn" data-variant="primary" data-copy="it-link" data-done>Copy link</button>`,
    )}
    ${dialog(
      "clone",
      "Clone",
      html`<p>Run these on your machine to get ${name} ${b.label}. Nothing runs on the forge.</p><textarea class="input mono it-cmd" id="it-clone" rows="3" readonly aria-label="Commands">${clone}</textarea>`,
      html`<button type="button" class="btn" data-variant="primary" data-copy="it-clone" data-done>Copy commands</button>`,
    )}
    ${dialog(
      "fork",
      "Fork",
      html`<form method="post" action="/${b.repo}/fork" id="it-fork-form">
        <p>Fork ${b.repo} into your account as a new repository. It copies the branches and tags, and the build pins with their notes. ${forkCarries(b)}</p>
        <input type="hidden" name="then" value="iterations" /><input type="hidden" name="back" value="${back}" />
        <div class="field"><label for="it-fork-name">Repository name</label><input class="input mono" id="it-fork-name" name="name" value="${name}-${b.label}" required autocomplete="off" /></div>
      </form>`,
      html`<button type="submit" class="btn" data-variant="primary" form="it-fork-form">Fork repository</button>`,
    )}
    ${when(b.canNote, () =>
      dialog(
        "delete",
        "Delete pin",
        html`<form method="post" action="/${b.repo}/builds/${encodeURIComponent(b.label)}/delete" id="it-delete-form">
          <input type="hidden" name="back" value="${back}" />
          <p>Delete the pin ${b.label} from ${b.repo}. Its commit ${b.oid.slice(0, 7)} and its notes stay.</p>
        </form>`,
        html`<button type="submit" class="btn" data-variant="danger" form="it-delete-form">Delete pin</button>`,
      ),
    )}`;
}

/** The player's and the info panel's style. */
export const INFO_CSS = /* css */ `
.it-player,.it-info{background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;min-width:0}
.it-bar{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border)}
.it-sp{margin-left:auto;display:flex;gap:8px}
.it-empty{padding:40px 20px;text-align:center;color:var(--muted-fg)}
.it-empty form{display:inline-block}
.it-foot{padding:10px 14px;color:var(--muted-fg);font-size:13px;border-top:1px solid var(--border)}
.it-info h3{margin:0;padding:10px 14px;border-bottom:1px solid var(--border);font-size:15px}
.it-info section{padding:10px 14px;border-bottom:1px solid var(--border)}
.it-info section:last-child{border-bottom:0}
.it-info h4{display:flex;align-items:baseline;gap:8px;margin:0 0 6px;font-size:12.5px;color:var(--muted-fg);font-weight:600}
.it-info dl{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin:0;font-size:13px}
.it-info dt{color:var(--muted-fg)}
.it-info dd{margin:0;overflow-wrap:anywhere}
.it-info p{margin:0;font-size:13px}
.it-info .prose.it-body{padding:0;font-size:13px;line-height:1.5}
.it-edit{margin-left:auto;background:none;border:0;padding:0;color:var(--muted-fg);font:inherit;font-size:11.5px;font-weight:400;cursor:pointer}
.it-edit:hover,.it-edit:focus-visible{color:var(--accent);text-decoration:underline}
@media (forced-colors: active){.it-edit:focus-visible{outline:1px solid Highlight}}
.it-none .it-edit{margin-left:0;font-size:inherit}
.it-edit[hidden],.it-ed[hidden],.it-saved[hidden],.it-info [data-view][hidden],.it-none[hidden]{display:none}
.it-ed{display:grid;gap:8px}
.it-ed textarea{min-height:96px;resize:vertical;font-size:16px}
.it-notelist{display:grid;gap:4px;margin-bottom:6px}
.it-note{padding:5px 9px;border-radius:6px;font-size:13px;border-left:3px solid var(--border);overflow-wrap:anywhere}
.it-note summary{cursor:pointer}
.it-note .it-body{margin-top:4px}
.it-note-human{background:color-mix(in srgb,var(--accent) 10%,transparent);border-left-color:var(--accent)}
.it-note-agent,.it-note-pin{color:var(--muted-fg);font-size:12.5px}
.it-note i{font-style:normal;font-size:11.5px;color:var(--muted-fg)}
.it-ed-foot{display:flex;justify-content:flex-end;gap:8px}
.it-info .it-saved{margin-top:6px;font-size:11.5px;color:var(--muted-fg)}
.it-info .it-saved.it-bad{color:var(--danger)}
.it-acts{display:flex;flex-wrap:wrap;gap:8px}
.it-cmd{display:block;width:100%;font-size:11.5px;margin-top:8px;resize:none}
`;

/**
 * The panel's script, as a string of browser code: panel(player, info, saved)
 * runs the dialogs every action opens, Notes edited in
 * place (saved(j) is told what was saved, to mend the page around the
 * panel). It returns show(playerTpl, infoTpl),
 * which swaps a build's player and panel in from their templates, and
 * keep(tpl), which writes the panel as it stands back to its template.
 */
export const INFO_JS = `
  function panel(player, info, saved) {
    document.addEventListener('click', function (ev) {
      var t = ev.target; if (!t || !t.closest) return;
      var a = t.closest('[data-ask]');
      if (a) { var d = document.getElementById(a.getAttribute('data-ask')); if (d && d.showModal && !d.open) d.showModal(); return; }
      var dlg = t.closest('dialog.it-dlg'); if (!dlg) return;
      if (t.closest('[data-cancel]')) { dlg.close(); return; }
      if (t.closest('[data-done]')) setTimeout(function () { if (dlg.open) dlg.close(); }, 900);
    });
    function shown(sec, editing) {
      var empty = sec.getAttribute('data-empty') === '1';
      var q = function (s) { return sec.querySelector(s); };
      q('form.it-ed').hidden = !editing;
      q('[data-view]').hidden = empty;
      var none = q('[data-none]'); if (none) none.hidden = editing || !empty;
      q('h4 .it-edit').hidden = editing || empty;
    }
    info.addEventListener('click', function (ev) {
      var t = ev.target; if (!t || !t.closest) return;
      var sec = t.closest('section[data-field]'); if (!sec) return;
      // Only the panel's own Edit buttons: the Iterations page itself carries data-edit.
      if (t.closest('button[data-edit]')) {
        ev.preventDefault();
        sec.querySelector('[data-saved]').hidden = true;
        shown(sec, true);
        var box = sec.querySelector('form.it-ed textarea'); if (box) box.focus();
      } else if (t.closest('[data-cancel-edit]')) {
        sec.querySelector('form.it-ed').reset();
        shown(sec, false);
      }
    });
    var tplNow = null;
    function keep() {
      if (!tplNow) return;
      tplNow.content.replaceChildren();
      for (var c = info.firstChild; c; c = c.nextSibling) tplNow.content.appendChild(c.cloneNode(true));
      var s = tplNow.content.querySelectorAll('[data-saved]'); for (var m = 0; m < s.length; m++) s[m].hidden = true;
    }
    info.addEventListener('submit', function (ev) {
      var form = ev.target; if (!form.classList || !form.classList.contains('it-ed')) return;
      ev.preventDefault();
      var sec = form.closest('section[data-field]'), said = sec.querySelector('[data-saved]');
      var save = form.querySelector('button[type="submit"]'); if (save) save.disabled = true;
      fetch(form.action, { method: 'POST', body: new FormData(form), headers: { accept: 'application/json' }, credentials: 'same-origin' }).then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, j: j }; }, function () { return { ok: false, j: {} }; });
      }).then(function (res) {
        if (save) save.disabled = false;
        if (!res.ok) { said.textContent = res.j.message || 'Not saved.'; said.classList.add('it-bad'); said.hidden = false; return; }
        var j = res.j;
        sec.querySelector('[data-view]').innerHTML = j.html;
        sec.setAttribute('data-empty', j.html === '' ? '1' : '0');
        var area = sec.querySelector('textarea[name="notes"]'); area.defaultValue = ''; area.value = '';
        shown(sec, false);
        said.textContent = 'Saved.'; said.classList.remove('it-bad'); said.hidden = false;
        if (saved) saved(j);
        keep();
      }, function () { if (save) save.disabled = false; said.textContent = 'Not saved: the forge did not answer.'; said.classList.add('it-bad'); said.hidden = false; });
    });
    return {
      show: function (p, f) {
        tplNow = f;
        player.replaceChildren(p.content.cloneNode(true));
        info.replaceChildren(f.content.cloneNode(true));
        var back = player.querySelector('input[name="back"]');
        if (back) back.value = location.pathname + location.search;
      },
      keep: keep,
    };
  }
`;
