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
import { pinPanel } from "../actions/board-pins.ts";
import { writeBoard } from "../actions/boards.ts";
import { openIssue } from "../actions/issues.ts";
import { openPull } from "../actions/pulls.ts";
import { commitToBranch, createRepo } from "../actions/repos.ts";
import { turnValveFor } from "../actions/valves.ts";
import { claimRun, createRun, finishRun } from "../core/runs.ts";
import { getUserSetting, setUserSetting } from "../core/settings.ts";
import { createUser, getUserByName, type User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

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
/** The board whose panels are pinned to home. */
const PREVIEW_BOARD = "preview";
const SEEDED = "preview_seeded";

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
  if (getUserSetting(app.db, admin.id, SEEDED) !== undefined)
    return ok({ seeded: false });
  const world = await seedWorld(app, admin);
  if (!world.ok) return world;
  setUserSetting(app.db, admin.id, SEEDED, new Date().toISOString());
  return ok({ seeded: true });
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
  const pull = await openPull(app, admin, repo.value, {
    title: "Say hello",
    body: "Adds a greeting.",
    baseBranch: repo.value.defaultBranch,
    headBranch: "greeting",
  });
  if (!pull.ok) return err(`the pull: ${String(pull.error)}`);
  if (pull.value.number !== PREVIEW_PULL) return err(`the pull is #${String(pull.value.number)}, not #${String(PREVIEW_PULL)}`);

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
