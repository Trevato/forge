/**
 * The API reference as markup: operations by area, each a fold with its
 * parameters, body and replies as tables, and a Try it form. All of it is
 * server-rendered; the fold is a `<details>`, the search a GET form, and a
 * GET with no path parameter is a plain GET form, so nothing needs script.
 * `API_TRY_JS` only upgrades Try it to show the answer in place.
 */

import { runnable, type Area, type Field, type Operation, type Param } from "../contract/reference.ts";
import { html, when, type Html } from "./html.ts";
import { badge, btn, card, empty, row } from "./ui.ts";

const fields = (rows: readonly Field[], heading: string): Html | null =>
  rows.length === 0
    ? null
    : html`<h4>${heading}</h4>
        <table>
          ${rows.map(
            (f) => html`<tr><td class="mono">${f.name}</td><td class="mono muted">${f.type}</td><td class="muted small">${f.required ? "required" : ""}</td></tr>`,
          )}
        </table>`;

const params = (list: readonly Param[]): Html | null =>
  list.length === 0
    ? null
    : html`<h4>Parameters</h4>
        <table>
          ${list.map(
            (p) => html`<tr><td class="mono">${p.name}</td><td class="muted small">${p.in}</td><td class="mono muted">${p.type}</td><td class="muted small">${p.required ? "required" : ""}</td></tr>`,
          )}
        </table>`;

/** Try it: inputs for what the operation takes, a token you pick, and where the answer shows. */
function tryIt(o: Operation, base: string): Html {
  const inputs = o.params.filter((p) => p.in === "path" || p.in === "query");
  const plainGet = runnable(o);
  return html`<form class="try" method="get" action="${base}${o.path}" data-try data-method="${o.method.toUpperCase()}" data-path="${o.path}" data-base="${base}">
    <div class="field-row">
      ${inputs.map(
        (p) => html`<label class="field"><span class="muted small">${p.name}${p.required ? " *" : ""}</span>
          <input class="input" type="text" ${plainGet ? html`name="${p.name}"` : null} data-in="${p.in}" data-name="${p.name}" autocomplete="off" /></label>`,
      )}
      ${when(
        o.method !== "get",
        () => html`<label class="field"><span class="muted small">JSON body</span>
          <textarea class="input mono" rows="4" data-body autocomplete="off" spellcheck="false">{}</textarea></label>`,
      )}
      ${when(
        o.auth,
        () => html`<label class="field"><span class="muted small">Token (blank: your session)</span>
          <input class="input" type="password" data-token autocomplete="off" /></label>`,
      )}
    </div>
    <div class="form-actions">
      ${btn("Try it", { size: "sm", variant: "outline", ...(plainGet ? {} : { disabled: true }) })}
      <span class="muted small" data-status role="status"></span>
    </div>
    <pre data-answer hidden></pre>
  </form>`;
}

function operationRow(o: Operation, base: string, tryable: boolean): Html {
  return row({
    id: o.id,
    lead: badge(o.method.toUpperCase(), { variant: "secondary" }),
    title: html`<span class="mono">${o.path}</span>`,
    meta: html`${o.summary}`,
    trail: o.auth ? html`<span class="muted small">token</span>` : html``,
    data: { method: o.method },
    fold: {
      id: `op-${o.id}`.replace(/[^A-Za-z0-9_-]/g, "-"),
      open: false,
      body: html`<div class="card-body">
        ${params(o.params)}${o.body === undefined ? null : fields(o.body, "Body") ?? html`<h4>Body</h4><p class="muted small">JSON object.</p>`}
        ${o.replies.map(
          (r) => html`<h4>${r.status} <span class="muted small">${r.description}</span></h4>${fields(r.fields, "Fields")}`,
        )}
        ${tryable ? tryIt(o, base) : null}
      </div>`,
    },
  });
}

export interface ReferenceView {
  readonly areas: readonly Area[];
  readonly total: number;
  readonly query: string;
  /** Where the search form sends its GET. */
  readonly action: string;
  /** Operations can be tried in place (same origin as the page). */
  readonly tryable: boolean;
  readonly base?: string;
}

/** The search box, the count, and each area's operations. */
export function referenceBody(v: ReferenceView): Html {
  const shown = v.areas.reduce((n, a) => n + a.operations.length, 0);
  return html`<form class="bar" method="get" action="${v.action}" role="search">
      <input class="input" type="search" name="q" value="${v.query}" placeholder="Search path, method or summary" aria-label="Search the API" />
      ${btn("Search", { size: "sm", variant: "outline" })}
      ${when(v.query !== "", () => btn("Clear", { href: v.action, size: "sm", variant: "ghost" }))}
    </form>
    <p class="muted small">${v.query === "" ? `${v.total} operations in ${v.areas.length} areas` : `${shown} of ${v.total} operations match`}</p>
    ${v.areas.length === 0
      ? empty({ title: v.query === "" ? "No operations" : "No operation matches", note: v.query === "" ? "This API describes none." : "Try a shorter word." })
      : v.areas.map(
          (a) => html`<section id="area-${a.name.replace(/[^A-Za-z0-9_-]/g, "-")}">
            <h2>${a.name} <span class="muted small">${a.operations.length}</span></h2>
            ${card(html`<ul class="list">${a.operations.map((o) => operationRow(o, v.base ?? "", v.tryable))}</ul>`, { pad: false })}
          </section>`,
        )}`;
}

/**
 * Upgrades each Try it form: sends the request as the session (or the token
 * typed), and shows the status, time, Server-Timing and body in place. Static
 * text only; the page's data arrives in data-* attributes.
 */
export const API_TRY_JS = `
for (const form of document.querySelectorAll("form[data-try]")) {
  const button = form.querySelector("button");
  if (button) button.disabled = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const method = form.dataset.method;
    let path = form.dataset.path;
    const query = new URLSearchParams();
    for (const input of form.querySelectorAll("[data-in]")) {
      const value = input.value.trim();
      if (input.dataset.in === "path") path = path.replace("{" + input.dataset.name + "}", encodeURIComponent(value));
      else if (value !== "") query.set(input.dataset.name, value);
    }
    if (/[{}]/.test(path)) return setStatus("fill in every path parameter");
    if (method !== "GET" && !confirm(method + " " + path + " as you? It changes things.")) return;
    const headers = {};
    const token = form.querySelector("[data-token]");
    if (token && token.value.trim() !== "") headers.authorization = "Bearer " + token.value.trim();
    const init = { method, headers };
    const body = form.querySelector("[data-body]");
    if (method !== "GET" && body) { headers["content-type"] = "application/json"; init.body = body.value; }
    const url = (form.dataset.base || "") + path + (query.size ? "?" + query : "");
    const out = form.querySelector("[data-answer]");
    const started = performance.now();
    setStatus("…");
    try {
      const res = await fetch(url, init);
      const text = await res.text();
      let shown = text;
      try { shown = JSON.stringify(JSON.parse(text), null, 2); } catch {}
      const timing = res.headers.get("server-timing");
      setStatus(res.status + " " + res.statusText + " · " + Math.round(performance.now() - started) + " ms" + (timing ? " · " + timing : ""));
      out.textContent = shown.slice(0, 20000);
      out.hidden = false;
    } catch (e) {
      setStatus("the request failed");
    }
  });
  function setStatus(t) { form.querySelector("[data-status]").textContent = t; }
}
`;
