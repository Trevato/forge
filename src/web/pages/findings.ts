/**
 * Findings (#9593): `/:owner/:name/findings` lists what code scanning found
 * in a repository — the rule, the file and line, never the matched text —
 * open high findings first, each of which holds a release. A person with
 * write access accepts one with a reason; who, why and when show on it.
 * Reached from the flows view's "Code scanning" line. Server-rendered, no script.
 */

import { acceptFinding, REASON_MAX, REASON_MIN } from "../../actions/scan_accept.ts";
import { lastScan, listFindings, type FindingRow } from "../../checks/scan_store.ts";
import { canWrite } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { notePhase, takeSessionTime } from "../../core/route_timing.ts";
import { crumbsFor, loadRepo, notFoundPage, pageHead, repoBase, repoHeader, repoPalette } from "../chrome.ts";
import { field as formField, readForm } from "../form.ts";
import { html, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import { badge, btn, field, row, time } from "../ui.ts";

/** When a pass last ran, and whether it read everything: a partial pass says how many files it left out. */
export function passWords(run: { at: string; skipped: number } | null): Html {
  if (run === null) return html`never`;
  const partial = run.skipped === 0 ? "" : ` (partial: ${run.skipped} ${run.skipped === 1 ? "file" : "files"} not read)`;
  return html`${time(run.at)}${partial}`;
}

const where = (f: FindingRow): string => `${f.path}${f.line > 0 ? `:${f.line}` : ""}`;

function findingRow(f: FindingRow, base: string, writer: boolean): Html {
  const tone = f.accepted !== null ? "default" : f.severity === "high" ? "danger" : "attn";
  const meta = f.accepted !== null
    ? html`${where(f)} · accepted by ${f.accepted.by} ${time(f.accepted.at)}: ${f.accepted.reason}`
    : html`${where(f)} · ${f.kind} · found ${time(f.foundAt)} at ${f.oid.slice(0, 12)}`;
  // A finding has no page of its own: a row opens the file at the commit that found it, on the line.
  const href = `${base}/blob/${f.oid}/${f.path.split("/").map(encodeURIComponent).join("/")}${f.line > 0 ? `#L${f.line}` : ""}`;
  const line = row({ href, nav: true, title: html`${f.rule}`, meta, trail: badge(f.accepted !== null ? "accepted" : f.severity, { tone }) });
  if (f.accepted !== null || !writer) return line;
  return html`${line}
    <form method="post" action="${base}/findings/${String(f.id)}/accept" class="mt">
      ${field({ label: "Why it may stand", name: "reason", id: `reason-${f.id}`, required: true, minlength: REASON_MIN, maxlength: REASON_MAX })}
      ${btn("Accept", { variant: "secondary" })}
    </form>`;
}

// GET /:owner/:name/findings
export function findingsPage(ctx: Ctx): Response {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const rendering = performance.now();
  const user = ctx.auth.user;
  const writer = user !== undefined && user.kind === "user" && canWrite(ctx.app.db, repo, user);
  const base = repoBase(repo);
  const rows = listFindings(ctx.app.db, repo.id);
  const push = lastScan(ctx.app.db, repo.id, "push");
  const nightly = lastScan(ctx.app.db, repo.id, "nightly");
  const body = html`${repoHeader(ctx, repo, "flows")}
    ${pageHead("Findings", { sub: "Every push is scanned for secrets and advisories; each night adds static analysis. An open high finding holds a release until a person accepts it." })}
    <p class="muted">Last push scan ${passWords(push)} · last nightly scan ${passWords(nightly)}</p>
    <section class="mt">
      <h2>Findings</h2>
      ${rows.length === 0
        ? html`<p class="muted">Nothing found.</p>`
        : html`<ul class="list">
            ${rows.map((f) => findingRow(f, base, writer))}
          </ul>`}
    </section>
    <p class="mt">${btn("Back to flows", { variant: "secondary", href: `${base}/flows` })}</p>`;
  const res = page({ ctx, title: `Findings · ${repo.name}`, crumbs: crumbsFor(repo), palette: repoPalette(ctx, repo), body });
  notePhase(ctx.request, "render", performance.now() - rendering);
  return res;
}

// POST /:owner/:name/findings/:id/accept
export async function findingAccept(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  const back = `${repoBase(repo)}/findings`;
  const id = /^\d{1,15}$/.test(ctx.params.id ?? "") ? Number(ctx.params.id) : 0;
  const done = acceptFinding(ctx.app, repo, ctx.auth.user, id, formField(form, "reason"));
  if (!done.ok) return flashTo(ctx, back, { tone: "danger", message: done.why });
  return flashTo(ctx, back, { message: "Accepted. The reason is recorded on the finding." });
}
