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

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../app.ts";
import { createOrg } from "../core/orgs.ts";
import type { Ctx } from "../http/context.ts";
import type { Issue } from "../core/issues.ts";
import { getRepo, type Repo } from "../core/repos.ts";
import { pinPanel } from "../actions/board-pins.ts";
import { writeBoard } from "../actions/boards.ts";
import { backBet } from "../actions/bets.ts";
import { openIssue, setIssueState } from "../actions/issues.ts";
import { pinBuild } from "../actions/builds.ts";
import { addReview, mergePull, openPull } from "../actions/pulls.ts";
import { commitToBranch, createRepo, forkRepo } from "../actions/repos.ts";
import { reviewGate } from "../actions/gate_review.ts";
import { forgeHttp } from "../http/server.ts";
import { transferRepository } from "../actions/transfer.ts";
import { linkIssue } from "../actions/dependencies.ts";
import { createApp as createAppRecord } from "../core/apps.ts";
import { studioApp } from "../web/studio/app.ts";
import { THEMES_AT_REST } from "../web/pages/gate.ts";
import { iterationsOf } from "../core/iterations.ts";
import { turnValveFor } from "../actions/valves.ts";
import { insertBet } from "../core/bets.ts";
import { addDependency } from "../core/dependencies.ts";
import { claimRun, createPullRun, createRun, finishRun } from "../core/runs.ts";
import { setMember } from "../core/roles.ts";
import { noteLimit } from "../core/standing.ts";
import { addSubscription, listSubscriptions } from "../core/subscriptions.ts";
import { createAgent } from "../actions/crew.ts";
import { getAgentByName } from "../core/agents.ts";
import { createSession, destroySession } from "../core/sessions.ts";
import { createToken, listTokens } from "../core/tokens.ts";
import { recordUsage } from "../core/usage.ts";
import { PREVIEW_SEEDED, getUserSetting, setUserSetting } from "../core/settings.ts";
import { createUser, getUserByName, type User } from "../core/users.ts";
import { diskSummary, recordReading } from "../machines/disk_readings.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { PREVIEW_CONFIG_FILES } from "./preview-config.ts";
import {
  PREVIEW_ADMIN,
  PREVIEW_APP,
  PREVIEW_APP_PAGE,
  PREVIEW_DISK_ALERT,
  PREVIEW_FORKS,
  PREVIEW_HELD_PAGE,
  PREVIEW_HELD_THEMES,
  PREVIEW_ITERATIONS_PAGE,
  PREVIEW_MACHINES_PAGE,
  PREVIEW_PULL,
  PREVIEW_PULL_PAGE,
  PREVIEW_MOVED,
  PREVIEW_MOVED_OWNER,
  PREVIEW_MOVED_PAGE,
  PREVIEW_MOVE_PAGE,
  PREVIEW_NEWCOMER,
  PREVIEW_NEWCOMER_ORG,
  PREVIEW_REPO,
  PREVIEW_SETTINGS_PAGES,
} from "./preview-looks.ts";

export {
  PREVIEW_ADMIN,
  PREVIEW_APP,
  PREVIEW_APP_PAGE,
  PREVIEW_FORKS,
  PREVIEW_HELD_PAGE,
  PREVIEW_HELD_THEMES,
  PREVIEW_ITERATIONS_PAGE,
  PREVIEW_MOVED_PAGE,
  PREVIEW_OWNER_LOOKS,
  PREVIEW_PULL,
  PREVIEW_PULL_PAGE,
  PREVIEW_REPO,
  PREVIEW_REPO_HOME,
} from "./preview-looks.ts";

/**
 * A repository moved just now, through the action a person uses (#10195):
 * its head draws "Moved from <old path> on <date>". Refused unless that page
 * answers 200 and holds the line, in the first-paint HTML.
 */
async function seedMoved(app: App, admin: User): Promise<Result<void, string>> {
  const made = await createRepo(app, admin, { name: PREVIEW_MOVED, visibility: "public", description: "A repository that moved" });
  if (!made.ok) return err(`the moved repository: ${String(made.error)}`);
  const first = await commitToBranch(app, admin, made.value, {
    message: "Start",
    files: [{ path: "README.md", content: "# moved\n\nA repository that changed owner.\n" }],
  });
  if (!first.ok) return err(`the moved repository's commit: ${JSON.stringify(first.error)}`);
  const moved = await transferRepository(app, admin, made.value, PREVIEW_MOVED_OWNER);
  if (!moved.ok) return err(`the move: ${String(moved.error)}`);
  const http = forgeHttp(app);
  const session = createSession(app.db, admin.id);
  try {
    const res = await http.handle(
      new Request(`http://localhost${PREVIEW_MOVED_PAGE}`, { headers: { cookie: `forge_session=${session.token}` } }),
    );
    if (res.status !== 200) return err(`${PREVIEW_MOVED_PAGE} answers ${String(res.status)}, not 200`);
    if (!(await res.text()).includes("moved-from")) return err(`${PREVIEW_MOVED_PAGE} holds no moved-from line`);
  } finally {
    destroySession(app.db, session.token);
    http.close();
  }
  return ok();
}

/**
 * The sample's Settings, asked for as the admin through `ask`, must answer
 * 200 and hold `id="move"`: the section its phone look scrolls to (#10194).
 * `ask` is the forge's own handler; a test hands in one that answers otherwise.
 */
export async function checkMoveSection(
  ask: (path: string) => Promise<{ readonly status: number; text(): Promise<string> }>,
): Promise<Result<void, string>> {
  const res = await ask(PREVIEW_MOVE_PAGE);
  if (res.status !== 200) return err(`${PREVIEW_MOVE_PAGE} answers ${String(res.status)}, not 200`);
  if (!(await res.text()).includes('id="move"')) return err(`${PREVIEW_MOVE_PAGE} holds no id="move"`);
  return ok();
}

async function seedMoveSection(app: App, admin: User): Promise<Result<void, string>> {
  const http = forgeHttp(app);
  const session = createSession(app.db, admin.id);
  try {
    return await checkMoveSection((path) =>
      http.handle(new Request(`http://localhost${path}`, { headers: { cookie: `forge_session=${session.token}` } })),
    );
  } finally {
    destroySession(app.db, session.token);
    http.close();
  }
}

/** One NVMe reading in smartctl's JSON shape (`smartctl -j -a`), as a host files it. */
function nvmeReading(o: { name: string; units: number; spare: number; used: number }): string {
  return JSON.stringify({
    smartctl: { version: [7, 4] },
    device: { name: o.name, type: "nvme", protocol: "NVMe" },
    model_name: "Samsung SSD 980 PRO 1TB",
    firmware_version: "5B2QGXA7",
    user_capacity: { bytes: 1_000_204_886_016 },
    nvme_smart_health_information_log: {
      critical_warning: 0, temperature: 41, available_spare: o.spare, available_spare_threshold: 10,
      percentage_used: o.used, data_units_written: o.units, media_errors: 0, power_on_hours: 1234,
      unsafe_shutdowns: 7, warning_temp_time: 3, critical_comp_time: 0,
    },
  });
}

/**
 * Disk readings for the sample's `standard` machine (#10466), once: a healthy
 * disk, one that needs a look (spare under its threshold, wear at 85%), and
 * one behind a controller. Fake numbers in a preview only, so the owner's
 * look of Settings › Machines has every kind of line. Refused unless the page
 * answers 200 and draws the alerting line.
 */
async function seedDisks(app: App, admin: User): Promise<Result<void, string>> {
  if (diskSummary(app.db, "standard").devices.length === 0) {
    const now = Date.now();
    // 1e8 units × 512 000 B = 51.2 TB of the 980 PRO's 600 TBW.
    const filed = [
      recordReading(app.db, "standard", "nvme0", nvmeReading({ name: "/dev/nvme0", units: 100_000_000, spare: 100, used: 4 }), now),
      recordReading(app.db, "standard", PREVIEW_DISK_ALERT, nvmeReading({ name: "/dev/nvme1", units: 1_000_000_000, spare: 5, used: 85 }), now),
      recordReading(app.db, "standard", "sda", JSON.stringify({ smartctl: { version: [7, 4] }, device: { name: "/dev/sda", type: "megaraid,0" } }), now),
    ];
    const refused = filed.find((r) => !r.ok);
    if (refused !== undefined && !refused.ok) return err(`the sample disk readings: ${refused.reason}`);
  }
  const http = forgeHttp(app);
  const session = createSession(app.db, admin.id);
  try {
    const res = await http.handle(
      new Request(`http://localhost${PREVIEW_MACHINES_PAGE}`, { headers: { cookie: `forge_session=${session.token}` } }),
    );
    if (res.status !== 200) return err(`${PREVIEW_MACHINES_PAGE} answers ${String(res.status)}, not 200`);
    if (!(await res.text()).includes(`data-disk="${PREVIEW_DISK_ALERT}"`)) return err(`${PREVIEW_MACHINES_PAGE} draws no disk line`);
  } finally {
    destroySession(app.db, session.token);
    http.close();
  }
  return ok();
}

/** The seeded wave's version and headline, which the owner's /waves look shows. */
export const PREVIEW_WAVE = "0.1.0";
export const PREVIEW_WAVE_HEADLINE = "The sample says hello";
/**
 * The title of the seeded pull that lands, so /changelog has a day of rows
 * to look at: long, with one unbroken word, the case a 390 px phone must
 * wrap rather than scroll (#9349).
 */
export const PREVIEW_LANDING_TITLE = `The changelog wraps a long landing title on a phone ${"L".repeat(120)} and the words after it`;
/** The board whose panels are pinned to home. */
const PREVIEW_BOARD = "preview";
const PREVIEW_AGENT = "preview-agent";
const PREVIEW_TOKEN = "preview fake token, not a credential";
const SEEDED = PREVIEW_SEEDED;
const CONFIG_SEEDED = "preview_config_seeded";
const SETTINGS_SEEDED = "preview_settings_seeded";

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

/** The newcomer, when this forge has one. */
export function previewNewcomer(app: App): User | undefined {
  const user = getUserByName(app.db, PREVIEW_NEWCOMER);
  return user?.isAdmin === true && user.kind === "user" ? user : undefined;
}

/**
 * The person of a spawned forge who has claimed it and told the crew nothing
 * (#11285): the preview is given a `parent.json` naming a seeded organisation,
 * so it reads as spawned, and an admin who has made no tell. Their home is
 * then the first-login card at "What do you want built?". Idempotent; only a
 * preview reaches it (`seedPreview` refuses anything else). The refusal says
 * what the page lacked.
 */
async function seedNewcomer(app: App): Promise<Result<void, string>> {
  let created = false;
  let person = getUserByName(app.db, PREVIEW_NEWCOMER);
  if (person === undefined) {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      isAdmin: true,
      allowReserved: true,
      username: PREVIEW_NEWCOMER,
      email: `${PREVIEW_NEWCOMER}@preview.invalid`,
    });
    if (!made.ok) return err(`the preview newcomer: ${made.error}`);
    person = made.value;
    created = true;
  }
  if (!person.isAdmin || person.kind !== "user") return err("the preview newcomer's name is someone else's");
  if (getUserByName(app.db, PREVIEW_NEWCOMER_ORG) === undefined) {
    const org = createOrg(app.db, PREVIEW_NEWCOMER_ORG, person.id, { allowReserved: true });
    if (!org.ok) return err(`the preview newcomer's organisation: ${org.error}`);
    created = true;
  }
  const file = join(app.config.dataDir, "parent.json");
  if (!existsSync(file)) {
    await Bun.write(file, JSON.stringify({ org: PREVIEW_NEWCOMER_ORG }));
    created = true;
  }
  // The self-check builds a whole server: only when the newcomer was just made.
  if (!created) return ok(undefined);
  const http = forgeHttp(app);
  const session = createSession(app.db, person.id);
  try {
    const res = await http.handle(new Request("http://localhost/", { headers: { cookie: `forge_session=${session.token}` } }));
    return checkFirstTell(res.status, await res.text());
  } finally {
    destroySession(app.db, session.token);
    http.close();
  }
}

/** Whether a newcomer's home answered 200 with the one box and no passkey form above it. */
export function checkFirstTell(status: number, body: string): Result<void, string> {
  if (status !== 200) return err(`the newcomer's home answered ${String(status)}`);
  const box = body.indexOf("What do you want built?");
  if (box < 0) return err("the newcomer's home lacks \"What do you want built?\"");
  const passkey = body.search(/passkey/i);
  if (passkey >= 0 && passkey < box) return err("the newcomer's home has a passkey form above the box");
  return ok(undefined);
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
    const settings = await seedSettingsPages(app, admin);
    if (!settings.ok) return settings;
    const moveSection = await seedMoveSection(app, admin);
    if (!moveSection.ok) return moveSection;
    const disks = await seedDisks(app, admin);
    if (!disks.ok) return disks;
    const files = await seedConfigFiles(app, admin);
    if (!files.ok) return files;
    const newcomer = await seedNewcomer(app);
    return newcomer.ok ? ok({ seeded: false }) : newcomer;
  }
  const world = await seedWorld(app, admin);
  if (!world.ok) return world;
  setUserSetting(app.db, admin.id, SEEDED, new Date().toISOString());
  const settings = await seedSettingsPages(app, admin);
  if (!settings.ok) return settings;
  const moveSection = await seedMoveSection(app, admin);
  if (!moveSection.ok) return moveSection;
  const disks = await seedDisks(app, admin);
  if (!disks.ok) return disks;
  const files = await seedConfigFiles(app, admin);
  if (!files.ok) return files;
  const newcomer = await seedNewcomer(app);
  return newcomer.ok ? ok({ seeded: true }) : newcomer;
}

/**
 * Something on each settings page the owner looks at (#9781), once: a token
 * whose value is plainly fake (the page shows its name, never its secret),
 * an agent for the crew, and a subscription if none was seeded. Then each
 * page is asked for as the admin, and any answer but 200 refuses the seed.
 */
async function seedSettingsPages(app: App, admin: User): Promise<Result<void, string>> {
  if (getUserSetting(app.db, admin.id, SETTINGS_SEEDED) !== undefined) return ok(undefined);
  // Guarded like the agent and the subscription: a refused seed retries on the next boot and adds no second token.
  if (!listTokens(app.db, admin.id).some((t) => t.name === PREVIEW_TOKEN))
    createToken(app.db, admin.id, PREVIEW_TOKEN, "ro");
  if (getAgentByName(app.db, PREVIEW_AGENT) === undefined) {
    const made = await createAgent(app, admin, {
      username: PREVIEW_AGENT,
      displayName: "Preview agent",
      brief: "A seeded crew member, to give the crew page a row.",
      roles: ["builder"],
    });
    if (!made.ok) return err(`the preview agent: ${String(made.error)}`);
  }
  if (listSubscriptions(app.db).length === 0) {
    const added = addSubscription(app.db, app.config.dataDir, {
      name: "preview sample",
      token: "sk-ant-oat01-preview-sample-not-a-credential",
    });
    if (!added.ok) return err(`the sample account: ${added.error}`);
  }
  const http = forgeHttp(app);
  const session = createSession(app.db, admin.id);
  try {
    for (const path of PREVIEW_SETTINGS_PAGES) {
      const res = await http.handle(
        new Request(`http://localhost${path}`, { headers: { cookie: `forge_session=${session.token}` } }),
      );
      if (res.status !== 200) return err(`${path} answers ${String(res.status)}, not 200`);
    }
  } finally {
    destroySession(app.db, session.token);
    http.close();
  }
  setUserSetting(app.db, admin.id, SETTINGS_SEEDED, new Date().toISOString());
  return ok(undefined);
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
    // Closes the first issue, so its page draws a Closes with row.
    body: `Adds a greeting.\n\nCloses #${String(milestone!.number)}`,
    baseBranch: repo.value.defaultBranch,
    headBranch: "greeting",
  });
  if (!pull.ok) return err(`the pull: ${String(pull.error)}`);
  if (pull.value.number !== PREVIEW_PULL) return err(`the pull is #${String(pull.value.number)}, not #${String(PREVIEW_PULL)}`);

  // A review comment on a line of the pull's diff, so its Files tab draws one (#10073).
  const reviewed = await addReview(app, admin, repo.value, pull.value, {
    body: `Say hello to the whole forge, not only to the one who reads this line. ${"A long unbroken word follows: " + "x".repeat(80)}`,
    path: "GREETING.md",
    line: 1,
    side: "new",
  });
  if (!reviewed.ok) return err(`the line comment: ${String(reviewed.error)}`);

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

  // One finished agent run on the first issue, so its page draws a Runs row.
  // Recorded only: createRun/claimRun/finishRun start no agent and spend nothing.
  const recorded = createRun(app.db, {
    repoId: repo.value.id,
    kind: "agent",
    issueId: milestone!.id,
    actorId: admin.id,
    reason: "seed",
  });
  claimRun(app.db, recorded.id);
  finishRun(app.db, recorded.id, { state: "ok", summary: "A seeded run", costUsd: 0 });

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
  // Before the forks, so the merge moves no fork; after the numbered issues, so they keep their numbers.
  const landed = await seedLanding(app, admin, repo.value);
  if (!landed.ok) return landed;
  const family = await seedForkFamily(app, admin, repo.value, start.value.commitOid);
  if (!family.ok) return family;
  const gated = seedLaterGate(app, admin, repo.value);
  if (!gated.ok) return gated;
  const hosted = await seedApp(app, admin);
  if (!hosted.ok) return hosted;
  const moved = await seedMoved(app, admin);
  if (!moved.ok) return moved;
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

/** One pull merged into the sample's default branch: a landing for /changelog (#9349). */
async function seedLanding(app: App, admin: User, repo: Repo): Promise<Result<void, string>> {
  const branch = await commitToBranch(app, admin, repo, {
    branch: "landed",
    base: repo.defaultBranch,
    message: "Land a note",
    files: [{ path: "LANDED.md", content: "Landed.\n" }],
  });
  if (!branch.ok) return err(`the landing's branch: ${JSON.stringify(branch.error)}`);
  const pull = await openPull(app, admin, repo, {
    title: PREVIEW_LANDING_TITLE,
    body: "Merged by the preview seed.",
    baseBranch: repo.defaultBranch,
    headBranch: "landed",
  });
  if (!pull.ok) return err(`the landing: ${String(pull.error)}`);
  const merged = await mergePull(app, admin, repo, pull.value, "merge", undefined, { pastGate: true });
  if (!merged.ok) return err(`the landing's merge: ${String(merged.error)}`);
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
  const url = `https://preview.invalid${PREVIEW_PULL_PAGE}`;
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
  const bet = (name: string, from: number, journeys = "Someone can see it") =>
    insertBet(
      app.db,
      {
        repoId: repo.id,
        name,
        journeys,
        appetite: 20,
        leadId: null,
        issueIds: open.slice(from, from + 2).map((i) => i.id),
      },
      new Date(),
    );
  const backed = bet("Show the week", 2);
  bet("Price the list", 4);
  // The worst case for the phone: a long name, an unbroken word, more journeys than fit at rest (#8970).
  bet(
    "Make every long and winding bet name wrap instead of pushing the page sideways",
    0,
    ["Someone opens https://example.com/a/very/long/unbroken/address/that/has/no/spaces/at/all/anywhere", "Second journey", "Third journey", "Fourth journey", "Fifth journey"].join("\n"),
  );
  const result = backBet(app, admin, repo, backed.id, 20);
  return result.ok ? ok() : err(`backing a bet: ${result.error.message}`);
}

/**
 * The fork family the Iterations page draws: the sample pinned at its first
 * commit, three forks of it and a fork of the first, each with a commit of
 * its own (so ahead/behind is not zero) and a pin on it. Refused when the
 * page would still be a 404 or would draw fewer cards than forks.
 */
async function seedForkFamily(app: App, admin: User, repo: Repo, first: string): Promise<Result<void, string>> {
  const pinned = await pinBuild(app, admin, repo, { label: "v1", oid: first, note: "The sample, as started" });
  if (!pinned.ok) return err(`the sample's pin: ${JSON.stringify(pinned.error)}`);
  const made = new Map<string, Repo>();
  for (const { owner, of } of PREVIEW_FORKS) {
    const parent = of === undefined ? repo : made.get(of);
    if (parent === undefined) return err(`the fork of ${owner} comes before ${String(of)}'s`);
    const person = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      allowReserved: true,
      username: owner,
      email: `${owner}@preview.invalid`,
    });
    if (!person.ok) return err(`the fork's owner ${owner}: ${person.error}`);
    setMember(app.db, person.value.id, true, admin.id, new Date());
    const fork = await forkRepo(app, person.value, parent, PREVIEW_REPO, { visibility: "public" });
    if (!fork.ok) return err(`the fork of ${owner}: ${String(fork.error)}`);
    made.set(owner, fork.value);
    const commit = await commitToBranch(app, person.value, fork.value, {
      message: `${owner} goes its own way`,
      files: [{ path: `${owner}.md`, content: `# ${owner}\n\nA change of its own.\n` }],
    });
    if (!commit.ok) return err(`the commit of ${owner}: ${JSON.stringify(commit.error)}`);
    const pin = await pinBuild(app, person.value, fork.value, { label: `${owner}-try-1`, oid: commit.value.commitOid, note: `${owner}, first try` });
    if (!pin.ok) return err(`the pin of ${owner}: ${JSON.stringify(pin.error)}`);
  }
  const home = getRepo(app.db, admin.username, PREVIEW_REPO);
  const drawn = home === undefined ? undefined : await iterationsOf({ app, auth: { user: admin } }, home);
  if (drawn === undefined) return err(`${PREVIEW_ITERATIONS_PAGE} would be a 404`);
  if (drawn.forks.length < PREVIEW_FORKS.length + 1) return err(`${PREVIEW_ITERATIONS_PAGE} draws ${String(drawn.forks.length)} forks`);
  // Each fork hangs under the one it was made from, so the tree cannot flatten.
  for (const { owner, of } of PREVIEW_FORKS) {
    const card = drawn.forks.find((f) => f.repo === `${owner}/${PREVIEW_REPO}`);
    const under = of === undefined ? `${admin.username}/${PREVIEW_REPO}` : `${of}/${PREVIEW_REPO}`;
    if (card?.forkOf !== under) return err(`${PREVIEW_ITERATIONS_PAGE} draws ${owner}/${PREVIEW_REPO} under ${String(card?.forkOf)}, not ${under}`);
  }
  return ok();
}

/**
 * A Later gate holding issues across more themes than the held page draws at
 * rest, so its fold line shows. Made last, so the numbers the other pages
 * name stay where they are. Refused when the page would be a 404 or would
 * not have a theme more than it draws at rest.
 */
function seedLaterGate(app: App, admin: User, repo: Repo): Result<void, string> {
  const gate = openIssue(app, admin, repo, {
    title: "Later gate: nothing behind this starts until the owner opens it",
    body: "Held for later.",
  });
  if (!gate.ok) return err(`the Later gate: ${String(gate.error)}`);
  for (const { titles } of PREVIEW_HELD_THEMES)
    for (const title of titles) {
      const made = openIssue(app, admin, repo, { title, body: "Held behind the gate." });
      if (!made.ok) return err(`a held issue: ${String(made.error)}`);
      const linked = linkIssue(app, admin, repo, made.value, gate.value);
      if (!linked.ok) return err(`holding "${title}": ${JSON.stringify(linked.error)}`);
    }
  const themes = reviewGate(app, repo)?.themes.length ?? 0;
  if (themes <= THEMES_AT_REST)
    return err(`${PREVIEW_HELD_PAGE} shows ${String(themes)} themes, not more than the ${String(THEMES_AT_REST)} drawn at rest`);
  return ok();
}

/**
 * One app, for the app page's look (#9782): a repository and its record,
 * nothing more. No process starts and no network is reached; the page says
 * the app is not running. Refused when the page would answer anything but 200.
 */
async function seedApp(app: App, admin: User): Promise<Result<void, string>> {
  const repo = await createRepo(app, admin, {
    name: PREVIEW_APP,
    visibility: "public",
    description: "A preview's sample app",
  });
  if (!repo.ok) return err(`the sample app's repository: ${String(repo.error)}`);
  const first = await commitToBranch(app, admin, repo.value, {
    message: "Start",
    files: [
      { path: "README.md", content: "# hello\n\nA preview's sample app.\n" },
      { path: "forge.json", content: JSON.stringify({ app: { run: "bun run src/server.ts" }, adapter: { schedule: { every: 900 } } }) },
    ],
  });
  if (!first.ok) return err(`the sample app's commit: ${JSON.stringify(first.error)}`);
  const record = createAppRecord(app.db, { repoId: repo.value.id, slug: PREVIEW_APP, access: "public" });
  if (!record.ok) return err(`the sample app's record: ${record.error}`);
  seedPullRuns(app, record.value.id);
  const url = new URL(`https://preview.invalid${PREVIEW_APP_PAGE}`);
  const answer = await studioApp(
    { app, request: new Request(url.href), url, params: {}, auth: { user: admin }, theme: undefined } as Ctx,
    repo.value,
    record.value,
  );
  return answer.status === 200 ? ok() : err(`${PREVIEW_APP_PAGE} would answer ${String(answer.status)}, not 200`);
}

/** Ten recorded pull runs for the app page's Adapter section (#10158): one failed with a reason of the longest allowed, an unbroken word in it. */
export const PREVIEW_LONG_REASON = `upstream refused the pull: ${"x".repeat(60)} ${"https://api.example.invalid/v2/orders?cursor=".repeat(3)}`.slice(0, 200);
function seedPullRuns(app: App, appId: string): void {
  for (let i = 0; i < 10; i++) {
    const failed = i === 4;
    createPullRun(app.db, {
      appId,
      state: failed ? "failed" : "ok",
      written: failed ? 0 : 12 + i,
      skipped: failed ? 0 : 3,
      failed: 0,
      cursor: failed ? "" : `c${String(i)}`,
      durationMs: 40 + i,
      reason: failed ? PREVIEW_LONG_REASON : "",
      repeat: false,
    });
  }
}
