/**
 * The first thing a session shows, a short launcher: your repositories (and,
 * as you type, every repository you can see), what is on you, what is on
 * your machine, and — for a guest — the way in. Enter opens one in the
 * workspace or the review; what happened, and other people's pages, are the
 * web's feed and explorer (#636).
 *
 * A guest is not a degraded user. They get the same list, filtered to what is
 * public by exactly the helpers the web and the API use, plus one extra row
 * telling them how to become someone.
 *
 * Every card here is a **pane**: a thing with a cursor, that `tab` moves
 * between, that `enter` opens from, and that a click lands in. That is the
 * whole of this screen's design.
 */

import { exploreLine, isExploreLine, exploreNote, exploreSuggestion, explorePage, parseExploreQuery, readExploreLine, type ExploreRow } from "../../actions/explore.ts";
import { protectionNotice } from "../../kernel/protection.ts";
import { holdWords, plannerHold } from "../../crew/autonomy.ts";
import { governorSeen } from "../../crew/governed.ts";
import { forgeFlakes, forgeLane, forgeNeeds } from "../../actions/health.ts";
import { ownerWaits, waitLine, withMore } from "../../actions/owner_waits.ts";
import { forgeHealth } from "../../kernel/guard.ts";
import { coveredByVerdict, forgeVerdict, verdictLine } from "../../kernel/guard_verdict.ts";
import { clientAppRows, clientDoings, clientFinished, doingLine, finishedLine } from "../../core/client-apps.ts";
import { nextStepsFor } from "../../core/next-steps.ts";
import { agentsLine } from "../../web/studio/client_home.ts";
import { lastVisit } from "../../core/home_visit.ts";
import { sinceDigest } from "../../web/studio/since.ts";
import { askForSomething } from "./tell.ts";
import { movingLines } from "./moving.ts";
import { pipelineNow } from "../../web/studio/living.ts";
import { askForEveryday, everydayOf, EVERYDAY_WHY, keepAdmin } from "../../core/everyday.ts";
import { mayView } from "../../core/sealed.ts";
import { applyFleetIds, previewFleetIds, undoFleetOp } from "../../actions/fleet.ts";
import { plain } from "./boards.ts";
import { pinRepo, unpinRepo } from "../../actions/origins.ts";
import { getProposal } from "../../core/proposals.ts";
import { getIssueById, listAssignedTo, type Issue } from "../../core/issues.ts";
import { askLinesFor } from "../../web/studio/asks.ts";
import { waitingFor, type WaitingFor } from "../../core/waiting_for.ts";
import { giveBack } from "../../actions/give_back.ts";
import { passReasonOf } from "../../crew/guard.ts";
import { decideAsk, undoDecideAsk } from "../../actions/asks_decide.ts";
import { actOnProposal, type ProposalVerb } from "../../actions/proposals.ts";
import { putAsideWaves } from "../../web/studio/asks.ts";
import type { Proposal } from "../../core/proposals.ts";
import type { App } from "../../app.ts";
import {
  applyAsksBulk,
  BULK_MAX,
  latestUndoable,
  previewAsksBulk,
  undoAsksBulk,
} from "../../actions/asks_bulk.ts";
import { stepLine, stepOfNumber } from "../../flow/path.ts";
import { reviewSetOf, type ReviewSet } from "../../web/studio/review_set.ts";
import { staleWords } from "../../flow/kpi_words.ts";
import { askMeasureWeek, asksMeasureEmpty, asksMeasureWords } from "../../core/ask_ledger.ts";
import { mutedRepos, removeMutes } from "../../core/interactions.ts";
import { chipsOf, KIND_CHIPS, setChip } from "../../core/feed_chips.ts";
import type { Operation } from "../../core/fleet_ops.ts";
import { listPins, pinnedRepoIds, type Pin } from "../../core/pins.ts";
import { listOrgsForUser } from "../../core/orgs.ts";
import {
  canAdmin,
  canRead,
  getRepo,
  getReposByIds,
  listReposVisibleTo,
  withoutArchived,
  type Repo,
  getRepoById,
  ownerFactRepoIds,
} from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Rect, Screen as Surface } from "../term/screen.ts";
import { style } from "../term/style.ts";
import type { Tokens } from "../ui/theme.ts";
import { truncate } from "../term/width.ts";
import { beside, fill, len, split } from "../ui/layout.ts";
import { icon, type IconSet } from "../ui/icons.ts";
import { card, emptyState } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  Filter,
  ISSUE_MARK,
  ListState,
  PIN_MARK,
  PULL_MARK,
  ago,
  confirmScreen,
  countsColumn,
  metaOf,
  drawList,
  errorText,
  hitList,
  live,
  runAsync,
  type ListRow,
  openOnWeb,
  promptScreen,
  plural,
  linkScreen,
} from "./common.ts";
import { readVitals, vitalsLine } from "../../flow/vitals.ts";
import { readKpis } from "../../flow/kpis.ts";
import { kpiLines } from "../../flow/kpi_words.ts";
import { BOOTED } from "../../release/gate.ts";
import { running } from "../../kernel/version.ts";
import { deciderLine, deciderScreen } from "./decider.ts";
import { issueScreen } from "./issue.ts";
import { listPinned } from "../../actions/board-pins.ts";
import { migrateScreen } from "./migrate.ts";
import { newRepoScreen } from "./newrepo.ts";
import { firedAlarms } from "../../flow/alarms.ts";
import { lastClearedNote } from "../../flow/clog_tick.ts";
import { forgeCeiling } from "../../flow/ceiling.ts";
import { alarmIdleCrew } from "../../flow/alarm_idle_crew.ts";
import { idleLine, idleReason } from "../../crew/idle_reason.ts";
import { weekBlock } from "../../crew/week_read.ts";
import { noReleaseAlarm } from "../../flow/alarm_no_release.ts";
import { redMainAlarm } from "../../flow/alarm_red_main.ts";
import { alarmStuck } from "../../flow/alarm_stuck.ts";
import { pullScreen } from "./pull.ts";
import { repoScreen } from "./repo.ts";
import { local } from "./where.ts";
import { signInScreen } from "./signin.ts";

/** Rows the list keeps under the figures strip; below it the strip shows fewer figures. */
const FIGURES_ROOM = 6;

/** The forge-wide daily ceiling, from config, for the spend figure; the data directory, for the backup's age. */
export const kpiForge = (app: { config: { crewCeilingUsd?: number; dataDir: string } }) => ({
  ceilingUsd: forgeCeiling(app.config),
  dataDir: app.config.dataDir,
});

/**
 * The three things the launcher is about. Order is the `tab` order: the
 * repositories, then what is waiting on you, then what is on your machine.
 * What happened and what is running are the web's questions.
 */
type PaneId = "repos" | "onyou" | "machine";

const TITLES: Readonly<Record<PaneId, string>> = {
  repos: "Repositories",
  onyou: "On you",
  machine: "On your machine",
};

/** An issue or a pull assigned to the viewer, with the repository it is in. */
interface OnYouItem {
  readonly issue: Issue;
  readonly repo: Repo;
  /** A hand-over card that asks this person: the crew's issue, not assigned to them. */
  readonly hand?: true;
  /** A pull the crew handed to a person: closed, marked and opened like any row. */
  readonly over?: true;
  /** A pull a pass assigned to this person: why, and who it goes back to (`b`). */
  readonly passed?: string;
  /** For a handed-over row: the crew's advice, when it wrote one. */
  readonly overAdvice?: string;
  /** A pull no person has touched for a day, with the crew's advice when it wrote one. */
  readonly late?: { readonly advice: string };
  /** What it waits for, and on whom: the word the web's asks row shows. */
  readonly waiting: WaitingFor;
}

/** The `tab` order, whichever of these the frame had room for. */
const ORDER: readonly PaneId[] = ["repos", "onyou", "machine"];

export function dashboardScreen(f: Session, ctx: Ctx): Screen {
  let repos: Repo[] = [];
  let all: Repo[] = [];
  let pins: Pin[] = [];
  let pinned = new Set<string>();
  let onYou: OnYouItem[] = [];
  /** Where each pull on you stands on the path (check, review, land, live), by issue id. */
  let onYouSteps = new Map<string, string>();
  /** The week's asks line, read on reload; drawing only reads it. */
  let asksLine: string | undefined;
  /** Wave proposals that wait for this person's nod, listed after the rows above. */
  let waves: { proposal: Proposal; repo: Repo }[] = [];
  /** Waves put aside with Later, which `B` brings back. */
  let asideWaves: Proposal[] = [];
  /** Repositories the viewer muted that hold work assigned to them: said, never silent. */
  let silenced = new Map<string, Repo>();
  /** The rows marked for one verb, by issue id. */
  const marked = new Set<string>();
  let lastSet: Operation | undefined;
  /** What Home and /review count: live asks waiting on the viewer, and the stale ones folded apart. */
  let waitingSet: ReviewSet | undefined;
  /** The repositories marked for archiving, by id; only ones the viewer administers. */
  const markedRepos = new Set<string>();
  /** The receipt of the last archive made here, which `u` reverses once. */
  let lastArchive: string | undefined;
  /**
   * Why planning is paused, for the autonomous apps where it is, as on the
   * board; else why the governor holds the crew below its slots (#7644).
   */
  let holds = new Map<string, string>();
  let forge: string[] | undefined;
  /** What the crews wait on this person for, one line each, as the board's notes say it. */
  let waits: string[] = [];
  /** A client's apps, one sentence each on whether its agents work or wait (#1812). */
  let clientLines: string[] = [];
  /** "Since you were here" and its lines: read from the web home's last-visit row, never written here. */
  let sinceLines: string[] = [];
  /** The web home's living pipeline (#8015): Now for a site admin, then being built and just shipped. */
  let moving: string[] = [];
  /** The ids of those apps, so the key that asks for something stays on them. */
  let clientRepoIds = new Set<string>();
  /** The live address of each of those apps that is running, by repo id; `o` shows it. */
  let clientLive = new Map<string, string>();
  /** The check lane, as the board's strip says it; null when nothing is queued. */
  let lane: string | null = null;
  /** The week's flaky tests, one line; null when none flaked. */
  let flaky: string | null = null;
  /** What the decider did today, the board's Today line; null on a quiet day or for a reader. */
  let decider: string | null = null;
  /** Home's three figures, as the web's row says them; empty unless an admin looks (they count every repository). */
  let figures: string[] = [];
  /**
   * The web home's everyday ask, as one muted line at the head (#8046): why,
   * and the two answers, while an admin has made no choice; once linked, the
   * name of the account used day to day. Nobody else gets the row.
   */
  let everyday: { line: string; asking: boolean } | undefined;
  /** One line per fired flow alarm; an admin reads every repository, anyone else public ones alone. */
  let alarms: string[] = [];
  /** The panels this admin pinned to the web home, by title and board, in their order. */
  let panelLines: string[] = [];
  const filter = new Filter();
  /**
   * A search line with `kind:` or `sort:` is the explorer's (#7325): the rows
   * `/explore` ranks, answered by the same action, for the line last settled.
   */
  let explored: { line: string; rows: readonly ExploreRow[] } | undefined;
  let askedLine = "";
  const exploring = (): boolean => isExploreLine(filter.query);
  const exploredRows = (): readonly ExploreRow[] => (exploring() ? (explored?.rows ?? []) : []);
  const syncExplore = (): void => {
    if (!exploring()) {
      explored = undefined;
      askedLine = "";
      return;
    }
    const query = parseExploreQuery(filter.query);
    const line = exploreLine(query);
    if (line === askedLine) return;
    askedLine = line;
    // The rows kept belong to the old line; none are shown under the new one.
    explored = undefined;
    runAsync(ctx, async () => {
      const page = await explorePage(f.app, f.user, query, null).catch(() => null);
      // A newer line was typed while this one was ranked; its answer wins.
      if (askedLine !== line) return;
      const rows = page?.items ?? [];
      explored = { line, rows };
      at("repos").clamp(rows.length);
      ctx.invalidate();
    });
  };
  /** One cursor per pane: moving in one must never move another. */
  const cursors: Record<PaneId, ListState> = {
    repos: new ListState(),
    onyou: new ListState(),
    machine: new ListState(),
  };
  let focus: PaneId = "repos";

  const loadClientLines = async (): Promise<void> => {
    clientLines = [];
    if (!f.user || (await nextStepsFor(f.app, f.user)) === undefined) return;
    // A client's home never carries the forge-wide figures, on either door.
    figures = [];
    const apps = await clientAppRows(f.app, f.user);
    clientRepoIds = new Set(apps.map((a) => a.repo.id));
    clientLive = new Map(apps.flatMap((a) => (a.live === undefined ? [] : [[a.repo.id, a.live] as const])));
    const now = new Date();
    const ids = apps.map((a) => a.repo.id);
    const doings = clientDoings(f.app.db, ids);
    const finished = clientFinished(f.app.db, ids);
    clientLines =
      apps.length === 0
        ? ["Your apps will appear here."]
        : apps.map((a) => {
            const doing = [
              finishedLine(finished.get(a.repo.id), now.getTime()),
              doingLine(doings.get(a.repo.id)),
            ]
              .filter((x) => x !== "")
              .join(" ");
            const mark = a.live === undefined ? "" : " (running, o opens it)";
            const line = `${a.repo.name}${mark}: ${agentsLine(a.working, a.queued)}`;
            return doing === "" ? line : `${line} ${doing}`;
          });
    ctx.invalidate();
  };

  const loadSinceLines = (): void => {
    const d = f.user ? sinceDigest(f.app.db, f.user, lastVisit(f.app.db, f.user.id), Date.now()) : undefined;
    sinceLines = d === undefined ? [] : [d.heading, ...d.lines.map((l) => `  ${l.says}`)];
    ctx.invalidate();
  };

  const loadPanelLines = async (): Promise<void> => {
    const listed = await listPinned(f.app, f.user);
    const titles = listed.ok ? listed.value.map((p) => `${plain(p.panel.title)} (${plain(p.board.title)})`) : [];
    panelLines = titles.length === 0 ? [] : [`Pinned: ${titles.join(" · ")}`];
    ctx.invalidate();
  };

  const everydayHead = (): typeof everyday => {
    if (f.user === undefined || !f.user.isAdmin || f.user.kind !== "user") return undefined;
    if (askForEveryday(f.db, f.user))
      return { line: `${EVERYDAY_WHY} E makes it on the web · K keeps using admin`, asking: true };
    const daily = everydayOf(f.db, f.user);
    return daily === undefined
      ? undefined
      : { line: `Day to day you are ${daily.username}; this is the admin account.`, asking: false };
  };

  /** `K`: the admin keeps working as admin, recorded for web and terminal alike. */
  const keepAdminHere = (): void => {
    if (f.user === undefined) return;
    keepAdmin(f.db, f.user);
    reload();
    ctx.toast("kept admin; you will not be asked again", "success");
  };

  const reload = (): void => {
    // The server remembers the *choice* and nothing about the laptop, so
    // this is a list of decisions — never a status that would be stale.
    pins = f.user ? listPins(f.db, f.user.id) : [];
    everyday = everydayHead();
    pinned = f.user ? pinnedRepoIds(f.db, f.user.id) : new Set<string>();
    all = listReposVisibleTo(f.db, f.user, { limit: 200 });
    onYou = assignedToMe();
    onYouSteps = new Map(
      onYou.flatMap((item) => {
        const step = item.issue.kind === "pull" ? stepOfNumber(f.db, item.repo, item.issue.number) : null;
        return step === null ? [] : [[item.issue.id, stepLine(step)] as const];
      }),
    );
    asksLine = undefined;
    if (f.user !== undefined && f.user.kind === "user") {
      const m = askMeasureWeek(f.db, f.user.id);
      if (!asksMeasureEmpty(m)) asksLine = asksMeasureWords(m);
    }
    waitingSet = f.user === undefined ? undefined : reviewSetOf(f.db, f.user, new Date());
    waves = f.user === undefined ? [] : wavesFor();
    asideWaves = f.user === undefined ? [] : putAsideWaves(f.db, f.user);
    for (const id of [...marked])
      if (!onYou.some((item) => item.issue.id === id)) marked.delete(id);
    lastSet = f.user ? latestUndoable(f.app, f.user) : undefined;
    const now = new Date();
    holds = new Map(
      all.flatMap((repo) => {
        const hold =
          repo.autonomy === "autonomous" ? plannerHold(f.app, repo, now) : null;
        if (hold !== null) return [[repo.id, holdWords(hold)] as const];
        const governor = governorSeen(f.app, f.user, repo, now);
        return governor?.held === true ? [[repo.id, governor.why] as const] : [];
      }),
    );
    alarms =
      f.user?.isAdmin === true
        ? [
            alarmStuck(f.db, now),
            redMainAlarm(f.db, now),
            alarmIdleCrew(f.db, now, { ceilingUsd: forgeCeiling(f.app.config) }),
            noReleaseAlarm(f.db, now),
          ]
            .filter((a) => a.fired)
            .map((a) => a.says)
        : [alarmStuck(f.db, now, { publicOnly: true })].filter((a) => a.fired).map((a) => a.says);
    forge = forgeNeeds(f.app, f.user);
    if (forge !== undefined) {
      const fh = forgeHealth();
      const verdict = forgeVerdict(fh, Date.now());
      if (verdict !== undefined)
        forge = [
          verdictLine(verdict),
          ...forge.filter((line) => !coveredByVerdict(line, verdict, fh)),
        ];
    }
    const facts = f.user === undefined ? new Set<string>() : ownerFactRepoIds(f.db, all, f.user);
    waits = ownerWaits(f.db, all.filter((r) => facts.has(r.id))).map(waitLine);
    lane = forgeLane(f.app, f.user);
    flaky = forgeFlakes(f.app, f.user);
    decider = deciderLine(f.app, f.user);
    moving = f.user ? movingLines(f.db, f.user, f.user.isAdmin ? pipelineNow(f.db) : undefined) : [];
    const commit = running().commit;
    const cleared = lastClearedNote(f.db, now);
    figures =
      f.user?.isAdmin !== true
        ? []
        : [
            ...idleLines(f.app, now),
            ...weekBlock(f.app, now),
            ...kpiLines(readKpis(f.db, now, { ...kpiForge(f.app), idle: () => idleReason(f.app, now) }), commit === null ? null : { sha: commit, since: ago(BOOTED) }),
            vitalsLine(readVitals(f.db, now)),
            ...firedAlarms(f.db, now, { ceilingUsd: forgeCeiling(f.app.config) }).map((a) => a.says),
            ...(cleared === undefined ? [] : [cleared]),
          ];
    // "Yours" is ownership plus the orgs you are on a team of; typing in the
    // filter reaches every repository you can see.
    const orgs = f.user
      ? listOrgsForUser(f.db, f.user.id).map((o) => o.username)
      : [];
    // Archived ones leave Yours as they leave the web home; the filter still finds them.
    const live = withoutArchived(all);
    repos = f.user
      ? live.filter(
          (repo) =>
            repo.ownerId === f.user?.id || orgs.includes(repo.ownerName),
        )
      : live;
    for (const id of [...markedRepos])
      if (!repos.some((repo) => repo.id === id)) markedRepos.delete(id);
    ctx.invalidate();
  };

  /**
   * What is assigned to the viewer, open, newest first. The rows come from
   * one query and the repositories from one grouped read; `canRead` is the
   * same filter every list applies, so an assignment in a repository this
   * account has since lost cannot appear here.
   */
  const assignedToMe = (): OnYouItem[] => {
    if (f.user === undefined) return [];
    const rows = askLinesFor(f.db, f.user);
    /** The ask row's word for an issue or pull, by its id; a plain assignment says so. */
    const waitingOf = (id: string): WaitingFor =>
      rows.find((row) => row.items.some((item) => item.slice(item.indexOf(":") + 1) === id))
        ?.waitingFor ??
      waitingFor({ kind: "stopped", conflicts: 0, assignedToViewer: true, who: "you" });
    const issues = listAssignedTo(f.db, f.user.id, 50);
    const muted = mutedRepos(f.db, f.user.id);
    const byId = getReposByIds(f.db, [...new Set([...issues.map((i) => i.repoId), ...muted])]);
    // Every repository this account muted, with work on it or not: the web's
    // card counts the same set, and `L` takes back all of it.
    silenced = new Map();
    for (const id of muted) {
      const repo = byId.get(id);
      if (repo !== undefined && canRead(f.db, repo, f.user)) silenced.set(id, repo);
    }
    const off = chipsOf(f.db, f.user.id).people;
    const assigned = issues.flatMap((issue) => {
      if (off.has(issue.authorId)) return [];
      const repo = byId.get(issue.repoId);
      if (
        repo === undefined ||
        repo.archivedAt !== null ||
        !canRead(f.db, repo, f.user) ||
        !mayView(f.db, repo, issue, f.user)
      )
        return [];
      if (muted.has(repo.id)) return [];
      const passed =
        issue.kind === "pull" && !issue.assigneeIsAgent && issue.assigneeId === f.user?.id
          ? passReasonOf(f.db, issue.id, issue.assigneeId)
          : undefined;
      return [{ issue, repo, waiting: waitingOf(issue.id), ...(passed === undefined ? {} : { passed }) }];
    });
    return [...assigned, ...handOvers(assigned, rows, waitingOf)];
  };

  /**
   * The cards that ask this person and are not assigned to them: parked
   * ones, which the breaker leaves assigned to the agent (only where a
   * decider can take them), and pulls the crew handed over after three
   * reviews. Listed after their own work.
   */
  const handOvers = (
    have: readonly OnYouItem[],
    rows: ReturnType<typeof askLinesFor>,
    waitingOf: (id: string) => WaitingFor,
  ): OnYouItem[] => {
    const advice = (id: string, kind: "waiting" | "handover" = "waiting"): string => {
      const r = rows.find((row) => row.items.includes(`${kind}:${id}`))?.recommendation;
      return r === undefined ? "" : ` · crew advises: ${r.verdict}${r.reason === "" ? "" : ` — ${r.reason}`}`;
    };
    if (f.user === undefined) return [];
    const idsOf = (kind: string, prefix: string): string[] =>
      rows
        .filter((row) => row.kind === kind)
        .flatMap((row) => row.items)
        .filter((id) => id.startsWith(prefix))
        .map((id) => id.slice(prefix.length));
    const wanted: { id: string; flag: "hand" | "over" | "late" }[] = [
      ...(f.app.config.decider === undefined
        ? []
        : idsOf("parked", "parked:").map((id) => ({ id, flag: "hand" as const }))),
      ...idsOf("handover", "handover:").map((id) => ({ id, flag: "over" as const })),
      ...idsOf("waiting", "waiting:").map((id) => ({ id, flag: "late" as const })),
    ];
    const out: OnYouItem[] = [];
    const seen = new Set<string>();
    for (const { id, flag } of wanted) {
      if (seen.has(id) || have.some((item) => item.issue.id === id)) continue;
      seen.add(id);
      const issue = getIssueById(f.db, id);
      const repo = issue === undefined ? undefined : getRepoById(f.db, issue.repoId);
      if (issue !== undefined && repo !== undefined)
        out.push({ issue, repo, waiting: waitingOf(id), ...(flag === "hand"
            ? { hand: true as const }
            : flag === "over"
              ? { over: true as const, overAdvice: advice(id, "handover") }
              : { late: { advice: advice(id) } }) });
    }
    return out;
  };

  /** The wave proposals that ask this person, as the web's asks list has them. */
  const wavesFor = (): { proposal: Proposal; repo: Repo }[] => {
    if (f.user === undefined) return [];
    const out: { proposal: Proposal; repo: Repo }[] = [];
    for (const row of askLinesFor(f.db, f.user)) {
      if (row.proposal === undefined) continue;
      const proposal = getProposal(f.db, row.proposal.id);
      const repo = proposal === undefined ? undefined : getRepoById(f.db, proposal.repoId);
      if (proposal !== undefined && repo !== undefined) out.push({ proposal, repo });
    }
    return out;
  };

  /** The wave under the cursor, when the cursor is past the issues and pulls. */
  const waveHere = (): { proposal: Proposal; repo: Repo } | undefined =>
    waves[at("onyou").index - onYou.length];

  /** One verb on the wave under the cursor, through the action every door uses. */
  const actOnWave = (verb: ProposalVerb, words?: string): void => {
    const here = waveHere();
    if (here === undefined) {
      ctx.toast("only a wave proposal takes this", "attn");
      return;
    }
    const done = actOnProposal(f.app, f.user, verb, here.proposal.id, words);
    reload();
    ctx.toast(
      done.ok ? (verb === "approve" ? "issues opened" : verb === "later" ? "put aside · B brings it back" : "sent to the planner") : done.error.message,
      done.ok ? "success" : "danger",
    );
  };

  const redirectWave = (): void => {
    if (waveHere() === undefined) return actOnWave("redirect");
    ctx.push(
      promptScreen(ctx, screen, {
        title: "Redirect the planner",
        label: "Plan this instead",
        hint: "Your words go to the planner as a new run.",
        onSubmit: (value) => {
          actOnWave("redirect", value);
          return undefined;
        },
      }),
    );
  };

  const bringBackWaves = (): void => {
    let n = 0;
    for (const w of asideWaves) if (actOnProposal(f.app, f.user, "again", w.id).ok) n++;
    reload();
    ctx.toast(`${n} ${n === 1 ? "wave" : "waves"} back`, "success");
  };

  /** The marked rows, or the one under the cursor when none is marked. */
  const targets = (): OnYouItem[] => {
    const mine = onYou.filter((item) => item.hand !== true);
    const picked = mine.filter((item) => marked.has(item.issue.id));
    const here = mine.find((item) => item === onYou[at("onyou").index]);
    return picked.length > 0 ? picked : here === undefined ? [] : [here];
  };

  /** One verb for the set, through the same action the web and API use. */
  const clear = (action: "close" | "mute" | "ship", reason?: string): void => {
    const items = targets().map((t) => `${t.over === true ? "handover" : t.late !== undefined ? "waiting" : "issue"}:${t.issue.id}`);
    if (items.length === 0) return;
    runAsync(ctx, async () => {
      const done = await applyAsksBulk(f.app, f.user, action, items, reason);
      if (!done.ok) {
        ctx.toast(done.error.message, "danger");
        return;
      }
      const ok = done.value.rows.filter((r) => r.outcome === "ok").length;
      const refused = [
        ...done.value.rows
          .filter((r) => r.outcome !== "ok")
          .map((r) => `${r.label}: ${r.reason}`),
        ...done.value.skipped.map((s) => `${s.item}: ${s.reason}`),
      ];
      marked.clear();
      reload();
      ctx.toast(
        `${action}: ${ok} done` +
          (refused.length > 0 ? `, ${refused.length} refused (${refused[0]})` : "") +
          (ok > 0 ? " · u undoes" : ""),
        refused.length > 0 ? "attn" : "success",
      );
    });
  };

  const closeSet = (): void => {
    if (targets().length === 0) return;
    ctx.push(
      promptScreen(ctx, screen, {
        title: `Close ${plural(targets().length, "item")}`,
        label: "Reason",
        hint: "One reason, written on each. Empty is fine.",
        onSubmit: (value) => {
          clear("close", value.trim());
          return undefined;
        },
      }),
    );
  };

  const shipSet = (): void => {
    const n = targets().length;
    if (n === 0) return;
    ctx.push(
      confirmScreen(ctx, screen, {
        title: "Ship",
        body: [`Ship ${plural(n, "item")}? Each is checked for your access.`],
        actions: [
          { label: "Cancel", variant: "ghost" },
          { label: "Ship", variant: "danger" },
        ],
        selected: 0,
        onChoose: (index) => {
          if (index === 1) clear("ship");
        },
      }),
    );
  };

  /** Whether the viewer may archive this repository (the action decides again). */
  const mayArchive = (repo: Repo): boolean =>
    f.user !== undefined && f.user.kind === "user" && canAdmin(f.db, repo, f.user);

  /** Archive the marked repositories: a one-line preview naming them, then the fleet `archive` verb. */
  const archiveMarked = (): void => {
    const picked = repos.filter((repo) => markedRepos.has(repo.id) && mayArchive(repo));
    if (picked.length === 0 || f.user === undefined) return;
    const ids = picked.map((repo) => repo.id);
    const names = picked.map((repo) => `${repo.ownerName}/${repo.name}`);
    const query = `archive ${names.join(" ")}`;
    const action = { verb: "archive", value: true };
    const plan = previewFleetIds(f.app, f.user, "repo", ids, query, action);
    if (!plan.ok) {
      ctx.toast(plan.error.message, "danger");
      return;
    }
    if (plan.value.counts.change === 0) {
      ctx.toast("nothing to archive", "attn");
      return;
    }
    ctx.push(
      confirmScreen(ctx, screen, {
        title: `Archive ${plural(plan.value.counts.change, "repository", "repositories")}?`,
        body: [names.join(", ")],
        actions: [
          { label: "Archive", variant: "danger" },
          { label: "Cancel", variant: "ghost" },
        ],
        onChoose: (choice) => {
          if (choice !== 0) return;
          runAsync(ctx, async () => {
            const done = await applyFleetIds(f.app, f.user, "repo", ids, query, action);
            if (!done.ok) {
              ctx.toast(done.error.message, "danger");
              return;
            }
            const n = done.value.rows.filter((r) => r.outcome === "ok").length;
            lastArchive = n > 0 ? done.value.id : undefined;
            markedRepos.clear();
            reload();
            ctx.toast(`archived ${n} — u undoes it`, n > 0 ? "success" : "attn");
          });
        },
      }),
    );
  };

  /** The asks older than 30 days, dismissed in one step: the bulk preview first, nothing before the choice. */
  const archiveStale = (): void => {
    const stale = (waitingSet?.stale ?? []).slice(0, BULK_MAX);
    if (stale.length === 0 || f.user === undefined) return;
    const items = stale.map((a) => a.id);
    const plan = previewAsksBulk(f.app, f.user, "dismiss", items);
    if (!plan.ok) {
      ctx.toast(plan.error.message, "danger");
      return;
    }
    if (plan.value.counts.change === 0) {
      ctx.toast("nothing to archive", "attn");
      return;
    }
    ctx.push(
      confirmScreen(ctx, screen, {
        title: `Archive ${plural(plan.value.counts.change, "stale ask")}?`,
        body: [
          ...plan.value.rows.map((r) => r.label),
          ...((waitingSet?.stale.length ?? 0) > BULK_MAX ? [`First ${BULK_MAX} of ${waitingSet?.stale.length}; run it again for the rest.`] : []),
        ],
        actions: [
          { label: "Archive", variant: "danger" },
          { label: "Cancel", variant: "ghost" },
        ],
        onChoose: (choice) => {
          if (choice !== 0) return;
          runAsync(ctx, async () => {
            const done = await applyAsksBulk(f.app, f.user, "dismiss", items);
            if (!done.ok) {
              ctx.toast(done.error.message, "danger");
              return;
            }
            const n = done.value.rows.filter((r) => r.outcome === "ok").length;
            reload();
            ctx.toast(`archived ${n}${n > 0 ? " — u undoes it" : ""}`, n > 0 ? "success" : "attn");
          });
        },
      }),
    );
  };

  const undoArchive = (): void => {
    const id = lastArchive;
    if (id === undefined) return;
    runAsync(ctx, async () => {
      const done = await undoFleetOp(f.app, f.user, id);
      lastArchive = undefined;
      reload();
      ctx.toast(done.ok ? "undone" : done.error.message, done.ok ? "success" : "danger");
    });
  };

  const undoSet = (): void => {
    const op = lastSet;
    if (op === undefined) {
      ctx.toast("nothing to undo", "attn");
      return;
    }
    runAsync(ctx, async () => {
      const done = await undoAsksBulk(f.app, f.user, op.id);
      reload();
      ctx.toast(
        done.ok ? "undone" : done.error.message,
        done.ok ? "success" : "danger",
      );
    });
  };

  /** The decision `U` undoes: the decider's latest set-aside this session. */
  let lastHand: string | undefined;

  /** Hand the row under the cursor to the decider, through the action the web and API use. */
  const handToDecider = (): void => {
    const here = onYou[at("onyou").index];
    if (here === undefined) return;
    if (here.hand !== true) {
      ctx.toast("only a hand-over card goes to the decider", "attn");
      return;
    }
    runAsync(ctx, async () => {
      const done = await decideAsk(f.app, f.user, `issue:${here.issue.id}`);
      if (!done.ok) {
        ctx.toast(done.error.message, "danger");
        return;
      }
      lastHand = done.value.setAside ? done.value.id : undefined;
      reload();
      ctx.toast(done.value.reason + (done.value.setAside ? " · U undoes" : ""), "success");
    });
  };

  /** Give the handed-over or assigned work under the cursor to the crew, through the action the web uses. */
  const giveBackHere = (): void => {
    const here = onYou[at("onyou").index];
    if (here === undefined) return;
    if (here.hand === true) {
      ctx.toast("only work handed to you goes back to the crew", "attn");
      return;
    }
    const done = giveBack(f.app, f.user, `${here.over === true ? "handover" : "assigned"}:${here.issue.id}`);
    reload();
    ctx.toast(
      done.ok ? `#${done.value.pull} given back to @${done.value.builder}` : done.error.message,
      done.ok ? "success" : "danger",
    );
  };

  const undoHand = (): void => {
    const id = lastHand;
    if (id === undefined) {
      ctx.toast("nothing to undo", "attn");
      return;
    }
    const done = undoDecideAsk(f.app, f.user, id);
    if (done.ok) lastHand = undefined;
    reload();
    ctx.toast(done.ok ? "back on your board" : done.error.message, done.ok ? "success" : "danger");
  };

  const listenAgain = (): void => {
    if (f.user === undefined || silenced.size === 0) return;
    removeMutes(
      f.db,
      f.user.id,
      [...silenced.keys()].map((id) => `repo:${id}`),
    );
    reload();
    ctx.toast("listening again", "success");
  };

  /** `1`–`4` switch a kind chip off or on, `P` brings back every person; the web's chips, the same table. */
  const toggleChip = (n: number): void => {
    if (f.user === undefined) return;
    const value = KIND_CHIPS[n];
    if (value === undefined) return;
    const hidden = !chipsOf(f.db, f.user.id).kinds.has(value);
    setChip(f.db, f.user.id, { kind: "kind", value }, hidden);
    reload();
    ctx.toast(`${value} ${hidden ? "off" : "on"}`, "success");
  };
  /** `h` on an On you row switches its author off, as the web's person chip does; never yourself. */
  const hideAuthor = (): void => {
    const here = onYou[at("onyou").index];
    if (f.user === undefined || here === undefined) return;
    if (here.issue.authorId === f.user.id) {
      ctx.toast("that one is yours", "attn");
      return;
    }
    setChip(f.db, f.user.id, { kind: "person", value: here.issue.authorId }, true);
    reload();
    ctx.toast(`${here.issue.authorName} off`, "success");
  };
  const showPeople = (): void => {
    if (f.user === undefined) return;
    const people = chipsOf(f.db, f.user.id).people;
    for (const id of people) setChip(f.db, f.user.id, { kind: "person", value: id }, false);
    reload();
    ctx.toast(people.size > 0 ? "people back on" : "no person is off", "success");
  };

  /** Yours with an empty filter; anything you can see once you type —
   * the one way to find someone else's repository from here. */
  const shown = (): Repo[] =>
    exploring() ? [] : (filter.query !== "" ? all : repos).filter((repo) =>
      filter.matches(`${repo.ownerName}/${repo.name} ${repo.description}`),
    );

  /**
   * The panes the last frame drew, which is what `tab` can reach — a focus
   * ring on a card that is not on screen is worse than no focus ring. The
   * frame decides, not a rule repeated here: at two columns everything is
   * up; narrower, the activity feed stacks under the repositories and the
   * three small cards wait for a wider window; shorter still, the
   * repositories have the whole body.
   */
  let drawn: ReadonlySet<PaneId> = new Set<PaneId>(["repos"]);
  const panes = (): PaneId[] => ORDER.filter((pane) => drawn.has(pane));

  const at = (pane: PaneId): ListState => cursors[pane];
  const size = (pane: PaneId): number =>
    pane === "repos"
      ? exploring()
        ? exploredRows().length
        : shown().length
      : pane === "onyou"
        ? onYou.length + waves.length
        : pins.length;

  const cycle = (step: number): void => {
    const list = panes();
    const here = Math.max(0, list.indexOf(focus));
    focus = list[(here + step + list.length) % list.length] ?? "repos";
  };

  /** `enter` on a repository row, wherever the row came from. */
  const openRepo = (repo: Repo | undefined): void => {
    if (repo !== undefined) ctx.push(repoScreen(f, ctx, local(f, repo)));
  };

  /** `enter` on an explorer row: an app opens as any repository; the rest are the web's. */
  const openExplored = (row: ExploreRow | undefined): void => {
    if (row === undefined) return;
    if (row.kind === "app" && row.repo !== undefined) {
      const repo = getRepo(f.db, row.repo.owner, row.repo.name);
      if (repo !== undefined && canRead(f.db, repo, f.user)) return openRepo(repo);
      ctx.toast(`${row.name} is not here any more`, "attn");
      return;
    }
    ctx.toast(`${row.name} has no terminal page; the web has it at ${row.url}`, "attn");
  };

  const openPin = (pin: Pin | undefined): void => {
    if (pin === undefined) return;
    const repo = getRepo(f.db, pin.ownerName, pin.name);
    // A pin is a decision this account made; the repository behind it can
    // still have gone away or stopped being visible, and that is a sentence
    // to say rather than a dead keypress.
    if (repo === undefined || !canRead(f.db, repo, f.user)) {
      ctx.toast(`${pin.ownerName}/${pin.name} is not here any more`, "attn");
      return;
    }
    openRepo(repo);
  };

  const unpin = (pin: Pin | undefined): void => {
    if (pin === undefined || f.user === undefined) return;
    const user = f.user;
    ctx.push(
      confirmScreen(ctx, screen, {
        title: "Unpin",
        body: [
          `Stop keeping ${pin.ownerName}/${pin.name} on your machine?`,
          "Nothing here is deleted; forge sync simply stops fetching it.",
        ],
        actions: [
          { label: "Keep it", variant: "ghost" },
          { label: "Unpin", variant: "danger" },
        ],
        selected: 0,
        onChoose: (index) => {
          if (index !== 1) return;
          const repo = getRepo(f.db, pin.ownerName, pin.name);
          if (repo !== undefined) unpinRepo(f.app, user, repo);
          reload();
          ctx.toast("unpinned", "success");
        },
      }),
    );
  };

  const openAssigned = (item: OnYouItem | undefined): void => {
    if (item === undefined) return;
    const src = local(f, item.repo);
    ctx.push(
      item.issue.kind === "pull"
        ? pullScreen(f, ctx, src, item.issue.number)
        : issueScreen(f, ctx, src, item.issue.number),
    );
  };

  /** `enter` on whatever the focused pane's cursor is on. */
  const openHere = (): void => {
    if (focus === "repos") {
      if (exploring()) openExplored(exploredRows()[at("repos").index]);
      else openRepo(shown()[at("repos").index]);
    } else if (focus === "onyou") openAssigned(onYou[at("onyou").index]);
    else openPin(pins[at("machine").index]);
  };

  const screen: Screen = {
    title: f.user ? f.user.username : "Guest",
    get keys() {
      return [
        binding(["tab"], "next pane", { disabled: panes().length < 2 }),
        binding(["j", "k"], "move"),
        binding(["enter"], "open"),
        binding(["/"], "find"),
        binding(["p"], "pin", { disabled: !f.signedIn }),
        // The On you verbs show only where they act, so the bar stays short.
        ...(focus === "onyou" && onYou[at("onyou").index]?.hand === true
          ? [binding(["D"], "let the decider")]
          : []),
        ...(focus === "onyou" && onYou[at("onyou").index] !== undefined && onYou[at("onyou").index]?.hand !== true
          ? [binding(["b"], "give back to the crew")]
          : []),
        ...(focus === "onyou" && waveHere() !== undefined
          ? [binding(["y"], "approve wave"), binding(["R"], "redirect"), binding(["l"], "later")]
          : []),
        ...(asideWaves.length > 0 ? [binding(["B"], "bring waves back")] : []),
        ...(lastHand !== undefined ? [binding(["U"], "undo decider")] : []),
        ...(focus === "onyou" && onYou.length > 0
          ? [
              binding(["space"], "mark"),
              binding(["x"], "close"),
              binding(["m"], "mute"),
              binding(["S"], "ship"),
            ]
          : []),
        ...(focus === "onyou" && (waitingSet?.stale.length ?? 0) > 0 ? [binding(["Z"], "archive stale")] : []),
        ...(lastSet !== undefined || lastArchive !== undefined ? [binding(["u"], "undo")] : []),
        ...(silenced.size > 0 ? [binding(["L"], "listen again")] : []),
        binding(["d"], "unpin", {
          disabled: focus !== "machine" || pins.length === 0,
        }),
        binding(["C"], "decider", { disabled: !f.user }),
        ...(clientLines.length > 0 ? [binding(["t"], "ask for something")] : []),
        ...(clientLive.size > 0 ? [binding(["o"], "open the app")] : []),
        binding(["n"], "new repo", { disabled: !f.signedIn }),
        binding(["M"], "migrate", { disabled: !f.signedIn }),
        binding(["A"], "account", { disabled: !f.signedIn }),
        binding(["s"], "sign in", { disabled: f.signedIn }),
        ...(focus === "repos" && f.user !== undefined && shown().some(mayArchive)
          ? [binding(["space"], "mark"), ...(markedRepos.size > 0 ? [binding(["a"], "archive marked")] : [])]
          : []),
        ...(everyday?.asking === true
          ? [binding(["E"], "everyday account"), binding(["K"], "keep admin")]
          : []),
        binding(["r"], "refresh"),
      ];
    },
    load(signal) {
      // The repo list, the counts beside it and what is on you are all
      // functions of the outbox, so one subscription refreshes all of them.
      live(f, signal, {}, reload);
      reload();
      loadSinceLines();
      return Promise.all([loadClientLines(), loadPanelLines()]).then(() => undefined);
    },
    render(area, s) {
      const c = ctx.theme.c;
      const set = ctx.icons;
      // A site admin's forge strip, as the board's: "All fine" or a line
      // per cause. Anyone else gets no rows and no reads.
      let body = area;
      if (everyday !== undefined) {
        const [strip, rest] = split(body, "v", [len(1), fill(1)]);
        s.text(strip!.x, strip!.y, truncate(everyday.line, strip!.w), style(c.mutedFg, c.bg), strip!.x + strip!.w);
        body = rest!;
      }
      if (alarms.length > 0) {
        const [strip, rest] = split(body, "v", [len(alarms.length), fill(1)]);
        alarms.forEach((line, i) =>
          s.text(strip!.x, strip!.y + i, truncate(line, strip!.w), style(c.attn, c.bg), strip!.x + strip!.w),
        );
        body = rest!;
      }
      if (clientLines.length > 0) {
        const lines = clientLines.slice(0, 5);
        const [strip, rest] = split(body, "v", [len(lines.length), fill(1)]);
        lines.forEach((line, i) =>
          s.text(
            strip!.x,
            strip!.y + i,
            truncate(line, strip!.w),
            style(c.fg, c.bg),
            strip!.x + strip!.w,
          ),
        );
        body = rest!;
      }
      if (sinceLines.length > 0) {
        const lines = sinceLines.slice(0, 4);
        const [strip, rest] = split(body, "v", [len(lines.length), fill(1)]);
        lines.forEach((line, i) =>
          s.text(strip!.x, strip!.y + i, truncate(line, strip!.w), style(i === 0 ? c.mutedFg : c.fg, c.bg), strip!.x + strip!.w),
        );
        body = rest!;
      }
      if (moving.length > 0) {
        const [strip, rest] = split(body, "v", [len(moving.length), fill(1)]);
        moving.forEach((line, i) =>
          s.text(strip!.x, strip!.y + i, truncate(line, strip!.w), style(c.mutedFg, c.bg), strip!.x + strip!.w),
        );
        body = rest!;
      }
      // A short terminal drops the last figures before it drops the list.
      const shown = figures.slice(0, Math.max(0, body.h - FIGURES_ROOM));
      if (shown.length > 0) {
        const [strip, rest] = split(body, "v", [len(shown.length), fill(1)]);
        shown.forEach((line, i) =>
          s.text(strip!.x, strip!.y + i, truncate(line, strip!.w), style(c.mutedFg, c.bg), strip!.x + strip!.w),
        );
        body = rest!;
      }
      if (panelLines.length > 0) {
        const [strip, rest] = split(body, "v", [len(1), fill(1)]);
        s.text(strip!.x, strip!.y, truncate(panelLines[0]!, strip!.w), style(c.mutedFg, c.bg), strip!.x + strip!.w);
        body = rest!;
      }
      if (decider !== null) {
        const [strip, rest] = split(body, "v", [len(1), fill(1)]);
        s.text(
          strip!.x,
          strip!.y,
          truncate(`${decider}  C lists`, strip!.w),
          style(c.mutedFg, c.bg),
          strip!.x + strip!.w,
        );
        body = rest!;
      }
      if (forge !== undefined) {
        const lines = forge.length === 0 ? ["All fine"] : withMore(forge, 3);
        if (lane !== null) lines.push(`Lane: ${lane}`);
        if (flaky !== null) lines.push(`Flaky this week: ${flaky}`);
        const [strip, rest] = split(body, "v", [len(lines.length), fill(1)]);
        lines.forEach((line, i) =>
          s.text(
            strip!.x,
            strip!.y + i,
            truncate(line, strip!.w),
            style(forge!.length === 0 ? c.mutedFg : c.fg, c.bg),
            strip!.x + strip!.w,
          ),
        );
        body = rest!;
      }
      if (waits.length > 0) {
        const lines = withMore(waits, 3);
        const [strip, rest] = split(body, "v", [len(lines.length), fill(1)]);
        lines.forEach((line, i) =>
          s.text(strip!.x, strip!.y + i, truncate(line, strip!.w), style(c.fg, c.bg), strip!.x + strip!.w),
        );
        body = rest!;
      }
      const { main, aside, stacked } = beside(body, ctx.twoPane, {
        main: fill(3),
        aside: fill(2),
      });
      // Decide what is on screen before drawing any of it: the focus ring is
      // painted by the draws, and a window that just shrank may have taken
      // the focused pane away, in which case the cursor lands on the
      // repositories, which are always there.
      const here = new Set<PaneId>(["repos"]);
      if (aside !== undefined && f.signedIn) here.add("onyou");
      if (aside !== undefined && !stacked && f.signedIn) here.add("machine");
      drawn = here;
      if (!here.has(focus)) focus = "repos";

      // A site admin is told once, under the filter, when the forge runs
      // with less than its default protection — the web footer's line.
      const read = exploring() ? readExploreLine(filter.query) : undefined;
      const note = read === undefined ? "" : exploreNote(read.unknown);
      const mend = exploring() ? exploreSuggestion(filter.query) : undefined;
      const readAs =
        read === undefined
          ? undefined
          : `Read as: ${exploreLine(read.query) || "everything"}${mend === undefined ? "" : ` · Did you mean ${mend.line}?`}${note === "" ? "" : ` · ${note}`}`;
      const reduced = readAs ?? (f.user?.isAdmin === true ? protectionNotice() : undefined);
      const [box, warn, list] = split(
        main,
        "v",
        reduced === undefined
          ? [len(1), len(0), fill(1)]
          : [len(1), len(1), fill(1)],
      );
      ctx.setCursor(filter.render(s, box!, c, "find a repository"));
      if (reduced !== undefined)
        s.text(
          warn!.x,
          warn!.y,
          truncate(reduced, warn!.w),
          style(c.attn, c.bg),
          warn!.x + warn!.w,
        );
      drawRepos(s, list!, c, set);
      if (aside === undefined) return;
      if (!f.signedIn) {
        drawMachine(s, aside, c, set);
        return;
      }
      if (stacked) {
        drawOnYou(s, aside, c, set);
        return;
      }
      const [onYouArea, machine] = split(aside, "v", [fill(1), len(8)]);
      drawOnYou(s, onYouArea!, c, set);
      drawMachine(s, machine!, c, set);
    },
    key(e) {
      if (filter.key(e)) {
        syncExplore();
        at("repos").clamp(exploring() ? exploredRows().length : shown().length);
        focus = "repos";
        return true;
      }
      if (e.key === "tab") {
        cycle(e.shift ? -1 : 1);
        return true;
      }
      if (at(focus).key(e, size(focus))) return true;
      if (e.key === "enter") {
        openHere();
        return true;
      }
      if (focus === "onyou" && f.user !== undefined) {
        const item = onYou[at("onyou").index];
        if (e.key === "space" && item !== undefined && item.hand !== true) {
          if (!marked.delete(item.issue.id)) marked.add(item.issue.id);
          return true;
        }
        if (e.key === "x") return closeSet(), true;
        if (e.key === "Z") return archiveStale(), true;
        if (e.key === "m") return clear("mute"), true;
        if (e.key === "S") return shipSet(), true;
        if (e.key === "D" && item !== undefined) return handToDecider(), true;
        if (e.key === "b" && item !== undefined) return giveBackHere(), true;
        if (e.key === "h") return hideAuthor(), true;
        if (e.key === "y") return actOnWave("approve"), true;
        if (e.key === "R") return redirectWave(), true;
        if (e.key === "l") return actOnWave("later"), true;
      }
      if (e.key === "B" && f.user && asideWaves.length > 0) return bringBackWaves(), true;
      if (focus === "repos" && f.user !== undefined && exploring() && (e.key === "space" || e.key === "a" || e.key === "p")) {
        ctx.toast("pin, mark and archive act on your repositories; esc clears the explorer line", "attn");
        return true;
      }
      if (focus === "repos" && f.user !== undefined) {
        const repo = shown()[at("repos").index];
        if (e.key === "space" && repo !== undefined && mayArchive(repo)) {
          if (!markedRepos.delete(repo.id)) markedRepos.add(repo.id);
          ctx.invalidate();
          return true;
        }
        if (e.key === "a") return archiveMarked(), true;
      }
      if (e.key === "u" && f.user) {
        if (lastArchive !== undefined) return undoArchive(), true;
        return undoSet(), true;
      }
      if (e.key === "U" && f.user) return undoHand(), true;
      if (e.key === "L" && f.user) return listenAgain(), true;
      if (e.key === "C" && f.user) return ctx.push(deciderScreen(f, ctx)), true;
      if (e.key === "P" && f.user) return showPeople(), true;
      if (f.user && e.key >= "1" && e.key <= String(KIND_CHIPS.length))
        return toggleChip(Number(e.key) - 1), true;
      if (e.key === "d" && focus === "machine") {
        unpin(pins[at("machine").index]);
        return true;
      }
      if (e.key === "p" && f.user) {
        const repo = shown()[at("repos").index];
        if (!repo) return true;
        const wanted = !pinned.has(repo.id);
        const done = wanted
          ? pinRepo(f.app, f.user, repo)
          : unpinRepo(f.app, f.user, repo);
        if (!done.ok && wanted) ctx.toast(errorText(done.error), "danger");
        else {
          reload();
          ctx.toast(wanted ? "pinned" : "unpinned", "success");
        }
        return true;
      }
      if (e.key === "t" && f.user && clientLines.length > 0) {
        // A client's apps are the list; the one under the cursor is asked.
        const repo = shown()[at("repos").index];
        if (repo && clientRepoIds.has(repo.id)) askForSomething(f, ctx, () => screen, repo);
        return true;
      }
      if (e.key === "o" && f.user && clientLive.size > 0) {
        // The running app under the cursor, as a link the person can open or copy.
        const repo = shown()[at("repos").index];
        const live = repo && clientLive.get(repo.id);
        if (live) ctx.push(linkScreen(ctx, live, screen));
        return true;
      }
      if (e.key === "n" && f.signedIn) {
        ctx.push(newRepoScreen(f, ctx));
        return true;
      }
      if (e.key === "M" && f.signedIn) {
        ctx.push(migrateScreen(f, ctx));
        return true;
      }
      if (e.key === "W" && asksLine !== undefined) {
        openOnWeb(f, ctx, "/asks", "Asks");
        return true;
      }
      if (e.key === "E" && everyday?.asking === true) {
        openOnWeb(f, ctx, "/settings", "Making your everyday account");
        return true;
      }
      if (e.key === "K" && everyday?.asking === true) return keepAdminHere(), true;
      if (e.key === "A" && f.user) {
        openOnWeb(f, ctx, "/settings", "Account settings");
        return true;
      }
      if (e.key === "s" && !f.signedIn) {
        ctx.push(signInScreen(f, ctx, reload));
        return true;
      }
      if (e.key === "r") {
        runAsync(ctx, async () => reload());
        return true;
      }
      return false;
    },
  };

  // ---- the panes ----

  /** The inbox: what is assigned to this account, across every repository. */
  function drawOnYou(s: Surface, r: Rect, c: Tokens, set: IconSet): void {
    const on = focus === "onyou";
    const footer = onYouFooter();
    const frame = card(s, r, c, {
      title: `${icon("person", set)} ${TITLES.onyou}`,
      focused: on,
      ...(footer === undefined ? {} : { footer }),
    });
    // The week's asks lead the pane, muted; absent when all four are 0, so the list sits where it did.
    let inner = frame;
    if (asksLine !== undefined && frame.h > 1) {
      s.text(frame.x, frame.y, truncate(asksLine, frame.w), style(c.mutedFg, c.bg), frame.x + frame.w);
      inner = { ...frame, y: frame.y + 1, h: frame.h - 1 };
    }
    if (onYou.length + waves.length === 0) {
      note(s, inner, c, [
        silenced.size > 0
          ? "Nothing is on you outside muted repositories."
          : "Nothing is assigned to you.",
      ]);
      return;
    }
    drawList(
      s,
      inner,
      c,
      at("onyou"),
      [
        ...onYou.map((item): ListRow => {
        const mark =
          set === "nerd"
            ? icon(item.issue.kind === "pull" ? "pull" : "issue", set)
            : item.issue.kind === "pull"
              ? PULL_MARK
              : ISSUE_MARK;
        return {
          title: `${marked.has(item.issue.id) ? "[x] " : ""}${item.hand === true ? "parked " : item.over === true ? "handed over " : item.late !== undefined ? "waiting " : ""}${mark} #${item.issue.number} ${item.issue.title} · ${item.repo.ownerName}/${item.repo.name}`,
          ...(onYouSteps.has(item.issue.id) ? { note: onYouSteps.get(item.issue.id)! } : {}),
          meta: `${item.waiting.word} · on ${item.waiting.on}${item.passed === undefined ? "" : ` · handed to you: ${item.passed}`}${item.late?.advice ?? item.overAdvice ?? ""}`,
        };
      }),
        ...waves.map(
          (w): ListRow => ({
            title: `wave ${w.proposal.title} · ${w.repo.ownerName}/${w.repo.name}`,
            meta: "waits for your nod · y approve · R redirect · l later",
          }),
        ),
      ],
      on,
    );
    hitList(ctx, inner, at("onyou"), onYou.length + waves.length, {
      select: () => {
        focus = "onyou";
      },
      open: (index) => {
        focus = "onyou";
        openAssigned(onYou[index]);
      },
    });
  }

  /** What the card says about mutes, marks and the day's undo. */
  function onYouFooter(): string | undefined {
    const parts: string[] = [];
    // The same figures as Home's line and /review: live asks counted, stale ones folded apart.
    if (waitingSet !== undefined && waitingSet.count > 0) parts.push(`${waitingSet.count} waiting on you`);
    if (waitingSet !== undefined && waitingSet.stale.length > 0) parts.push(`${staleWords(waitingSet.stale.length)} Z previews`);
    // The decider keys come first: the card clips its footer from the right.
    // A pass's reason leads the line: a row's meta is dropped where the pane is narrow.
    const passed = onYou[at("onyou").index]?.passed;
    if (passed !== undefined) parts.push(`handed to you: ${passed.length > 60 ? `${passed.slice(0, 59)}…` : passed}`);
    if (lastHand !== undefined) parts.push("U undo decider");
    if (onYou[at("onyou").index]?.hand === true) parts.push("D let the decider");
    if (onYou[at("onyou").index]?.over === true || onYou[at("onyou").index]?.passed !== undefined) parts.push("b give back to the crew");
    if (f.user !== undefined) {
      const chips = chipsOf(f.db, f.user.id);
      const off: string[] = KIND_CHIPS.filter((k) => chips.kinds.has(k));
      if (chips.people.size > 0) off.push(`${chips.people.size} people`);
      parts.push(
        off.length > 0
          ? `off: ${off.join(", ")} · 1-4 chips · h hide author${chips.people.size > 0 ? " · P people" : ""}`
          : "1-4 chips · h hide author",
      );
    }
    if (asksLine !== undefined) parts.push("W asks on the web");
    if (marked.size > 0) parts.push(`${marked.size} marked`);
    if (silenced.size > 0)
      parts.push(
        `${silenced.size} ${silenced.size === 1 ? "repository" : "repositories"} muted · L listen again`,
      );
    if (lastSet !== undefined) parts.push(`u undo ${lastSet.verb}`);
    if (asideWaves.length > 0) parts.push(`${asideWaves.length} ${asideWaves.length === 1 ? "wave" : "waves"} put aside · B bring back`);
    return parts.length > 0 ? parts.join(" · ") : undefined;
  }

  /** A row's numbers as the page says them; nothing that is zero. */
  function numbersOf(row: ExploreRow): string {
    const n = row.numbers;
    return metaOf(
      row.kind === "person" ? plural(n.apps, "app") : "",
      n.forks > 0 ? plural(n.forks, "fork") : "",
      n.likes > 0 ? plural(n.likes, "like") : "",
      n.ships > 0 ? `${n.ships} shipped this month` : "",
      n.awakeHours > 0 ? `${n.awakeHours} h in use` : "",
      row.shippedAt !== null ? `shipped ${ago(row.shippedAt)}` : "",
    );
  }

  function drawExplored(s: Surface, r: Rect, c: Tokens): void {
    const rows = exploredRows();
    const on = focus === "repos";
    if (rows.length === 0) {
      emptyState(s, r, c, {
        title: explored === undefined ? "Ranking…" : `Nothing matches ${explored.line}`,
        body: "Drop a word to step back; esc clears the line.",
      });
      return;
    }
    drawList(
      s,
      r,
      c,
      at("repos"),
      rows.map((row): ListRow => ({ title: row.name, secondary: row.description, meta: numbersOf(row) })),
      on,
    );
    hitList(ctx, r, at("repos"), rows.length, {
      select: () => {
        focus = "repos";
      },
      open: (index) => {
        focus = "repos";
        openExplored(rows[index]);
      },
    });
  }

  function drawRepos(s: Surface, r: Rect, c: Tokens, set: IconSet): void {
    if (exploring()) return drawExplored(s, r, c);
    const rows = shown();
    const on = focus === "repos";
    if (rows.length === 0) {
      emptyState(s, r, c, {
        title: f.signedIn ? "No repositories yet" : "Nothing public yet",
        body: f.signedIn
          ? "Press n for a new repository, or / to find one."
          : "Press s to sign in, or / to find one.",
      });
      return;
    }
    // The counts come off `listReposVisibleTo`, which fills them in one
    // grouped query for the whole page — never one per row.
    const counts = countsColumn(
      rows.map((repo) => repo.counts),
      set,
    );
    drawList(
      s,
      r,
      c,
      at("repos"),
      rows.map(
        (repo): ListRow => ({
          title: `${markedRepos.has(repo.id) ? "[x] " : ""}${repoMark(pinned.has(repo.id), set)}${repo.ownerName}/${repo.name}`,
          secondary: holds.get(repo.id) ?? repo.description,
          meta: metaOf(
            repo.visibility === "private" ? "private" : "",
            counts(repo.counts),
          ),
        }),
      ),
      on,
    );
    hitList(ctx, r, at("repos"), rows.length, {
      select: () => {
        focus = "repos";
      },
      open: (index) => {
        focus = "repos";
        openRepo(rows[index]);
      },
    });
  }

  function drawMachine(s: Surface, r: Rect, c: Tokens, set: IconSet): void {
    const on = focus === "machine";
    if (!f.signedIn) {
      note(s, card(s, r, c, { title: "Sign in" }), c, [
        "s   sign in with a username and password",
        "    (your key is linked, so next time is instant)",
      ]);
      return;
    }
    const inner = card(s, r, c, {
      title: `${icon("pin", set)} ${TITLES.machine}`,
      // The command that acts on this list, on the card that shows it.
      footer: "forge sync",
      focused: on,
    });
    if (pins.length === 0) {
      note(s, inner, c, [
        "Nothing pinned yet.",
        "p pins the repository under the cursor;",
        'for forge sync, see docs/ON-YOUR-MACHINE.md.',
      ]);
      return;
    }
    drawList(
      s,
      inner,
      c,
      at("machine"),
      pins.map(
        (pin): ListRow => ({
          title: `${repoMark(true, set)}${pin.ownerName}/${pin.name}`,
        }),
      ),
      on,
    );
    hitList(ctx, inner, at("machine"), pins.length, {
      select: () => {
        focus = "machine";
      },
      open: (index) => {
        focus = "machine";
        openPin(pins[index]);
      },
    });
  }

  return screen;
}

/** Why the builders are idle, as the one line an admin's home reads; none while they are not. */
function idleLines(app: App, now: Date): string[] {
  const reason = idleReason(app, now);
  return reason === null ? [] : [idleLine(reason)];
}

/**
 * The mark a repository row wears.
 *
 * `◆` has meant "kept on this machine" since the where-strip was written
 * (`docs/DESIGN.md`), and an unpinned row wears nothing — a column of marks
 * that are all the same says nothing. A Nerd Font session gets the real
 * nouns instead, because there the two glyphs are actually different
 * pictures rather than two shapes from the same small alphabet.
 */
function repoMark(isPinned: boolean, set: IconSet): string {
  if (set === "nerd") return `${icon(isPinned ? "pin" : "repo", set)} `;
  return isPinned ? `${PIN_MARK} ` : "";
}

/** Plain lines in a card — what a pane says when it has no rows. */
function note(s: Surface, r: Rect, c: Tokens, lines: readonly string[]): void {
  lines
    .slice(0, r.h)
    .forEach((line, i) =>
      s.text(
        r.x,
        r.y + i,
        truncate(line, r.w),
        style(c.mutedFg, c.card),
        r.x + r.w,
      ),
    );
}
