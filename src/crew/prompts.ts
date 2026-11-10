/**
 * The prompt routine: once a day, for every repository that asked, the top
 * comment on the account's latest Reel becomes the crew's next tell
 * (docs/APPS.md, "Prompts from Instagram").
 *
 * Every minute the clock is compared with each source's hour; a source
 * whose hour has passed and that has not run today runs. A run reads the
 * latest Reel, takes its most-liked comment, and tells the crew as a
 * person would from the studio box — `tell` opens the issue and routes
 * it. Nothing is invented: no Reel, no new Reel, or no comment yet is a
 * sentence on the settings page and another look tomorrow. One source runs
 * at a time, `Fetch now` included, and a run that fails is a sentence too,
 * never a throw into the timer.
 */

import type { App } from "../app.ts";
import { tell } from "../actions/tell.ts";
import {
  duePromptSources,
  getPromptSource,
  openPromptToken,
  recordPromptRun,
  setPromptAccount,
  storePromptToken,
  type PromptSource,
  claimPromptRun,
} from "../core/prompts.ts";
import { getRepoById } from "../core/repos.ts";
import { getUserById } from "../core/users.ts";
import { createLog, redactSecrets } from "../kernel/log.ts";
import {
  instagramSaid,
  topComment,
  type Comment,
  type InstagramClient,
  type Reel,
} from "./instagram.ts";
import { during } from "../perf/jobs.ts";

const log = createLog("prompts");

/** How often the clock is looked at. */
/** How long a shutdown waits for a run in flight before going on without it. */
const STOP_DEADLINE_MS = 15_000;
const TICK_MS = 60_000;

/**
 * A long-lived token lives sixty days and may be refreshed once it is a day
 * old; at fifty the forge refreshes it, leaving a ten-day margin for a
 * forge that is down.
 */
export const REFRESH_AFTER_DAYS = 50;
const DAY_MS = 24 * 3_600_000;

export interface PromptRoutineOptions {
  readonly client: InstagramClient;
  /** The clock, for tests. @default the wall clock */
  readonly now?: (() => Date) | undefined;
  /** @default a minute */
  readonly everyMs?: number | undefined;
  /** How long `stop()` waits for a run in flight. */
  readonly stopDeadlineMs?: number | undefined;
}

export interface PromptRoutineHandle {
  /** Stop the clock; a run in flight finishes first. */
  readonly stop: () => Promise<void>;
  /** Run every source whose hour has come and that has not run today. */
  readonly runDue: (now?: Date) => Promise<void>;
  /** Run one source now, whatever the hour; the source after, or nothing for an unknown id. */
  readonly runNow: (sourceId: string) => Promise<PromptSource | undefined>;
}

const handles = new WeakMap<App, PromptRoutineHandle>();

/** The routine of this forge, if one was started. */
export const promptsFor = (app: App): PromptRoutineHandle | undefined =>
  handles.get(app);

export function startPromptRoutine(
  app: App,
  options: PromptRoutineOptions,
): PromptRoutineHandle {
  const now = options.now ?? (() => new Date());
  let stopped = false;
  // One source at a time: the due sweep and a `Fetch now` join the same
  // line, so a run never overlaps another on the same row.
  let line: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = line.then(work);
    line = next.catch(() => undefined);
    return next;
  };

  const runDue = (at = now()): Promise<void> =>
    enqueue(async () => {
      for (const source of duePromptSources(app.db, at)) {
        if (stopped) return;
        await runSource(app, options.client, source, at);
      }
    });

  const timer = setInterval(() => {
    if (stopped) return;
    during("prompts", runDue).catch((error) =>
      log.error("prompt sweep failed", { error: String(error) }),
    );
  }, options.everyMs ?? TICK_MS);

  const handle: PromptRoutineHandle = {
    runDue,
    runNow: (sourceId) =>
      enqueue(async () => {
        const source = getPromptSource(app.db, sourceId);
        if (source === undefined) return undefined;
        return runSource(app, options.client, source, now(), true);
      }),
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      // A run in flight is waited for, but not forever: shutdown has its
      // own patience, and Instagram is not allowed to spend it.
      await Promise.race([
        line,
        Bun.sleep(options.stopDeadlineMs ?? STOP_DEADLINE_MS),
      ]);
      if (handles.get(app) === handle) handles.delete(app);
    },
  };
  handles.set(app, handle);
  return handle;
}

/** The likes, in words. */
const likes = (n: number): string => (n === 1 ? "1 like" : `${n} likes`);

/** The Reel's day, as `YYYY-MM-DD`, from Instagram's timestamp. */
const dayOf = (reel: Reel): string => reel.timestamp.slice(0, 10);

/** What the settings page shows of a told comment: its first line, shortly. */
function shortly(text: string): string {
  const line = text.trim().split(/\n/)[0]!.trim();
  return line.length <= 60 ? line : `${line.slice(0, 60).trimEnd()}…`;
}

/**
 * The tell, as the crew reads it: the comment itself first — `tell`
 * makes its first line the title — and where it came from beneath.
 */
export function tellText(reel: Reel, comment: Comment): string {
  return `${comment.text.trim()}\n\nFrom Instagram: the top comment (${likes(comment.likeCount)}) by @${comment.username} on the Reel of ${dayOf(reel)}. ${reel.permalink}`.trim();
}

/**
 * One run of one source. Every exit is a sentence recorded on the row; the
 * media id is recorded only when the Reel was told, so a Reel that has no
 * comments yet is looked at again tomorrow.
 */
async function runSource(
  app: App,
  client: InstagramClient,
  source: PromptSource,
  now: Date,
  /** A person's "Fetch now" runs whatever the day; the sweep does not. */
  force = false,
): Promise<PromptSource | undefined> {
  // Every token this run has held. A sentence about an error may quote a
  // request, and a request carries the token: nothing recorded — and so
  // nothing listed or shown — may hold it, or anything shaped like one.
  const tokens: string[] = [];
  const clean = (said: string): string =>
    redactSecrets(
      tokens.reduce((text, t) => (t === "" ? text : text.split(t).join("[token]")), said),
    );
  const record = (run: {
    said: string;
    mediaId?: string;
    issueNumber?: number;
  }) => recordPromptRun(app.db, source.id, { ...run, said: clean(run.said), now });
  // The row is claimed before any network work: two forges over one data
  // directory, or two ticks over one row, must not tell the crew twice.
  if (!claimPromptRun(app.db, source.id, now, { force })) return undefined;
  try {
    const opened = openPromptToken(app.db, app.config.dataDir, source.id);
    if (!opened.ok)
      return record({
        said:
          opened.error === "not_found"
            ? "The source is gone."
            : "The token would not open; connect the account again.",
      });
    let token = opened.value;
    tokens.push(token);

    if (
      now.getTime() - Date.parse(source.tokenRefreshedAt) >
      REFRESH_AFTER_DAYS * DAY_MS
    ) {
      const fresh = await client.refresh(token);
      storePromptToken(app.db, app.config.dataDir, source.id, fresh.token, now);
      token = fresh.token;
      tokens.push(token);
    }

    if (source.account === "") {
      const me = await client.me(token);
      if (me.username !== "") setPromptAccount(app.db, source.id, me.username);
    }

    const reel = await client.latestReel(token);
    if (reel === undefined) return record({ said: "No Reel yet." });
    if (reel.id === source.lastMediaId)
      return record({
        said:
          source.lastIssueNumber === null
            ? `No new Reel since ${dayOf(reel)}.`
            : `No new Reel since ${dayOf(reel)}; the last one was told as #${source.lastIssueNumber}.`,
      });

    const top = topComment(await client.comments(token, reel.id));
    if (top === undefined)
      return record({ said: "The latest Reel has no comments yet." });

    const repo = getRepoById(app.db, source.repoId);
    if (repo === undefined) return record({ said: "The repository is gone." });
    const creator =
      source.createdBy === null
        ? undefined
        : getUserById(app.db, source.createdBy);
    const told = await tell(app, creator, repo, tellText(reel, top));
    if (!told.ok)
      return record({
        said:
          told.error === "unauthorized"
            ? "The person who connected the account is gone; connect it again."
            : told.error === "unverified"
              ? "The person who connected the account has not verified their email yet."
              : `The crew could not be told (${told.error}).`,
      });

    const number = told.value.issue.number;
    app.bus.append({
      kind: "prompt.told",
      repoId: repo.id,
      payload: {
        source: source.id,
        kind: source.kind,
        mediaId: reel.id,
        commentId: top.id,
        issue: number,
      },
    });
    const who = `"${shortly(top.text)}" — @${top.username}, ${likes(top.likeCount)}`;
    return record({
      // Honest about who heard it: an issue opens with nobody to route it
      // to when the crew is empty, and that is not "told the crew".
      said:
        told.value.routed === undefined
          ? `Opened #${number}: ${who}; nobody on the crew to take it yet.`
          : `Told the crew #${number}: ${who}.`,
      mediaId: reel.id,
      issueNumber: number,
    });
  } catch (error) {
    log.warn("prompt run failed", { source: source.id, error: String(error) });
    return record({ said: instagramSaid(error) });
  }
}
