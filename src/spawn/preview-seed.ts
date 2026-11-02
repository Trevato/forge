/**
 * A preview of the forge, seeded to be looked at (#8812). A preview starts
 * from data with nothing an admin's pages can show, so its looks of home,
 * /flow and /talk were blank. Here, and only in a preview, the forge makes
 * a preview-only site admin and a small world for it: a repository with
 * issues, a pull, a flow week (agent runs that spent) and pins on home.
 * The parent forge's looks are taken signed in as that admin
 * (`spawn/preview-owner.ts`).
 *
 * The environment is the platform's word, `FORGE_APP_ENV` (never the
 * hostname), as for the crew (`crew/preview.ts`): only `preview` seeds,
 * and production refuses. The admin has no password and no session: it is
 * reached only through the parent's signed identity, so there is no secret
 * to show or log. Once: the admin remembers that it was seeded.
 */

import type { App } from "../app.ts";
import type { Issue } from "../core/issues.ts";
import { getRepo, type Repo } from "../core/repos.ts";
import { pinPanel } from "../actions/board-pins.ts";
import { writeBoard } from "../actions/boards.ts";
import { backBet } from "../actions/bets.ts";
import { openIssue, setIssueState } from "../actions/issues.ts";
import { openPull } from "../actions/pulls.ts";
import { commitToBranch, createRepo } from "../actions/repos.ts";
import { turnValveFor } from "../actions/valves.ts";
import { insertBet } from "../core/bets.ts";
import { addDependency } from "../core/dependencies.ts";
import { claimRun, createRun, finishRun } from "../core/runs.ts";
import { noteLimit } from "../core/standing.ts";
import { addSubscription } from "../core/subscriptions.ts";
import { recordUsage } from "../core/usage.ts";
import { getUserSetting, setUserSetting } from "../core/settings.ts";
import { createUser, getUserByName, type User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { PREVIEW_CONFIG_FILES } from "./preview-config.ts";

/** The preview-only site admin's name. */
export const PREVIEW_ADMIN = "preview-admin";
/** The repository the admin's pages are about. */
export const PREVIEW_REPO = "sample";
/**
 * The seeded pull's number: two issues come first and share its count.
 * forge.json `app.looksAsOwner` names its page, so the seed refuses any
 * other number rather than leave that look on a 404.
 */
export const PREVIEW_PULL = 3;
/** The seeded wave's version and headline, which the owner's /waves look shows. */
export const PREVIEW_WAVE = "0.1.0";
export const PREVIEW_WAVE_HEADLINE = "The sample says hello";
/** The board whose panels are pinned to home. */
const PREVIEW_BOARD = "preview";
const SEEDED = "preview_seeded";
const CONFIG_SEEDED = "preview_config_seeded";

type Env = Record<string, string | undefined>;

/** Whether the platform says this forge is a preview. Anything else is not. */
export function isPreviewEnv(env: Env = process.env): boolean {
  return (env.FORGE_APP_ENV ?? "").trim().toLowerCase() === "preview";
}

/** The preview admin, when this forge has one. */
export function previewAdmin(app: App): User | undefined {
  const user = getUserByName(app.db, PREVIEW_ADMIN);
  return user?.isAdmin === true && user.kind !== "agent" ? user : undefined;
}

/**
 * Seed the preview admin and its world, once. Refused (`not_preview`)
 * anywhere the platform has not said `preview`; `seeded` is false when an
 * earlier boot already did it.
 */
export async function seedPreview(
  app: App,
  env: Env = process.env,
): Promise<Result<{ seeded: boolean }, "not_preview" | string>> {
  if (!isPreviewEnv(env)) return err("not_preview");
  let admin = getUserByName(app.db, PREVIEW_ADMIN);
  if (admin === undefined) {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      isAdmin: true,
      allowReserved: true,
      username: PREVIEW_ADMIN,
      email: `${PREVIEW_ADMIN}@preview.invalid`,
    });
    if (!made.ok) return err(`the preview admin: ${made.error}`);
    admin = made.value;
  }
  if (!admin.isAdmin || admin.kind === "agent")
    return err("the preview admin's name is someone else's");
  if (getUserSetting(app.db, admin.id, SEEDED) !== undefined) {
    const files = await seedConfigFiles(app, admin);
    return files.ok ? ok({ seeded: false }) : files;
  }
  const world = await seedWorld(app, admin);
  if (!world.ok) return world;
  setUserSetting(app.db, admin.id, SEEDED, new Date().toISOString());
  const files = await seedConfigFiles(app, admin);
  return files.ok ? ok({ seeded: true }) : files;
}

/**
 * The config files the form is tried on, once: a sample seeded before they
 * existed gets them on its next boot, in a commit of their own.
 */
async function seedConfigFiles(app: App, admin: User): Promise<Result<void, string>> {
  if (getUserSetting(app.db, admin.id, CONFIG_SEEDED) !== undefined) return ok(undefined);
  const repo = getRepo(app.db, admin.username, PREVIEW_REPO);
  if (repo === undefined) return err("the sample repository is gone");
  const added = await commitToBranch(app, admin, repo, {
    message: "Config files to try the form on",
    files: [...PREVIEW_CONFIG_FILES],
  });
  if (!added.ok) return err(`the config files: ${JSON.stringify(added.error)}`);
  setUserSetting(app.db, admin.id, CONFIG_SEEDED, new Date().toISOString());
  return ok(undefined);
}

const panel = (title: string, source: string, groupBy: string) => ({
  title,
  chart: "bar",
  query: { source, aggregate: "count", groupBy },
  w: 1,
  h: 1,
});

/** The repository, its issues and pull, a week of runs, and pins on home. */
async function seedWorld(app: App, admin: User): Promise<Result<void, string>> {
  const repo = await createRepo(app, admin, {
    name: PREVIEW_REPO,
    visibility: "public",
    description: "A preview's sample repository",
  });
  if (!repo.ok) return err(`the sample repository: ${String(repo.error)}`);
  const start = await commitToBranch(app, admin, repo.value, {
    message: "Start",
    files: [{ path: "README.md", content: "# sample\n\nA preview's sample repository.\n" }],
  });
  if (!start.ok) return err(`the first commit: ${JSON.stringify(start.error)}`);
  const branch = await commitToBranch(app, admin, repo.value, {
    branch: "greeting",
    base: repo.value.defaultBranch,
    message: "Say hello",
    files: [{ path: "GREETING.md", content: "Hello.\n" }],
  });
  if (!branch.ok) return err(`the pull's branch: ${JSON.stringify(branch.error)}`);

  const issues = [
    { title: "The home page says hello", body: "A first thing to do." },
    { title: "Pictures of /flow show a week", body: "So a reviewer sees the pipes." },
  ].map((input) => openIssue(app, admin, repo.value, input));
  const failed = issues.find((i) => !i.ok);
  if (failed !== undefined && !failed.ok) return err(`an issue: ${String(failed.error)}`);
  const [milestone, held] = issues.flatMap((i) => (i.ok ? [i.value] : []));
  const pull = await openPull(app, admin, repo.value, {
    title: "Say hello",
    body: "Adds a greeting.",
    baseBranch: repo.value.defaultBranch,
    headBranch: "greeting",
  });
  if (!pull.ok) return err(`the pull: ${String(pull.error)}`);
  if (pull.value.number !== PREVIEW_PULL) return err(`the pull is #${String(pull.value.number)}, not #${String(PREVIEW_PULL)}`);

  // Issues and pulls share one numbering, so the pull above keeps PREVIEW_PULL
  // and the ones /next lists and the bets hold come after it.
  const listed = [
    { title: "Next up shows a cut line", body: "So a reviewer sees what fits the week." },
    { title: "The bets page lists a backed bet", body: "Backed at a share of the week." },
    { title: "A proposed bet waits for a tap", body: "The owner may back it." },
    { title: "Issues carry a price", body: "From what past issues cost." },
    { title: "The week ends on a Sunday", body: "And the list reads as next week below the line." },
  ].map((input) => openIssue(app, admin, repo.value, input));
  const open: Issue[] = [];
  for (const i of listed) {
    if (!i.ok) return err(`an issue: ${String(i.error)}`);
    open.push(i.value);
  }

  // A flow week: agent runs that started and spent this week, and a valve
  // turned part way, so /flow has a pipe to draw and one to turn.
  for (const usd of [0.42, 1.18, 0.75]) {
    const run = createRun(app.db, {
      repoId: repo.value.id,
      kind: "agent",
      actorId: admin.id,
      reason: "seed",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "A seeded run", costUsd: usd });
  }
  const priced = seedPrices(app, admin, repo.value);
  if (!priced.ok) return priced;
  const milestoned = seedMilestone(app, milestone!, [held!, ...priced.value.slice(0, 2)]);
  if (!milestoned.ok) return milestoned;
  const waved = await seedWave(app, admin, repo.value, pull.value.title);
  if (!waved.ok) return waved;
  const bets = seedBets(app, admin, repo.value, open);
  if (!bets.ok) return bets;
  const valve = turnValveFor(app, admin, `${PREVIEW_ADMIN}/${PREVIEW_REPO}`, 60);
  if (!valve.ok) return err(`the valve: ${valve.error}`);

  const board = await writeBoard(app, admin, PREVIEW_BOARD, {
    title: "Preview",
    range: "all",
    refresh: "off",
    panels: [panel("Runs by kind", "runs", "kind"), panel("Runs by state", "runs", "state")],
  });
  if (!board.ok) return err(`the board: ${board.error}`);
  for (const p of board.value.panels) {
    const pinned = await pinPanel(app, admin, PREVIEW_BOARD, p.title);
    if (!pinned.ok) return err(`a pin: ${pinned.error}`);
  }
  return ok();
}

/**
 * Finished issues that cost something, so `weekView` can price the open
 * ones, and a weekly capacity it can cut the list by: an inert account
 * that the provider refused at $8 last week and that has spent a little
 * since. Its token is no credential, only the shape one has, and it is
 * granted to no repository or owner, so `pickSubscription` (which joins
 * on grants) never offers it to a run or a conversation.
 */
function seedPrices(app: App, admin: User, repo: Repo): Result<Issue[], string> {
  const finished: Issue[] = [];
  for (const [at, usd] of [1.5, 2, 2.5, 3].entries()) {
    const made = openIssue(app, admin, repo, {
      title: `Done work ${at + 1}`,
      body: "Finished before this preview.",
    });
    if (!made.ok) return err(`a finished issue: ${String(made.error)}`);
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: made.value.id,
      actorId: admin.id,
      reason: "seed",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "A seeded run", costUsd: usd });
    const closed = setIssueState(app, admin, repo, made.value, "closed", { reason: "done" });
    if (!closed.ok) return err(`closing a finished issue: ${String(closed.error)}`);
    finished.push(made.value);
  }
  const added = addSubscription(app.db, app.config.dataDir, {
    name: "preview sample",
    token: "sk-ant-oat01-preview-sample-not-a-credential",
  });
  if (!added.ok) return err(`the sample account: ${added.error}`);
  const spend = (usd: number, at: Date) => {
    const run = createRun(app.db, { repoId: repo.id, kind: "agent", actorId: admin.id, reason: "seed" });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "A seeded run" });
    recordUsage(app.db, {
      runId: run.id,
      repoId: repo.id,
      issueId: null,
      agentId: null,
      subscriptionId: added.value.id,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: usd,
      wallMs: 1000,
      outcome: "ok",
      at: at.toISOString(),
    });
  };
  const now = Date.now();
  const DAY = 86_400_000;
  spend(8, new Date(now - 4 * DAY));
  noteLimit(app.db, added.value.id, {
    window: "week",
    resetsAt: new Date(now - 3.5 * DAY).toISOString(),
    observedAt: new Date(now - 3.5 * DAY - 3_600_000).toISOString(),
    said: "weekly limit",
  });
  spend(1, new Date(now - DAY));
  return ok(finished);
}

/**
 * One milestone for /milestones: the first issue waits for three others,
 * two finished and one open, so it reads as two of three done.
 */
function seedMilestone(app: App, milestone: Issue, holding: readonly Issue[]): Result<void, string> {
  for (const blocker of holding) {
    const linked = addDependency(app.db, milestone, blocker, undefined);
    if (!linked.ok) return err(`a milestone's dependency: ${linked.error}`);
  }
  return ok();
}

/** The wave for /waves: `waves/<version>.md` on the default branch, naming the seeded pull. */
async function seedWave(app: App, admin: User, repo: Repo, pullTitle: string): Promise<Result<void, string>> {
  const url = `https://preview.invalid/${PREVIEW_ADMIN}/${PREVIEW_REPO}/pulls/${String(PREVIEW_PULL)}`;
  const text = [
    "---",
    `version: ${PREVIEW_WAVE}`,
    `date: ${new Date().toISOString().slice(0, 10)}`,
    `headline: ${PREVIEW_WAVE_HEADLINE}`,
    "---",
    "",
    "## Highlights",
    "",
    "- **A greeting** — So the sample says hello.",
    "- **A week to see** — So /flow has pipes to draw.",
    "- **A plan to read** — So milestones move as issues close.",
    "",
    "## Pulls",
    "",
    `- [#${String(PREVIEW_PULL)} ${pullTitle}](${url})`,
    "",
  ].join("\n");
  const done = await commitToBranch(app, admin, repo, {
    message: `Cut wave ${PREVIEW_WAVE}`,
    files: [{ path: `waves/${PREVIEW_WAVE}.md`, content: text }],
  });
  return done.ok ? ok() : err(`the wave: ${JSON.stringify(done.error)}`);
}

/** One bet backed at 20% of the week and one proposed, over the open issues. */
function seedBets(app: App, admin: User, repo: Repo, open: readonly Issue[]): Result<void, string> {
  const bet = (name: string, from: number) =>
    insertBet(
      app.db,
      {
        repoId: repo.id,
        name,
        journeys: "Someone can see it",
        appetite: 20,
        leadId: null,
        issueIds: open.slice(from, from + 2).map((i) => i.id),
      },
      new Date(),
    );
  const backed = bet("Show the week", 2);
  bet("Price the list", 4);
  const result = backBet(app, admin, repo, backed.id, 20);
  return result.ok ? ok() : err(`backing a bet: ${result.error.message}`);
}
