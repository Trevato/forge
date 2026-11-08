/**
 * A repository's display page, `/<owner>/<repo>/display`: the builds its
 * `display.json` holds (`display/config.ts`), as whoever is looking may read
 * them; a build whose repository the viewer cannot read shows its name and
 * version alone. A writer also gets a form to choose the builds, which works
 * without script (POST here) and, with script, sends the API's PUT. Editing
 * the title, covers and the player wait. A bad `display.json` shows its error.
 */

import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../../core/route_timing.ts";
import { chooseBuilds, choosableBuilds, parseChoice } from "../../actions/displays.ts";
import { displayItems, selectionKeys } from "../../display/items.ts";
import { writesDisplay } from "../../display/selections.ts";
import { exactRefOid } from "../../git/branches.ts";
import { repoDir } from "../../git/repos.ts";
import { INVALID_TITLE, displayOf } from "../../display/known.ts";
import { repoShotsUrl } from "../../display/launch.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, forbiddenPage, loadRepo, notFoundPage, repoBase, repoHeader, repoPalette } from "../chrome.ts";
import { html, raw } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { btn, empty } from "../ui.ts";
import { readForm } from "../form.ts";

const LAYOUT_WORD = { shelf: "Shelf", grid: "Grid", graph: "Graph" } as const;

/** Saving the form is a PUT; without script the checkboxes still show what is chosen. */
const CHOOSE_JS = `document.querySelectorAll("form[data-choose]").forEach(function (f) {
  f.addEventListener("submit", function (e) {
    e.preventDefault();
    var s = f.querySelector("[data-choose-status]");
    var builds = Array.prototype.map.call(f.querySelectorAll("input[name=build]:checked"), function (i) { return i.value; });
    fetch(f.getAttribute("data-choose"), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(f.elements.tip ? { builds: builds, tip: f.elements.tip.value } : { builds: builds }), credentials: "same-origin" })
      .then(function (r) { return r.ok ? location.reload() : r.json().then(function (j) { s.textContent = j.message || "Not saved"; }); })
      .catch(function () { s.textContent = "Not saved"; });
  });
});`;

// GET /:owner/:name/display — 404 for a repository with no display.json or one the viewer cannot read.
export async function displayPage(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = loadRepo(ctx);
  if (!repo) return timePhase(ctx.request, "render", () => notFoundPage(ctx));
  const config = await timePhaseAsync(ctx.request, "display", () => displayOf(ctx.app, repo));
  if (config === undefined) return timePhase(ctx.request, "render", () => notFoundPage(ctx));
  const items = config.ok ? await timePhaseAsync(ctx.request, "items", () => displayItems(ctx.app, repo, config.value, ctx.auth.user)) : [];
  const writes = config.ok && writesDisplay(ctx.app, repo, ctx.auth.user);
  const chosen = writes && config.ok ? await selectionKeys(ctx.app, config.value, ctx.auth.user) : [];
  const choices = writes && config.ok ? await choosableBuilds(ctx.app, config.value, chosen, ctx.auth.user) : [];
  const tip = writes ? await exactRefOid(repoDir(ctx.app.reposRoot, repo.ownerName, repo.name), `refs/heads/${repo.defaultBranch}`) : undefined;
  const title = config.ok ? config.value.title : INVALID_TITLE;
  const body = html`${repoHeader(ctx, repo, "code", { compact: true })}
    <div class="page-head mt">
      <h2>${title}</h2>
      <a href="/displays">All displays</a>
    </div>
    ${!config.ok
      ? html`<p role="alert">${config.error}</p>`
      : items.length === 0
        ? empty({ icon: "pin", title: "No builds", note: "This display shows no builds yet." })
        : html`<p>${LAYOUT_WORD[config.value.layout]} · ${String(items.length)} ${items.length === 1 ? "build" : "builds"}</p>
          <div class="table-scroll" role="region" tabindex="0" aria-label="Builds">
            <table class="table" data-dense data-by="display-builds">
              <thead>
                <tr><th scope="col">Build</th><th scope="col">Version</th><th scope="col">Repository</th></tr>
              </thead>
              <tbody>
                ${items.map((it) =>
                  it.open
                    ? html`<tr data-build="${it.key}">
                        <td><a href="${repoShotsUrl(it.repo, it.pin)}">${it.demo.name}</a></td>
                        <td class="mono">${it.demo.version}</td>
                        <td><a class="mono" href="${repoBase(it.repo)}">${it.repo.ownerName}/${it.repo.name}</a></td>
                      </tr>`
                    : html`<tr data-build="private">
                        <td>${it.demo.name}</td>
                        <td class="mono">${it.demo.version}</td>
                        <td>Private</td>
                      </tr>`,
                )}
              </tbody>
            </table>
          </div>`}
    ${writes
      ? html`<form class="mt" method="post" action="${repoBase(repo)}/display" data-choose="/api/v1/repos/${repo.ownerName}/${repo.name}/display/builds">
          <fieldset class="field">
            <legend>Choose builds</legend>
            ${choices.length === 0
              ? html`<p class="hint">No builds to choose from yet.</p>`
              : choices.map(
                  (key) => html`<label class="check"><input type="checkbox" name="build" value="${key}" ${chosen.includes(key) ? raw("checked") : null} />
                    <span class="mono">${key}</span></label>`,
                )}
          </fieldset>
          ${tip === undefined ? null : html`<input type="hidden" name="tip" value="${tip}" />`}
          ${btn("Save builds", { variant: "primary" })}
          <p class="hint" role="status" data-choose-status></p>
        </form>`
      : null}`;
  return timePhase(ctx.request, "render", () =>
    page({ ctx, title: `Display · ${repo.name}`, ...(writes ? { scriptJs: CHOOSE_JS } : {}), crumbs: crumbsFor(repo), palette: repoPalette(ctx, repo), body }),
  );
}

// POST /:owner/:name/display — the form without script: choose the ticked builds, then back to the page.
export async function displayChoose(ctx: Ctx): Promise<Response> {
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const back = `${repoBase(repo)}/display`;
  const picked = form.getAll("build").filter((v): v is string => typeof v === "string");
  const tip = form.get("tip");
  const parsed = parseChoice({ builds: picked, ...(typeof tip === "string" && tip !== "" ? { tip } : {}) });
  if (!parsed.ok) return flashTo(ctx, back, { tone: "danger", message: parsed.error });
  const done = await chooseBuilds(ctx.app, ctx.auth.user, repo, parsed.value.builds, parsed.value.tip);
  if (done.ok) return flashTo(ctx, back, { message: "Builds saved." });
  if (done.error.kind === "no_display") return notFoundPage(ctx);
  if (done.error.kind === "forbidden") return forbiddenPage(ctx, "Only a person who writes this repository can choose its builds.");
  return flashTo(ctx, back, { tone: "danger", message: done.error.message });
}
