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

import { appsRuntime } from "../../apps/runtime.ts";
import { appsForRepos, getAppByRepo } from "../../core/apps.ts";
import { canWrite, listReposVisibleTo, type Repo } from "../../core/repos.ts";
import type { Ctx } from "../../http/context.ts";
import {
  notePhase,
  takeSessionTime,
  timePhase,
  timePhaseAsync,
} from "../../core/route_timing.ts";
import { audit, type Audited } from "../../contract/audit.ts";
import {
  contractChanges,
  crossingsWaiting,
  verdictChanges,
  wallSentence,
  type ContractChange,
  type Crossing,
  type VerdictChange,
} from "../../contract/changes.ts";
import type { Cell } from "../../contract/can.ts";
import {
  latestProbes,
  probeApp,
  type ProbeRow,
} from "../../contract/probes.ts";
import { loadRepo, notFoundPage, signInFirst } from "../chrome.ts";
import { readForm } from "../form.ts";
import { html, when, type Html } from "../html.ts";
import { flashTo, page } from "../layout.ts";
import {
  badge,
  btn,
  empty,
  icon,
  row,
  sha,
  time,
} from "../ui.ts";

const AUDIT_LIMIT = 200;

export async function auditPage(ctx: Ctx): Promise<Response> {
  const req = ctx.request;
  notePhase(req, "session", takeSessionTime(req));
  const repos = timePhase(req, "repos", () =>
    listReposVisibleTo(ctx.app.db, ctx.auth.user, { limit: AUDIT_LIMIT }),
  );
  const records = timePhase(req, "apps", () =>
    appsForRepos(
      ctx.app.db,
      repos.map((r) => r.id),
    ),
  );
  const apps = repos.filter((r) => records.has(r.id));
  const audited = await timePhaseAsync(req, "contracts", () =>
    Promise.all(apps.map((repo) => audit(ctx.app.reposRoot, repo))),
  );
  const sound = audited.filter((a) => a.standing.kind === "sound");
  const probed = timePhase(req, "probes", () =>
    latestProbes(
      ctx.app.db,
      sound.map((a) => records.get(a.repo.id)!.id),
    ),
  );
  const disobeying = sound.filter(
    (a) => probed.get(records.get(a.repo.id)!.id)?.verdict === "mismatch",
  );
  const unsound = audited.filter((a) => a.standing.kind === "unsound");
  const unread = audited.filter((a) => a.standing.kind === "unread");
  const open = sound.reduce(
    (n, a) => n + (a.standing.kind === "sound" ? a.standing.open.length : 0),
    0,
  );
  // The third lens: what moved. Contracts that changed, pulls at the wall,
  // apps whose doors started or stopped agreeing with their table.
  const changes = (
    await timePhaseAsync(req, "history", () =>
      Promise.all(
        audited
          .filter((a) => a.standing.kind !== "unread")
          .map((a) => contractChanges(ctx.app.reposRoot, a.repo)),
      ),
    )
  )
    .flat()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, 30);
  const crossings = timePhase(req, "crossings", () =>
    crossingsWaiting(ctx.app.db, apps),
  );
  const verdicts = timePhase(req, "verdicts", () =>
    verdictChanges(
      ctx.app.db,
      sound.map((a) => ({ repo: a.repo, appId: records.get(a.repo.id)!.id })),
    ),
  );
  const rendering = performance.now();
  const response = page({
    ctx,
    title: "Audit",
    description:
      "Who can do what, across every app, read from each one's contract.",
    ogImage: "/og/audit.png",
    body: html`<div class="page-head">
        <h1>Audit</h1>
        <span class="spacer"></span>
        ${btn("Table file", {
          href: "/audit.csv",
          size: "sm",
          icon: "download",
        })}
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
        : html`<p class="mb">
              ${summary(sound.length, open, unsound.length, unread.length)}
              ${when(disobeying.length > 0, () =>
                badge(
                  `${count(disobeying.length, "app disobeys", "apps disobey")} its table.`,
                  { tone: "danger", icon: "alert" },
                ),
              )}
            </p>
            ${unsound.map(unsoundSection)}
            ${sound.map((a) =>
              policySection(
                a,
                probed.get(records.get(a.repo.id)!.id),
                ctx.auth.user !== undefined &&
                  canWrite(ctx.app.db, a.repo, ctx.auth.user),
              ),
            )}
            ${when(unread.length > 0, () => unreadSection(unread))}
            ${changesSection(crossings, changes, verdicts)}`}`,
  });
  notePhase(req, "render", performance.now() - rendering);
  return response;
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

/**
 * A part of the page as a heading over its rows, never a box: the shared
 * `.settings-block` `<section>`, its `<h2>` on a `.bar` line (so a badge and
 * a commit sit beside the name), its rows under it on the page's one
 * background, its foot a second `.bar`. Its state is a badge's word, so it
 * carries no tone.
 */
const part = (body: Html, o: { head: Html; foot?: Html; id?: string }) =>
  html`<section class="settings-block" ${o.id ? html`id="${o.id}"` : null}>
    <div class="bar mb">${o.head}</div>
    ${body}
    ${o.foot ? html`<div class="bar mt">${o.foot}</div>` : null}
  </section>`;

/**
 * One app's policy as a table — resources × verbs, a column per identity —
 * with what the running app said last time the forge knocked, and, for
 * whoever can write it, a way to knock now.
 */
function policySection(
  a: Audited,
  last: ProbeRow | undefined,
  writer: boolean,
): Html {
  if (a.standing.kind !== "sound") return html``;
  const { identities, cells, contract } = a.standing;
  const resources = Object.keys(contract.resources);
  const verbs = ["create", "read", "update", "delete", "list"] as const;
  const at = (resource: string, verb: string, as: string): Cell | undefined =>
    cells.find(
      (c) => c.resource === resource && c.verb === verb && c.as === as,
    );
  return part(
    html`<div class="table-scroll">
      <table class="table" data-dense>
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
                        <code>${resource}</code>
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
    </div>
    ${when(last?.verdict === "mismatch", () => sentences(last!.said))}`,
    {
      id: `${a.repo.ownerName}-${a.repo.name}`,
      foot: probeFoot(a, last, writer),
      head: html`${appHead(a.repo)}
        ${a.standing.open.length === 0
          ? badge("closed to strangers", { tone: "success" })
          : badge(
              `${count(a.standing.open.length, "door", "doors")} open to anyone`,
              { tone: "attn" },
            )}
        ${a.oid === undefined ? null : sha(a.oid)}`,
    },
  );
}

/** What the app said when the forge last knocked, and the knock itself. */
function probeFoot(
  a: Audited,
  last: ProbeRow | undefined,
  writer: boolean,
): Html {
  const knock = when(
    writer,
    () =>
      html`<form
        method="post"
        action="/audit/${a.repo.ownerName}/${a.repo.name}/probe"
        class="inline"
      >
        ${btn("Knock now", {
          type: "submit",
          variant: "secondary",
          icon: "shield",
        })}
      </form>`,
  );
  if (last === undefined)
    return html`<span class="muted small"
        >Not yet asked: the forge knocks after every production deploy and once
        a night.</span
      >
      ${knock}`;
  const said =
    last.verdict === "ok"
      ? html`${badge("obeys its table", { tone: "success" })}`
      : last.verdict === "mismatch"
        ? html`${badge(
            `${count(last.said.length, "door disobeys", "doors disobey")}`,
            { tone: "danger" },
          )}`
        : last.verdict === "down"
          ? html`${badge("was not running", { tone: "attn" })}`
          : html`${badge("no door to knock on")}`;
  return html`${said}
    <span class="muted small">
      asked ${time(last.createdAt)} at ${sha(last.commitOid)}</span
    >
    ${knock}`;
}

/**
 * GET /audit.csv — the policy as a table file: one row per app, resource,
 * verb and identity, with the answer and what the running app last said.
 * A spreadsheet is a system people already use; this is the audit in it.
 */
export async function auditCsv(ctx: Ctx): Promise<Response> {
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
  const probed = latestProbes(
    ctx.app.db,
    apps.map((r) => records.get(r.id)!.id),
  );
  const cell = (v: string): string =>
    /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const rows: string[][] = [
    [
      "app",
      "commit",
      "standing",
      "resource",
      "verb",
      "identity",
      "answer",
      "door",
    ],
  ];
  for (const a of audited) {
    const app = name(a.repo);
    const commit = a.oid?.slice(0, 7) ?? "";
    if (a.standing.kind !== "sound") {
      rows.push([app, commit, a.standing.kind, "", "", "", "", ""]);
      continue;
    }
    const last = probed.get(records.get(a.repo.id)!.id);
    const door = (resource: string, verb: string, as: string): string => {
      const knock = last?.knocks.find(
        (k) => k.resource === resource && k.verb === verb && k.as === as,
      );
      return knock === undefined ? "" : knock.verdict;
    };
    for (const c of a.standing.cells)
      rows.push([
        app,
        commit,
        "sound",
        c.resource,
        c.verb,
        c.as,
        c.answer,
        door(c.resource, c.verb, c.as),
      ]);
  }
  const body = rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="audit.csv"',
      "cache-control": "private, no-store",
    },
  });
}

/** POST /audit/:owner/:name/probe — knock on one app now. */
export async function auditProbeSubmit(ctx: Ctx): Promise<Response> {
  const repo = loadRepo(ctx);
  if (!repo) return notFoundPage(ctx);
  if (!ctx.auth.user) return signInFirst(ctx);
  const form = await readForm(ctx, "rw");
  if (form instanceof Response) return form;
  if (!canWrite(ctx.app.db, repo, ctx.auth.user))
    return flashTo(ctx, "/audit", {
      tone: "danger",
      message: "You need write access to do that.",
    });
  const record = getAppByRepo(ctx.app.db, repo.id);
  const runtime = appsRuntime(ctx.app);
  if (record === undefined || runtime === undefined)
    return flashTo(ctx, "/audit", {
      tone: "danger",
      message: "Nothing is serving that app here.",
    });
  const row = await probeApp(ctx.app, runtime, record);
  return flashTo(ctx, "/audit", {
    ...(row === undefined || row.verdict === "mismatch"
      ? { tone: "danger" as const }
      : {}),
    message:
      row === undefined
        ? "That app has no sound contract to compare with."
        : row.verdict === "ok"
          ? `${repo.ownerName}/${repo.name} obeys its table.`
          : row.verdict === "mismatch"
            ? `${repo.ownerName}/${repo.name} disobeys its table: ${count(row.said.length, "door", "doors")}.`
            : row.verdict === "down"
              ? `${repo.ownerName}/${repo.name} is not running to be asked.`
              : `${repo.ownerName}/${repo.name} names no door to knock on.`,
  });
}

/** A cell's answer as a §5 badge: `yes` lets anyone through, so it is the loud one. */
function answer(a: Cell["answer"]): Html {
  return badge(a, {
    ...(a === "yes" ? { tone: "attn" as const } : {}),
    variant: a === "own" ? "secondary" : "outline",
  });
}

/** A section's head names the app it is about, linked. */
function appHead(repo: Repo): Html {
  return html`<h2><a href="/${repo.ownerName}/${repo.name}">${name(repo)}</a></h2>
    <span class="spacer"></span>`;
}

/** Whole sentences — what is wrong, what a door said — as §5 prose. */
function sentences(lines: readonly string[]): Html {
  return html`<div class="prose prose-page">
    <ul>
      ${lines.map((s) => html`<li>${s}</li>`)}
    </ul>
  </div>`;
}

function unsoundSection(a: Audited): Html {
  if (a.standing.kind !== "unsound") return html``;
  return part(sentences(a.standing.problems), {
    id: `${a.repo.ownerName}-${a.repo.name}`,
    head: html`${appHead(a.repo)}
    ${badge("contract unsound", { tone: "danger" })}`,
  });
}

function unreadSection(unread: readonly Audited[]): Html {
  return part(
    html`<ul class="list">
      ${unread.map((a) =>
      row({
        href: `/${a.repo.ownerName}/${a.repo.name}`,
        title: name(a.repo),
        lead: icon("repo"),
        nav: true,
      }),
      )}
    </ul>`,
    {
      head: html`<h2>Unread</h2>`,
      foot: html`<span class="muted small">
        These apps have no <code>contract.json</code>: their doors are written
        by hand, and this page cannot say what they allow.
      </span>`,
    },
  );
}

// ---- the third lens: what changed ----

function changesSection(
  crossings: readonly Crossing[],
  changes: readonly ContractChange[],
  verdicts: readonly VerdictChange[],
): Html {
  if (crossings.length === 0 && changes.length === 0 && verdicts.length === 0)
    return html``;
  return html`<section class="settings-block">
    <h2>What changed</h2>
    ${when(crossings.length > 0, () => crossingsSection(crossings))}
    ${when(changes.length > 0, () => contractChangesSection(changes))}
    ${when(verdicts.length > 0, () => verdictsSection(verdicts))}
  </section>`;
}

/** Pulls the crew left at the wall: each is a person's decision, waiting. */
function crossingsSection(crossings: readonly Crossing[]): Html {
  return part(
    html`<ul class="list">
      ${crossings.map(
        (c) =>
          html`<li>
            <a
              href="/${c.repo.ownerName}/${c.repo.name}/pulls/${c.pull.number}"
              class="row"
              data-nav
              tabindex="-1"
            >
              <span class="row-lead">${icon("pull")}</span>
              <span class="row-main">
                <span class="row-title">${c.pull.title}</span>
                <span class="row-meta"
                  >${name(c.repo)} #${c.pull.number} · waiting since
                  ${time(c.decision.createdAt)} ·
                  ${c.plain.join("; ")}</span
                >
              </span>
              <span class="row-trail"
                >${badge("at the wall", { tone: "attn" })}</span
              >
            </a>
          </li>`,
      )}
    </ul>`,
    {
      head: html`<h3>
          ${count(crossings.length, "pull waits", "pulls wait")} at the wall
        </h3>`,
    },
  );
}

/** Contract commits, newest first, each with what it did to the cells. */
export function contractChangesSection(changes: readonly ContractChange[]): Html {
  return part(
    html`<ul class="list">
      ${changes.map((c) => {
        const what = c.removed
          ? "the contract was removed"
          : c.unsound
            ? "the contract does not read"
            : c.loosened.length === 0 && c.tightened.length === 0
              ? "no cell changed"
              : [
                  c.loosened.length === 0
                    ? ""
                    : `${count(c.loosened.length, "door", "doors")} wider`,
                  c.tightened.length === 0
                    ? ""
                    : `${count(c.tightened.length, "door", "doors")} narrower`,
                ]
                  .filter((s) => s !== "")
                  .join(", ");
        const tone =
          c.removed || c.unsound
            ? "danger"
            : c.loosened.length > 0
              ? "attn"
              : c.tightened.length > 0
                ? "success"
                : "default";
        return html`<li>
          <div class="row" data-nav tabindex="-1">
            <span class="row-lead">${icon("commit")}</span>
            <span class="row-main">
              <span class="row-title">${name(c.repo)}: ${c.subject}</span>
              <span class="row-meta"
                >${sha(
                  c.oid,
                  `/${c.repo.ownerName}/${c.repo.name}/commit/${c.oid}`,
                )}
                · ${c.author} · ${time(c.date)}</span
              >
              ${c.loosened.map((l) => cellLine("wider", wallSentence(l)))}
              ${c.tightened.map((l) =>
                cellLine(
                  "narrower",
                  `${l.resource}.${l.verb} as ${l.as}: was ${l.to}, now ${l.from === "absent" ? "gone" : l.from}`,
                ),
              )}
            </span>
            <span class="row-trail">${badge(what, { tone })}</span>
          </div>
        </li>`;
      })}
    </ul>`,
    {
      head: html`<h3>
          ${count(changes.length, "contract change", "contract changes")}
        </h3>`,
    },
  );
}

/** Where an app's doors started or stopped agreeing with its table. */
function verdictsSection(verdicts: readonly VerdictChange[]): Html {
  const word = (v: VerdictChange["to"]): string =>
    v === "ok"
      ? "obeys its table"
      : v === "mismatch"
        ? "disobeys its table"
        : v === "down"
          ? "was not running"
          : "had no door to knock on";
  return part(
    html`<ul class="list">
      ${verdicts.map(
        (v) =>
          html`<li>
            <div class="row">
              <span class="row-lead"
                >${icon(
                  v.to === "ok"
                    ? "check"
                    : v.to === "mismatch"
                      ? "alert"
                      : "clock",
                )}</span
              >
              <span class="row-main">
                <span class="row-title">${name(v.repo)} ${word(v.to)}</span>
                <span class="row-meta"
                  >${v.from === undefined
                    ? "first knock"
                    : `before: ${word(v.from)}`}
                  · ${time(v.at)} at
                  <code>${v.commitOid.slice(0, 7)}</code></span
                >
                ${v.said.map((s) => cellLine(undefined, s))}
              </span>
            </div>
          </li>`,
      )}
    </ul>`,
    {
      head: html`<h3>Doors, over time</h3>`,
    },
  );
}

/**
 * One cell a change touched, as one more §5 row-meta line under the row's
 * title: which way it moved, then the cell. The whole sentence is its title,
 * so a line the row ellipsizes is still there to read.
 */
function cellLine(way: "wider" | "narrower" | undefined, text: string): Html {
  return html`<span
    class="row-meta"
    title="${text}"
    ${way === undefined ? null : html`data-way="${way}"`}
    >${way === undefined ? null : html`${way} · `}<code>${text}</code></span
  >`;
}
