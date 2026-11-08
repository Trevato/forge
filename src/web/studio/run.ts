/**
 * One run: the transcript a person sits on while waiting for a change to
 * become visible — who is on it, the tell it came from, what it has cost,
 * its own lines as they land — and the one control a live run has, Stop,
 * which the home and the app page put on a row of their own. The one run
 * page, for every repository and every viewer (`runPage`, `pages/runs.ts`);
 * the whole transcript, past the window this page holds, is its depth step
 * at `?all=1`.
 */

import { checkSteps, stepWord, type LookVitals } from "../../checks/summary.ts";
import { vitalsTable } from "./vitals.ts";
import { parseTestsRow, testsRowWords } from "../../checks/tests-row.ts";
import { directionNote } from "../../crew/direct.ts";
import { appsRuntime } from "../../apps/runtime.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { carriedBy } from "../../core/carried.ts";
import { getIssueById } from "../../core/issues.ts";
import { getPull, openPullsClosing } from "../../core/pulls.ts";
import { canSeeOwnerFacts, type Repo } from "../../core/repos.ts";
import { getRepoRun } from "../../actions/runs.ts";
import { runCardPath } from "../og/path.ts";
import { isTerminal, type Run } from "../../core/runs.ts";
import { listHeldSecrets } from "../../core/run_secret.ts";
import { getUserById } from "../../core/users.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { crumbsFor, repoBase, repoHeader, repoPalette } from "../chrome.ts";
import { liveRegionsJs, studioRunJs } from "../client.ts";
import { html, raw, when, type Html } from "../html.ts";
import { runLine } from "../describe.ts";
import { page } from "../layout.ts";
import { badge, btn, card, listCard, row as stepRow, sha, type Tone } from "../ui.ts";
import { previewCard } from "../pages/apps.ts";
import { costText, durationText, RUN_PAGE_CSS, runTitle, runTokens } from "../pages/runs.ts";
import { placementLine, sandboxLine } from "./sandbox.ts";
import { logBox, runVoice, RUN_TRANSCRIPT_CAP } from "./log.ts";
import { changeHref, tellHref } from "./nouns.ts";
import { unnamedRun, voiceFor, type Actor } from "./voice.ts";
import { runWord, servingHistory, wordBadge, type WordCtx } from "./words.ts";

/** A step's badge: red only where it failed; waiting and skipped stay quiet. */
const STEP_TONES: Record<string, Tone> = { ok: "success", failed: "danger", running: "attn" };

/**
 * The one control a live run has: a person who can write here stops a
 * running one or takes a queued one back off the board. Nothing for runs
 * that are over, or for readers.
 */
export function stopForm(ctx: Ctx, repo: Repo, run: Run): Html | null {
  if (run.state !== "running" && run.state !== "queued") return null;
  if (run.kind !== "agent") return null;
  if (!canSeeOwnerFacts(ctx.app.db, repo, ctx.auth.user)) return null;
  return html`<form
    method="post"
    action="${repoBase(repo)}/runs/${run.id}/cancel"
  >
    ${btn(run.state === "running" ? "Stop" : "Cancel", {
      size: "sm",
      variant: "outline",
    })}
  </form>`;
}

/**
 * The web-vitals table of a check's run page: nothing for another kind of
 * run, for a reader the log is hidden from (as the rows are), or when no
 * look recorded anything.
 */
export function vitalsBlock(
  run: Pick<Run, "kind">,
  logHidden: boolean,
  looks: readonly LookVitals[],
): Html {
  return run.kind === "check" && !logHidden ? vitalsTable(looks) : html``;
}

/**
 * GET /:owner/:name/runs/:id: who is on it, the tell it came from, the
 * commit a deploy or a check is about, how long it has gone and what it has
 * cost, the secrets it held, the transcript itself, and its state in the
 * studio's own word — the page someone sits on while waiting for a change
 * to become visible. `?all=1` holds the whole transcript instead of its
 * last window.
 */
export async function runView(
  ctx: Ctx,
  repo: Repo,
  run: Run,
  lines: readonly string[],
  truncated: boolean,
  logHidden = false,
  /** `readLooks` of the run; the caller reads it, as it reads the log. */
  looks: readonly LookVitals[] = [],
): Promise<Response> {
  const db = ctx.app.db;
  const base = repoBase(repo);
  const writer = canSeeOwnerFacts(db, repo, ctx.auth.user);
  const actor = run.actorId === null ? undefined : getUserById(db, run.actorId);
  const issue =
    run.issueId === null ? undefined : getIssueById(db, run.issueId);
  // A deploy or a check speaks for itself (`runVoice`, shared with the tail
  // `studio/previews.ts` opens for the same lines while production comes
  // up); anything else is named by the one rule for it — `voiceFor`
  // (`studio/voice.ts`) says who is named and why. The title and the
  // transcript take the same name, so the page never carries two. The
  // steer box below is writer-only already, so it only ever renders with
  // the real name.
  const by: Actor = {
    name: actor?.username,
    isAgent: actor?.kind === "agent",
  };
  const who = runVoice(run.kind, writer, by);
  const title = runTitle(run, voiceFor(by, writer, unnamedRun(writer)), issue);
  const wordCtx: WordCtx = {
    db,
    dir: repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
    runtime: appsRuntime(ctx.app),
    record: getAppByRepo(db, repo.id),
    history: servingHistory(),
    viewer: ctx.auth.user,
  };
  const { word } = await runWord(wordCtx, run);
  const unfinished = !isTerminal(run.state);
  const duration = durationText(run);
  const all = ctx.url.searchParams.get("all") === "1";
  const held = listHeldSecrets(db, run.id);
  const carried = carriedBy(db, run.id);
  const logPath = `/api/v1/repos/${repo.ownerName}/${repo.name}/runs/${run.id}/log`;

  // The pull this run's tell has become, once one exists: the tell itself
  // when the run is already a pull's own (feedback, a failed check, a
  // conflict fix), or the open pull that closes it while the run is still
  // the tell's first build — the case this page matters most for.
  const pull =
    issue === undefined
      ? undefined
      : issue.kind === "pull"
        ? getPull(db, repo.id, issue.number)
        : openPullsClosing(db, repo.id).get(issue.number);

  // The head — the run's word, cost, turns, clock and summary — is the
  // page's live region while the run is going: any `run.*` event for this
  // repository refetches the page and swaps the head in place, so the run
  // finishing shows its final state without a reload. Its id stays once the
  // run is over, so the last swap still finds its match.
  const head = html`<div
    class="page-head"
    id="run-head"
    ${unfinished
      ? html`data-live="run.*" data-live-repo="${repo.ownerName}/${repo.name}"`
      : null}
  >
    <h1>${title}</h1>
    <div class="page-head-sub bar muted small">
      ${wordBadge(word, "run-word")}
      ${when(
        issue,
        (i) =>
          html`<a
            href="${i.kind === "pull"
              ? changeHref(base, i.number)
              : tellHref(base, i.number)}"
            >#${i.number} ${i.title}</a
          >`,
      )}
      ${when(run.kind !== "agent" && run.commitOid !== "", () =>
        sha(run.commitOid, `${base}/commit/${run.commitOid}`),
      )}
      ${when(
        writer,
        () =>
          html`<span
              class="num"
              id="run-cost"
              ${run.costUsd > 0 ? null : html`hidden`}
              >${costText(run.costUsd)} spent</span
            >
            ${runTokens(db, run)}
            <span
              class="num"
              id="run-turns"
              ${run.turns > 0 ? null : html`hidden`}
              >${run.turns} turn${run.turns === 1 ? "" : "s"}</span
            >`,
      )}
      ${when(
        duration,
        (d) =>
          html`<span
            class="num"
            id="run-elapsed"
            data-started="${run.startedAt ?? ""}"
            data-finished="${run.finishedAt ?? ""}"
            >${run.finishedAt === null ? "running for" : "took"} ${d}</span
          >`,
      )}
    </div>
    <p class="mt" id="run-summary">${run.summary}</p>
    ${when(
      carried.length > 0,
      () =>
        html`<p class="muted small" id="run-carries">
          Carries
          ${carried.map(
            (n, i) =>
              html`${i === 0 ? "" : ", "}<a href="${changeHref(base, n)}"
                  >#${n}</a
                >`,
          )}.
        </p>`,
    )}
    ${sandboxLine(run)}
    ${placementLine(run)}
    ${when(
      held.length > 0,
      () =>
        html`<p class="muted small" id="run-secrets">
          Secrets held:
          ${held.map((h) => h.name).join(", ")}${held.every(
            (h) => h.releasedAt !== null,
          )
            ? " (released)"
            : ""}.
          Values are never shown.
        </p>`,
    )}
  </div>`;

  const body = html`${repoHeader(ctx, repo, "runs", {
      compact: true,
      ownTitle: true,
    })}
    ${head}
    ${when(
      writer && unfinished && run.kind === "agent" && issue === undefined,
      () =>
        html`<div class="bar mt" id="run-cancel">
          <form method="post" action="${base}/runs/${run.id}/cancel">
            ${btn("Stop", { size: "sm", variant: "outline", icon: "square" })}
          </form>
        </div>`,
    )}
    ${when(
      writer && unfinished && run.kind !== "agent",
      () =>
        html`<div class="bar mt" id="run-cancel">
          <form method="post" action="${base}/runs/${run.id}/cancel">
            ${btn("Cancel run", {
              size: "sm",
              variant: "outline",
              icon: "square",
            })}
          </form>
        </div>`,
    )}
    ${when(pull, (p) => previewCard(ctx, repo, p))}
    ${when(
      logHidden,
      () =>
        html`<p class="muted small" id="run-log-hidden">
          The log is for this repository's writers and crew.
        </p>`,
    )}
    ${when(
      truncated,
      () =>
        html`<p class="muted small mb">
          Showing the last 512 KB of the log; the file on disk has the rest.
        </p>`,
    )}
    ${when(
      lines.length === 0 && !logHidden,
      () =>
        html`<p class="muted small" id="run-empty">
          Nothing has been logged yet.
        </p>`,
    )}
    ${when(
      // Progress is read from the log, so a reader the log is hidden from
      // gets no rows either.
      run.kind === "check" && !logHidden,
      () => {
        const steps = checkSteps(run, lines, truncated);
        const row = parseTestsRow(lines);
        const words = testsRowWords(row);
        const known = row.of !== undefined && row.started !== undefined && row.started <= row.of;
        const open = run.state === "queued" || run.state === "running";
        const running = row.running ?? [];
        const runningWords =
          running.length === 0
            ? ""
            : `running ${running.slice(0, 2).join(", ")}${running.length > 2 ? ` +${running.length - 2}` : ""}`;
        // While the run is open every part is rendered at a fixed size (the
        // pin slot by CSS), so the log below never moves as numbers and pins
        // arrive; a run that has ended reserves nothing.
        return html`<div data-check-progress id="check-progress" data-state="${run.state}">
          <div id="check-steps" role="status" aria-live="polite">
            ${listCard(
              steps.map((s) =>
                stepRow({
                  title: s.name,
                  data: { step: s.name, state: s.state },
                  trail: badge(stepWord(s.state), {
                    tone: STEP_TONES[s.state] ?? "default",
                    variant: "outline",
                  }),
                }),
              ),
            )}
            ${known
              ? html`<progress aria-label="Test files started" max="${row.of ?? 0}" value="${row.started ?? 0}"></progress>`
              : open
                ? html`<progress aria-label="Test files started"></progress>`
                : ""}
            <p class="check-words small muted break">${[words, runningWords].filter((w) => w !== "").join(" · ")}</p>
          </div>
          <div data-pins id="check-pins"${row.failures.length > 0 ? raw(' role="region" tabindex="0" aria-label="Failed tests"') : ""}>
            ${row.failures.map((f) =>
              card(
                html`<strong class="break">${f.name}</strong>${when(
                  f.lines.length > 0,
                  () => html`<pre class="break">${f.lines.join("\n")}</pre>`,
                )}`,
                { tone: "danger" },
              ),
            )}
          </div>
        </div>`;
      },
    )}
    ${vitalsBlock(run, logHidden, looks)}
    <div class="mt" id="run-live" data-state="${run.state}">
      ${when(
        // The head above is what makes \`liveRegionsJs\` open the one
        // /events connection this log and its finish ride on.
        unfinished && !logHidden,
        () => html`<p class="muted small" id="run-conn" role="status" hidden>
          Reconnecting; lines written meanwhile appear when it is back.
        </p>`,
      )}
      ${when(!logHidden, () => logBox({
        id: "run-log",
        anchors: true,
        who,
        cap: all
          ? Math.max(lines.length, RUN_TRANSCRIPT_CAP)
          : RUN_TRANSCRIPT_CAP,
        lines,
        allHref: `${base}/runs/${run.id}?all=1`,
        truncated,
        // Lines come from the shared /events stream; `seen` lets the page
        // tell what it already drew from what it missed before connecting
        // (only knowable when the file was read whole).
        ...(unfinished
          ? {
              live: {
                run: run.id,
                log: logPath,
                ...(truncated ? {} : { seen: lines.length }),
              },
            }
          : {}),
        pulse: run.state === "running",
        extra: html`<button
          type="button"
          class="btn"
          data-size="sm"
          data-variant="primary"
          id="run-jump"
          hidden
        >
          newer below
        </button>`,
      }))}
      ${when(
        run.kind === "agent",
        () => html`<p class="muted small crew-note">${directionNote(repo)}</p>`,
      )}
      ${when(
        writer && run.kind === "agent" && issue !== undefined,
        () =>
          html`<form
            class="card stack"
            id="run-steer"
            method="post"
            action="${base}/runs/${run.id}/steer"
            data-api="/api/v1/repos/${repo.ownerName}/${repo.name}/runs/${run.id}/steer"
            data-running="${run.state === "running" ? "1" : "0"}"
          >
            <label class="sr-only" for="steer-text"
              >Say something to ${who}</label
            >
            <textarea
              class="input break"
              id="steer-text"
              name="text"
              rows="1"
              required
              placeholder="${run.state === "running"
                ? `Steer ${who} — it hears you at its next step`
                : `Tell ${who} for its next run`}"
            ></textarea>
            <div class="bar">
              <span class="muted small" id="run-steer-note"
                >${run.state === "running"
                  ? "Heard after the step it is on. Enter sends; every word is kept in the log."
                  : "The run is over; this goes on the conversation and starts a run."}</span
              >
              <span class="spacer"></span>
              ${when(
                unfinished,
                () =>
                  html`<button
                    type="submit"
                    class="btn"
                    data-size="sm"
                    data-variant="outline"
                    id="run-stop"
                    formaction="${base}/runs/${run.id}/cancel"
                    formnovalidate
                  >
                    ${run.state === "running" ? "Stop" : "Cancel"}
                  </button>`,
              )}
              ${btn("Send", { size: "sm", variant: "primary", type: "submit" })}
            </div>
          </form>`,
      )}
    </div>`;

  return page({
    ctx,
    title: `${title} · ${repo.name}`,
    description: runLine({
      private: repo.visibility === "private",
      word,
      commitOid: run.kind === "agent" ? "" : run.commitOid,
      summary: run.summary,
    }),
    ogImage: runCardPath(repo, run.id, getRepoRun(ctx.app, undefined, repo, run.id).ok),
    crumbs: crumbsFor(repo),
    palette: repoPalette(ctx, repo),
    body,
    styleCss: RUN_PAGE_CSS,
    scriptJs: `${liveRegionsJs}\n${studioRunJs}`,
  });
}
