/**
 * The audit: who can do what, across every app the viewer can see.
 *
 * `GET /audit` is the first lens. It is read from git — each app's
 * `contract.json` at its default branch, through the evaluator the app
 * decides with — so it says what the policy *is*, never what someone
 * remembers deciding. Apps without a contract are not hidden: they are the
 * rows that say "unread", because an audit that leaves out what it cannot
 * read reads as a clean bill.
 *
 * The page is a viewer's view: the repositories they can read, and nothing
 * about the ones they cannot. A stranger sees the public apps' policies,
 * which are as public as the file in the repository.
 */

import { appsForRepos } from "../../core/apps.ts";
import { listReposVisibleTo, type Repo } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { audit, type Audited } from "../../contract/audit.ts";
import type { Cell } from "../../contract/can.ts";
import { html, when, type Html } from "../html.ts";
import { page } from "../layout.ts";
import { badge, card, empty, icon } from "../ui.ts";

const AUDIT_LIMIT = 200;

export async function auditPage(ctx: Ctx): Promise<Response> {
  const repos = listReposVisibleTo(ctx.app.db, ctx.auth.user, {
    limit: AUDIT_LIMIT,
  });
  const records = appsForRepos(
    ctx.app.db,
    repos.map((r) => r.id),
  );
  const apps = repos.filter((r) => records.has(r.id));
  const audited = await Promise.all(
    apps.map((repo) => audit(ctx.app.reposRoot, repo)),
  );
  const sound = audited.filter((a) => a.standing.kind === "sound");
  const unsound = audited.filter((a) => a.standing.kind === "unsound");
  const unread = audited.filter((a) => a.standing.kind === "unread");
  const open = sound.reduce(
    (n, a) => n + (a.standing.kind === "sound" ? a.standing.open.length : 0),
    0,
  );
  return page({
    ctx,
    title: "Audit",
    description:
      "Who can do what, across every app, read from each one's contract.",
    body: html`<div class="page-head">
        <h1>Audit</h1>
        <p class="muted">
          Who can do what, read from each app's <code>contract.json</code> at
          its default branch. Nothing here is remembered: it is what the policy
          says now.
        </p>
      </div>
      ${audited.length === 0
        ? empty({
            icon: "shield",
            title: "No apps to audit",
            note: "An app's policy shows here once it has a contract.",
          })
        : html`<p class="audit-sum">
              ${summary(sound.length, open, unsound.length, unread.length)}
            </p>
            ${unsound.map(unsoundCard)} ${sound.map(policyCard)}
            ${when(unread.length > 0, () => unreadCard(unread))}`}`,
  });
}

const count = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

/** One sentence, built as text so no markup whitespace lands before a comma. */
function summary(
  sound: number,
  open: number,
  unsound: number,
  unread: number,
): string {
  const parts = [
    `${count(sound, "app", "apps")} with a contract`,
    `${count(open, "door", "doors")} open to anyone`,
  ];
  if (unsound > 0)
    parts.push(`${count(unsound, "contract", "contracts")} unsound`);
  if (unread > 0) parts.push(`${count(unread, "app", "apps")} unread`);
  return `${parts.join(", ")}.`;
}

const name = (repo: Repo): string => `${repo.ownerName}/${repo.name}`;

/** One app's policy as a table: resources × verbs, a column per identity. */
function policyCard(a: Audited): Html {
  if (a.standing.kind !== "sound") return html``;
  const { identities, cells, contract } = a.standing;
  const resources = Object.keys(contract.resources);
  const verbs = ["create", "read", "update", "delete", "list"] as const;
  const at = (resource: string, verb: string, as: string): Cell | undefined =>
    cells.find(
      (c) => c.resource === resource && c.verb === verb && c.as === as,
    );
  return card(
    html`<div class="table-scroll">
      <table class="table audit" data-dense>
        <caption class="sr-only">
          ${name(a.repo)}: what each identity may do to each resource
        </caption>
        <thead>
          <tr>
            <th scope="col">resource</th>
            <th scope="col">verb</th>
            ${identities.map((as) => html`<th scope="col">${as}</th>`)}
          </tr>
        </thead>
        <tbody>
          ${resources.flatMap((resource) =>
            verbs.map(
              (verb, i) =>
                html`<tr>
                  ${i === 0
                    ? html`<th scope="rowgroup" rowspan="${verbs.length}">
                        ${resource}
                      </th>`
                    : null}
                  <th scope="row">${verb}</th>
                  ${identities.map((as) => {
                    const cell = at(resource, verb, as);
                    return html`<td data-answer="${cell?.answer ?? "no"}">
                      ${answer(cell?.answer ?? "no")}
                    </td>`;
                  })}
                </tr>`,
            ),
          )}
        </tbody>
      </table>
    </div>`,
    {
      pad: false,
      head: html`<a href="/${a.repo.ownerName}/${a.repo.name}" class="audit-app"
          >${icon("repo")} ${name(a.repo)}</a
        >
        <span class="audit-trail">
          ${a.standing.open.length === 0
            ? badge("closed to strangers", { tone: "success" })
            : badge(
                `${count(a.standing.open.length, "door", "doors")} open to anyone`,
                { tone: "attn" },
              )}
          ${a.oid === undefined
            ? null
            : html`<code class="muted">${a.oid.slice(0, 7)}</code>`}
        </span>`,
    },
  );
}

function answer(a: Cell["answer"]): Html {
  return html`<span class="audit-answer" data-answer="${a}">${a}</span>`;
}

function unsoundCard(a: Audited): Html {
  if (a.standing.kind !== "unsound") return html``;
  return card(
    html`<ul class="audit-problems">
      ${a.standing.problems.map((p) => html`<li>${p}</li>`)}
    </ul>`,
    {
      tone: "danger",
      head: html`<a href="/${a.repo.ownerName}/${a.repo.name}" class="audit-app"
          >${icon("alert")} ${name(a.repo)}</a
        >
        <span class="audit-trail"
          >${badge("contract unsound", { tone: "danger" })}</span
        >`,
    },
  );
}

function unreadCard(unread: readonly Audited[]): Html {
  return card(
    html`<p class="muted small">
        These apps have no <code>contract.json</code>: their doors are written
        by hand, and this page cannot say what they allow.
      </p>
      <ul class="audit-unread">
        ${unread.map(
          (a) =>
            html`<li>
              <a href="/${a.repo.ownerName}/${a.repo.name}">${name(a.repo)}</a>
            </li>`,
        )}
      </ul>`,
    { head: html`<h3 class="audit-app">${icon("eye")} Unread</h3>` },
  );
}
