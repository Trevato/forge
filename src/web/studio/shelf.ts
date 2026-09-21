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
 * the app, not about who typed it; else the last run's own word, its
 * history; else quiet, or told-but-stuck when nobody on the crew can take
 * it.
 */

import { appsRuntime } from "../../apps/runtime.ts";
import { appsForRepos } from "../../core/apps.ts";
import { reposWithBuilder } from "../../core/agents.ts";
import { reposWithUnclaimedTell } from "../../core/issues.ts";
import { openPullsForRepos } from "../../core/pulls.ts";
import { canSeeOwnerFacts, type Repo } from "../../core/repos.ts";
import { isTerminal, latestAgentRunsForRepos } from "../../core/runs.ts";
import { getUsersByIds } from "../../core/users.ts";
import { repoDir } from "../../git/repos.ts";
import type { Ctx } from "../../http/context.ts";
import { repoBase } from "../chrome.ts";
import { html, type Html } from "../html.ts";
import { dot, pill, row, time, type Tone } from "../ui.ts";
import { decisionsFor, type Decision } from "./asks.ts";
import { withLikely } from "./leans.ts";
import { pullWord, runWord, type WordCtx } from "./words.ts";

/** Reads the caller has already made, so the shelf does not make them again. */
export interface ShelfReads {
  /** What asks the viewer across these apps — the asks pill counts them. */
  readonly decisions?: readonly Decision[] | undefined;
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
  const records = appsForRepos(
    db,
    repos.map((r) => r.id),
  );
  // A public app you can only read appears here too, but who is on its
  // crew is its owner's fact, not yours to see — same predicate as the
  // app's own page.
  const ownerFacts = new Set(
    repos.filter((r) => canSeeOwnerFacts(db, r, user)).map((r) => r.id),
  );
  // One read for the newest run of every app, one for who ran them: the
  // shelf must not get slower as the apps grow.
  const latestRuns = latestAgentRunsForRepos(
    db,
    repos.map((r) => r.id),
  );
  const actors = getUsersByIds(
    db,
    [...latestRuns.values()]
      .map((r) => r.actorId)
      .filter((id): id is string => id !== null),
  );
  // The newest open change of every app, one read — a person's own change
  // counts here too, not only one an agent run produced.
  const openPulls = openPullsForRepos(
    db,
    repos.map((r) => r.id),
  );
  const decisions = reads.decisions ?? withLikely(ctx, decisionsFor(ctx, repos));
  const asksByRepo = new Map<string, number>();
  for (const d of decisions)
    asksByRepo.set(d.repo.id, (asksByRepo.get(d.repo.id) ?? 0) + 1);
  // A tell nobody can pick up (no builder on the crew) is stuck, not quiet —
  // both reads batched across the whole shelf, never once per row.
  const repoIds = repos.map((r) => r.id);
  const withBuilder = reposWithBuilder(db, repoIds);
  const stuck = new Set(
    [...reposWithUnclaimedTell(db, repoIds)].filter(
      (id) => !withBuilder.has(id),
    ),
  );

  return await Promise.all(repos.map(async (repo) => {
    const record = records.get(repo.id);
    const envs =
      runtime === undefined || record === undefined
        ? []
        : runtime.status(record);
    const production = envs.find((e) => e.env === "production");
    const state = production?.state ?? "stopped";
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
    };
    const word = useOpenPull
      ? await pullWord(wordCtx, openPull)
      : latest === undefined
        ? undefined
        : await runWord(wordCtx, latest);
    const who = useOpenPull
      ? ownerFacts.has(repo.id)
        ? openPull.authorName
        : undefined
      : latest?.actorId == null || !ownerFacts.has(repo.id)
        ? undefined
        : actors.get(latest.actorId)?.username;
    const asks = asksByRepo.get(repo.id) ?? 0;
    const tone: Tone =
      state === "running"
        ? "success"
        : state === "failed"
          ? "danger"
          : "default";
    const happening =
      word === undefined
        ? stuck.has(repo.id)
          ? html`<span class="muted"
              >told — nobody on the crew to take it</span
            >`
          : html`<span class="muted">quiet — tell the crew something</span>`
        : html`<span class="studio-word" data-word="${word.word}"
              >${word.word}</span
            >
            ${who ? html`· ${who}` : null}
            ${word.word === "working"
              ? html`· now`
              : useOpenPull
                ? html`· ${time(openPull.updatedAt)}`
                : html`· ${time(latest!.finishedAt ?? latest!.createdAt)}`}`;
    return row({
      href: repoBase(repo),
      nav: true,
      lead: dot(tone),
      title: repo.name,
      titleAttr: repo.description || repo.name,
      meta: html`${repo.description
        ? html`${repo.description} · `
        : null}${happening}`,
      trail: html`${asks > 0 ? pill(`${asks} asks you`, "accent") : null}
        <span class="badge" data-tone="${tone}"
          >${state === "running"
            ? "live"
            : state === "stopped"
              ? "not running"
              : state}</span
        >`,
    });
  }));
}
