/**
 * An app as one row on a shelf: its name and the one line under it, a dot
 * and a badge for whether it is live, what the crew last did there and when,
 * a pill for how many things it asks of you, and the way in — the row the
 * studio's home draws its *Your apps* card from, and the one every other
 * page that lists apps draws too, so an app looks the same wherever it is
 * shelved. Hand over repositories, get rows; nothing here knows what card
 * they land in.
 *
 * Every read is made once for the whole shelf and never once per row: the
 * app records in one query, the newest run of every app in one, who ran them
 * in one, the newest open change of every app in one, the asks in one pass.
 * The words are gathered together because `runWord` reads git. A caller that
 * has already read what asks the viewer — the home draws its asks panel from
 * the same list — hands that list in rather than paying for it twice.
 *
 * What a row says it is doing, in order: a run still in flight (that is the
 * thing moving); else an open change, whoever opened it — the row is about
 * the app, not about who typed it; else the most recent of the last run's
 * own word and production's own fact (`words.ts`'s `productionFact` — a
 * deploy that just landed or just failed), preferring the run's word when it
 * already says *shipped* so a change stays credited to whoever's own history
 * carries it rather than to the deploy behind it; else quiet, or
 * told-but-stuck when nobody on the crew can take it.
 */

import { spanWords } from "../../apps/golden_path.ts";
import { appsRuntime, type EnvStatus } from "../../apps/runtime.ts";
import { appsForRepos, type AppRecord } from "../../core/apps.ts";
import { reposWithBuilder } from "../../core/agents.ts";
import { reposWithUnclaimedTell } from "../../core/issues.ts";
import { openPullsForRepos } from "../../core/pulls.ts";
import { notePhase } from "../../core/route_timing.ts";
import { enterableApps, ownerFactRepoIds, type Repo } from "../../core/repos.ts";
import {
  getRunsByIds,
  isTerminal,
  latestAgentRunsForRepos,
} from "../../core/runs.ts";
import { getUsersByIds, type User } from "../../core/users.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase } from "../chrome.ts";
import { escapeHtml, html, raw, type Html } from "../html.ts";
import { dot, envPhrase, envTone, row, time } from "../ui.ts";
import {
  productionFact,
  pullWord,
  runWord,
  servingHistory,
  type ProductionFact,
  type ServingHistory,
  type WordCtx,
  NOBODY_ON_CREW,
} from "./words.ts";

/** Reads the caller has already made, so the shelf does not make them again. */
export interface ShelfReads {
  /** Production's own fact for each app — a deploy that just landed or just
   * failed. The home rail reads the same map for its own rows. */
  readonly productionFacts?: ReadonlyMap<string, ProductionFact> | undefined;
  /** The page's memo of production's history, when the page words more
   * than the shelf — the home's own rows ask the same question. */
  readonly history?: ServingHistory | undefined;
  /** Milliseconds from New app to the first preview, by repo id; a row
   * wears it beside its name only when it has one. */
  readonly firstPreview?: ReadonlyMap<string, number> | undefined;
  /** Something to hang under a row, by repo id (the archived list's Wake). */
  readonly under?: ReadonlyMap<string, Html> | undefined;
}

/**
 * Production's status for each of these apps, in one batch: the runtime's
 * environments are in memory and their domains are one read, so nothing per
 * app touches the database. `enterable` is who the viewer may see into
 * (`enterableApps`, the rule `envsFor` holds); the rest read as no status.
 */
function productionStatuses(
  ctx: Ctx,
  repos: readonly Repo[],
  records: ReadonlyMap<string, AppRecord>,
  enterable: ReadonlySet<string>,
): Map<string, EnvStatus | undefined> {
  const out = new Map<string, EnvStatus | undefined>();
  const runtime = appsRuntime(ctx.app);
  if (runtime === undefined) return out;
  const seen = repos.flatMap((r) => {
    const record = records.get(r.id);
    return record !== undefined && enterable.has(record.id) ? [record] : [];
  });
  const statuses = runtime.statusMany(seen);
  for (const repo of repos) {
    const record = records.get(repo.id);
    out.set(
      repo.id,
      record === undefined
        ? undefined
        : statuses.get(record.id)?.find((e) => e.env === "production"),
    );
  }
  return out;
}

/** Production's own fact for each status, reading the run rows it points to in one `IN`. */
function factsOf(
  ctx: Ctx,
  productions: ReadonlyMap<string, EnvStatus | undefined>,
): Map<string, ProductionFact> {
  const out = new Map<string, ProductionFact>();
  const runIds = new Set<string>();
  for (const production of productions.values()) {
    if (production?.runId !== undefined && production.createdAt !== undefined)
      runIds.add(production.runId);
    if (production?.failedDeploy !== undefined)
      runIds.add(production.failedDeploy.runId);
  }
  const runs = getRunsByIds(ctx.app.db, [...runIds]);
  for (const [repoId, production] of productions) {
    const fact = productionFact(production, runs);
    if (fact !== undefined) out.set(repoId, fact);
  }
  return out;
}

/**
 * Production's own fact for every one of these repositories, in one batch:
 * `runtime.status` is in-memory (no query), so the only reads are the app
 * records, who may enter them, their domains and the run rows a fact points
 * to — one each for the whole shelf, never one per row.
 */
export function productionFactsForRepos(
  ctx: Ctx,
  repos: readonly Repo[],
): Map<string, ProductionFact> {
  if (appsRuntime(ctx.app) === undefined) return new Map();
  const records = appsForRepos(
    ctx.app.db,
    repos.map((r) => r.id),
  );
  const enterable = enterableApps(
    ctx.app.db,
    repos.flatMap((repo) => {
      const app = records.get(repo.id);
      return app === undefined ? [] : [{ repo, app }];
    }),
    ctx.auth.user,
    { named: false },
  );
  return factsOf(ctx, productionStatuses(ctx, repos, records, enterable));
}

/** The row of a private app the viewer may not enter: its name, nothing it says. */
function sealedRow(repo: Repo, user: User | undefined): Html {
  const mine = user !== undefined && repo.ownerId === user.id;
  return row({
    href: repoBase(repo),
    nav: true,
    lead: dot("default"),
    title: mine
      ? repo.name
      : html`<span class="muted">${repo.ownerName}/</span>${repo.name}`,
    titleAttr: repo.description || repo.name,
    meta: html`<span class="muted">private app</span>${repo.description
      ? html` · ${repo.description}`
      : null}`,
    trail: raw(`\n        <span class="badge" data-tone="default">private</span>`),
  });
}

/**
 * These repositories as shelf rows, in the order they were handed in.
 */
export async function shelfRows(
  ctx: Ctx,
  repos: readonly Repo[],
  reads: ShelfReads = {},
): Promise<Html[]> {
  const db = ctx.app.db;
  const user = ctx.auth.user;
  const runtime = appsRuntime(ctx.app);
  const history = reads.history ?? servingHistory();
  const repoIds = repos.map((r) => r.id);
  // Each stretch is named for Server-Timing, so a slow shelf says where.
  let mark = performance.now();
  const lap = (name: string): void => {
    const now = performance.now();
    notePhase(ctx.request, `shelf-${name}`, now - mark);
    mark = now;
  };
  const records = appsForRepos(db, repoIds);
  // A public app you can only read appears here too, but who is on its
  // crew is its owner's fact, not yours to see — same predicate as the
  // app's own page.
  const ownerFacts = ownerFactRepoIds(db, repos, user);
  // Who may enter which private app, for the whole shelf in one batch.
  const enterable = enterableApps(
    db,
    repos.flatMap((repo) => {
      const app = records.get(repo.id);
      return app === undefined ? [] : [{ repo, app }];
    }),
    user,
    { named: false },
  );
  lap("records");
  // One read for the newest run of every app, one for who ran them: the
  // shelf must not get slower as the apps grow.
  const latestRuns = latestAgentRunsForRepos(db, repoIds);
  lap("runs");
  // Production's own fact, per app, one batch — a deploy that just landed or
  // just failed, the other half of what "the last thing that happened" can
  // mean now that it is not only an agent run.
  const productions = productionStatuses(ctx, repos, records, enterable);
  const productionFacts = reads.productionFacts ?? factsOf(ctx, productions);
  lap("production");
  const actors = getUsersByIds(
    db,
    [
      ...[...latestRuns.values()].map((r) => r.actorId),
      ...[...productionFacts.values()].map((f) => f.actorId),
    ].filter((id): id is string => id !== null),
  );
  // The newest open change of every app, one read — a person's own change
  // counts here too, not only one an agent run produced.
  const openPulls = openPullsForRepos(db, repoIds);
  // A tell nobody can pick up (the crew has no builder) is stuck, not quiet —
  // both reads batched across the whole shelf, never once per row.
  const withBuilder = reposWithBuilder(db, repoIds);
  const stuck = new Set(
    [...reposWithUnclaimedTell(db, repoIds)].filter(
      (id) => !withBuilder.has(id),
    ),
  );
  lap("pulls");

  const rows = await Promise.all(
    repos.map(async (repo) => {
      const record = records.get(repo.id);
      // A private app the viewer may not enter is a name on a shelf: no
      // state, no word, no crew — what it says about itself is its writers'
      // and crew's (`envsFor`, `mayReadRuns`).
      if (record !== undefined && !enterable.has(record.id))
        return sealedRow(repo, user);
      const production = productions.get(repo.id);
      const latest = latestRuns.get(repo.id);
      // A run still in flight is the thing that is moving, and outranks a
      // change sitting open; once nothing is moving, an open change — an
      // agent's or a person's own — outranks the quiet of the last run's
      // history.
      const runIsMoving = latest !== undefined && !isTerminal(latest.state);
      const openPull = openPulls.get(repo.id);
      const useOpenPull = openPull !== undefined && !runIsMoving;
      const wordCtx: WordCtx = {
        db,
        dir: repoDir(ctx.app.reposRoot, repo.ownerName, repo.name),
        runtime,
        record,
        history,
        viewer: ctx.auth.user,
      };
      const agentWord =
        useOpenPull || latest === undefined
          ? undefined
          : await runWord(wordCtx, latest);
      const agentAt =
        latest === undefined
          ? undefined
          : (latest.finishedAt ?? latest.createdAt);
      const deployFact =
        useOpenPull || runIsMoving ? undefined : productionFacts.get(repo.id);
      // Production's fact only displaces the run's own word when the run's
      // word is not already *shipped* — a change stays credited to whoever's
      // history carries it, never double-told as the deploy behind it — or
      // when it is a failure at least as new: #200's case outranks a stale
      // *shipped* the same way a fresher one would.
      const useDeployFact =
        deployFact !== undefined &&
        (agentWord === undefined ||
          deployFact.word === "stopped" ||
          agentWord.word !== "shipped") &&
        (agentAt === undefined || deployFact.at >= agentAt);
      const word = useOpenPull
        ? await pullWord(wordCtx, openPull)
        : useDeployFact
          ? { word: deployFact!.word, note: deployFact!.note }
          : agentWord;
      const who = useOpenPull
        ? ownerFacts.has(repo.id)
          ? openPull.authorName
          : undefined
        : useDeployFact
          ? deployFact!.actorId == null || !ownerFacts.has(repo.id)
            ? undefined
            : actors.get(deployFact!.actorId)?.username
          : latest?.actorId == null || !ownerFacts.has(repo.id)
            ? undefined
            : actors.get(latest.actorId)?.username;
      // The badge is production's own word (`envPhrase`) — whether a newer
      // push failed behind what is serving is a fact of the environment, not
      // of the run or change history `happening` reads (#191's own word for
      // that stays put; this is the other half of the row, decided once here
      // rather than folded into a second vocabulary). The tone rides with it:
      // `envTone` only knows the runtime's raw state, which still reads
      // "success" while an older deploy answers for a push that failed behind
      // it — this row is not untroubled green just because `envTone` cannot
      // see that fact.
      const live = envPhrase(production);
      const tone =
        production?.failedDeploy !== undefined
          ? "attn"
          : envTone(production?.state);
      // Telling the crew something is a writer's move — a reader who can only
      // see this app is never invited to it, the same floor `ownerFacts` holds
      // for who worked and what it cost.
      const canTell = ownerFacts.has(repo.id);
      const happening =
        word === undefined
          ? stuck.has(repo.id)
            ? html`<span class="muted"
                >open — ${NOBODY_ON_CREW} to take it</span
              >`
            : canTell
              ? html`<span class="muted">quiet — tell the crew something</span>`
              : html`<span class="muted">quiet</span>`
          : html`<strong data-word="${word.word}">${word.word}</strong>
              ${who ? html`· ${who}` : null}
              ${word.word === "working"
                ? html`· now`
                : useOpenPull
                  ? html`· ${time(openPull.updatedAt)}`
                  : useDeployFact
                    ? html`· ${time(deployFact!.at)}`
                    : html`· ${time(latest!.finishedAt ?? latest!.createdAt)}`}`;
      // Two apps can share a bare name across owners — a row for one that is
      // not the viewer's own names its owner, everywhere a row can appear.
      const mine = user !== undefined && repo.ownerId === user.id;
      const title = mine
        ? repo.name
        : html`<span class="muted">${repo.ownerName}/</span>${repo.name}`;
      const first = reads.firstPreview?.get(repo.id);
      const under = reads.under?.get(repo.id);
      return row({
        ...(under === undefined ? {} : { children: [under] }),
        href: repoBase(repo),
        nav: true,
        lead: dot(tone),
        title,
        titleAttr: repo.description || repo.name,
        // The word leads and the description follows, so the meta line's one
        // ellipsis falls on the description (whole in the title), never the word.
        meta: html`${happening}${first === undefined
          ? null
          : html` · first preview ${spanWords(first)}`}${repo.description
          ? html` · ${repo.description}`
          : null}`,
        trail: raw(
          `\n        <span class="badge" data-tone="${tone}">${escapeHtml(live.word)}</span>`,
        ),
      });
    }),
  );
  lap("rows");
  return rows;
}
