/**
 * What the open read hooks hand out (#1789), built once so the page, the API
 * and the MCP tools say the same thing: the pipeline (flow), the machine
 * (system), the boards' sources (names and columns, never rows) and the
 * node's history. Everything here is counts, rates and names of public
 * things — no sealed value, no private repository's content, no person.
 */
import { readRepeats } from "../flow/repeats.ts";
import { readVerdicts } from "../flow/culprits.ts";
import type { App } from "../app.ts";
import { SOURCES } from "../boards/sources.ts";
import { conflictedPulls, conflictedSays, rebaseLane, rebaseLaneSays } from "../flow/conflicted.ts";
import { firedAlarms } from "../flow/alarms.ts";
import { forgeCeiling } from "../flow/ceiling.ts";
import { running } from "../kernel/version.ts";
import { readTalkTurns, talkTurnsWords } from "../flow/talk_turns.ts";
import { readTalkResumes, talkResumesWords } from "../flow/talk_resumes.ts";
import { readVitals, vitalsFor, vitalsLine, vitalsMisses } from "../flow/vitals.ts";
import { parkedSays, readParked } from "../flow/parked.ts";
import { readDeclines } from "../flow/declines.ts";
import { readKeeper } from "../flow/keeper.ts";
import { heartbeatOf } from "../keeper/landed.ts";
import { readPipeline, readStepStats, statWords, verdict } from "../flow/pipeline.ts";
import { type QueueReading, readQueues } from "../flow/queue.ts";
import { reviewersBusy, reviewingSays } from "../flow/reviewing.ts";
import { requestedSays, requestedWaits } from "../flow/requested.ts";
import { readThroughput, stageOut, throughputSays } from "../flow/throughput.ts";
import { readVerified, verifiedSays } from "../flow/verified.ts";
import type { Reader } from "../actions/telemetry.ts";
import { agentView, live } from "./live.ts";
import type { SystemView } from "./view.ts";
import { readerPaces, type ReaderPace } from "./telemetry_reads.ts";
import { featureHealth, type FeatureHealth } from "./feature_health.ts";

export function systemFor(app: App, reader: Reader): SystemView {
  const view = live().read();
  return reader.kind === "agent" ? agentView(app, view) : view;
}

/**
 * The system answer for the API and the MCP tool: the view plus `readers`, the
 * rows /system draws (#9088). Names are accounts, so only a telemetry reader gets
 * here. Call it before `countRead` so the read does not count into its own answer.
 */
export function systemWithReaders(app: App, reader: Reader): SystemView & { readers: ReaderPace[]; features: FeatureHealth[] } {
  return { ...systemFor(app, reader), readers: readerPaces(), features: featureHealth(app, reader) };
}

/**
 * The pipeline answer as a generator that yields between its heavy reads, so a
 * caller may run each slice on its own turn of the loop (#8978); `flowFor`
 * drives it to the end at once.
 */
// Dollars only for the owner and an agent holding telemetry:read (#6424): see vitals below.
export function* flowSlices(app: App, reader: Reader, now = new Date()): Generator<void, ReturnType<typeof flowBody>, void> {
  const stages = readPipeline(app.db, now);
  yield;
  const flow = readThroughput(app.db, stages.map((s) => s.key), now);
  yield;
  const dup = systemFor(app, reader).duplicates;
  yield;
  const conflicted = conflictedPulls(app.db, reader.kind === "agent");
  const lane = rebaseLane(app.db, conflicted);
  yield;
  const requested = requestedWaits(app.db, reader.kind === "agent");
  const busy = reviewersBusy(app.db, reader.kind === "agent");
  yield;
  const vitals = vitalsFor(readVitals(app.db, now, reader.kind === "agent"), reader.kind === "owner" || reader.spend === true);
  yield;
  const talk = readTalkResumes(app.db, running().version);
  const talkTurns = readTalkTurns(app.db);
  const parked = readParked(app.db, now, reader.kind === "agent");
  yield;
  const steps = readStepStats(app.db, now, reader.kind === "agent");
  yield;
  const verified = readVerified(app, reader.kind === "owner");
  yield;
  const redBatches = readVerdicts(app.db, now, reader.kind === "agent");
  yield;
  const reviewRepeats = readRepeats(app.db, "", now, reader.kind === "agent");
  yield;
  return flowBody({ app, reader, now, stages, flow, dup, conflicted, lane, requested, busy, vitals, talk, talkTurns, parked, steps, verified, redBatches, reviewRepeats });
}

export function flowFor(app: App, reader: Reader, now = new Date()) {
  const g = flowSlices(app, reader, now);
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

function flowBody(x: {
  app: App; reader: Reader; now: Date; stages: ReturnType<typeof readPipeline>; flow: ReturnType<typeof readThroughput>;
  dup: ReturnType<typeof systemFor>["duplicates"]; conflicted: ReturnType<typeof conflictedPulls>; lane: ReturnType<typeof rebaseLane>;
  requested: ReturnType<typeof requestedWaits>; busy: ReturnType<typeof reviewersBusy>; vitals: ReturnType<typeof vitalsFor>;
  talk: ReturnType<typeof readTalkResumes>; talkTurns: ReturnType<typeof readTalkTurns>; parked: ReturnType<typeof readParked>;
  steps: ReturnType<typeof readStepStats>; verified: ReturnType<typeof readVerified>; redBatches: ReturnType<typeof readVerdicts>;
  reviewRepeats: ReturnType<typeof readRepeats>;
}) {
  const { app, reader, now, stages, flow, dup, conflicted, lane, requested, busy, vitals, talk, talkTurns, parked } = x;
  return {
    says: verdict(stages, now.getTime()),
    // Each step of the path: median time and red rate over 30 days (#7784); private repositories for the owner only.
    steps: x.steps.map((m) => ({ ...m, says: statWords(m) })),
    // The cause binding landings now and the keeper's last act (#7645).
    keeper: readKeeper(app.db, reader.kind === "owner"),
    // The release tick's last report, reason and all, for the owner only (#11507): the reason may name private work.
    heartbeat: reader.kind === "owner" ? heartbeatOf(app.db, now) : null,
    // How long each main has gone unverified after landing (#7786); private repositories for the owner only.
    verified: x.verified.map((row) => ({ ...row, says: verifiedSays(row, now.getTime()) })),
    // Issues the crew parked in the last 24 h and 7 d, the newest three named (#6471).
    parked: { says: parkedSays(parked), ...parked },
    // Open pulls, opened and landed in 1 h and 6 h, and conflicted, against #5924's targets (#5935).
    // A fallback after a release is a line here, not a banner (#8795).
    vitals: { says: [vitalsLine(vitals), talkResumesWords(talk), talkTurnsWords(talkTurns)].filter((w) => w !== "").join(" · "), talk, talkTurns, misses: vitalsMisses(vitals), ...vitals },
    // What the last red batches were: the pull named and returned with its failing tests, or a load red (#7639).
    redBatches: x.redBatches,
    // Findings reviewers repeated, proposed as checks and retired, beside review comments per pull (#8716).
    reviewRepeats: x.reviewRepeats,
    // Declined build runs of the last 24 h by reason, each with the runs behind it.
    declines: readDeclines(app.db, now, reader.kind === "agent"),
    // The four alarms (#5930) that are firing now; empty when none is.
    alarms: firedAlarms(app.db, now, { publicOnly: reader.kind === "agent", dataDir: app.config.dataDir, ceilingUsd: forgeCeiling(app.config) }),
    // Review runs in flight per reviewer, cut to public repositories for an agent (#4733).
    reviewing: { says: reviewingSays(busy), reviewers: busy },
    conflicted: { says: conflictedSays(conflicted, now.getTime()), pulls: conflicted },
    // conflicted N, rebasing M, room R: a stall in the lane reads in a minute (#6140).
    rebases: { ...lane, says: rebaseLaneSays(lane) },
    // Pulls with changes requested, by whom they wait on (#2172).
    requested: {
      builder: { says: requestedSays(requested.builder, "builder", now.getTime()), pulls: requested.builder },
      reviewer: { says: requestedSays(requested.reviewer, "reviewer", now.getTime()), pulls: requested.reviewer },
    },
    stages,
    throughput: {
      says: throughputSays(flow),
      medianAskToLiveMs: flow.medianAskToLiveMs,
      stages: flow.stages.map(stageOut),
    },
    // A private repository's name is not an agent's to read, so its queue line is cut.
    queue: queuesFor(app, reader, now),
    duplicateWork: dup,
  };
}

/** The merge queue as `reader` may see it: an agent's has private repositories cut out. */
export function queuesFor(app: App, reader: Reader, now = new Date(), reading: QueueReading = {}) {
  return readQueues(app.db, now, reading).filter((q) => reader.kind === "owner" || publicRepo(app, q.repo));
}

function publicRepo(app: App, full: string): boolean {
  const [owner, name] = full.split("/");
  return (
    app.db
      .query<{ v: string }, [string, string]>(
        "SELECT r.visibility AS v FROM repo r JOIN user u ON u.id = r.owner_id WHERE u.username = ?1 AND r.name = ?2",
      )
      .get(owner ?? "", name ?? "")?.v === "public"
  );
}

export function sourcesOut() {
  return Object.entries(SOURCES).map(([name, s]) => ({
    name,
    time: s.time,
    columns: s.columns,
    ...(s.docs ? { docs: s.docs } : {}),
  }));
}

/** The node's 15-s points for the last hour: the `machine` source's `node` and `forge` targets, nothing per-cell. */
export function historyFor(app: App) {
  return historyOver(app, 1);
}

/** Most points one series carries in `historyOver`. */
export const HISTORY_POINTS = 300;

type HistoryPoint = {
  target: string;
  at: string;
  cpuCores: number | null;
  /** The busiest sample in the bucket, so a short spike survives the averaging. */
  cpuCoresMax: number | null;
  memoryBytes: number | null;
  load: number | null;
};

/**
 * The same points over the last `hours` (15-s steps inside the day, 5-min beyond it), each target
 * averaged down to at most `HISTORY_POINTS`, so the answer is bounded however long the window.
 */
export function historyOver(app: App, hours: number) {
  const step = hours <= 24 ? 15 : 300;
  const rows = app.db
    .query<
      { target: string; at: string; cpu_cores: number | null; cpu_cores_max: number | null; memory_bytes: number | null; load: number | null },
      [number, string]
    >(
      `SELECT target, at, cpu_cores, cpu_cores_max, memory_bytes, load FROM machine_sample
        WHERE step = ?1 AND target IN ('node','forge')
          AND at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?2) ORDER BY at, target`,
    )
    .all(step, `-${hours} hours`)
    .map((r) => ({
      target: r.target,
      at: r.at,
      cpuCores: r.cpu_cores,
      cpuCoresMax: r.cpu_cores_max ?? r.cpu_cores,
      memoryBytes: r.memory_bytes,
      load: r.load,
    }));
  const mean = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x !== null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const out: HistoryPoint[] = [];
  for (const target of ["node", "forge"]) {
    const own = rows.filter((r) => r.target === target);
    const size = Math.ceil(own.length / HISTORY_POINTS) || 1;
    for (let i = 0; i < own.length; i += size) {
      const g = own.slice(i, i + size);
      out.push({
        target,
        at: g[0]!.at,
        cpuCores: mean(g.map((r) => r.cpuCores)),
        cpuCoresMax: g.reduce<number | null>((m, r) => (r.cpuCoresMax === null ? m : Math.max(m ?? -Infinity, r.cpuCoresMax)), null),
        memoryBytes: mean(g.map((r) => r.memoryBytes)),
        load: mean(g.map((r) => r.load)),
      });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.target < b.target ? -1 : 1));
}

export const WELCOME_LABEL = "help wanted";

/** What an agent that arrives should know: what this is, where it hurts, what welcomes it, how to propose. */
export function welcome(app: App, now = new Date()) {
  const stages = readPipeline(app.db, now);
  const issues = app.db
    .query<{ owner: string; name: string; number: number; title: string }, [string]>(
      `SELECT u.username AS owner, r.name AS name, i.number AS number, i.title AS title
         FROM issue i JOIN repo r ON r.id = i.repo_id JOIN user u ON u.id = r.owner_id
         JOIN issue_label il ON il.issue_id = i.id JOIN label l ON l.id = il.label_id
        WHERE i.kind = 'issue' AND i.state = 'open' AND r.visibility = 'public'
          AND i.sealed = 0
          AND l.name = ?1 COLLATE NOCASE
        ORDER BY i.updated_at DESC LIMIT 20`,
    )
    .all(WELCOME_LABEL);
  return {
    forge:
      "A forge that runs what it hosts: git, issues, pulls, a crew of agents and the apps they build, in the open. Every pull gets a preview; every push is judged by the same check.",
    bottleneck: { says: verdict(stages, now.getTime()), see: "GET /api/v1/telemetry/flow or the MCP flow tool (any agent granted telemetry:read); the owner sees it on /boards" },
    welcomeLabel: WELCOME_LABEL,
    issues: issues.map((i) => ({
      repo: `${i.owner}/${i.name}`,
      number: i.number,
      title: i.title,
      path: `/${i.owner}/${i.name}/issues/${i.number}`,
    })),
    propose: [
      "Make an account (POST /api/v1/users or /signup) and confirm its email, or attach as your person through OAuth at /mcp. A new account is a guest: it can read, comment and help build public repositories.",
      "Fork the repository (MCP tool fork, POST /api/v1/repos/{owner}/{name}/forks, or Help build this) and change your fork with the MCP tool write_file or plain git over HTTPS with your token.",
      "Open a pull from your fork against the default branch (MCP tool open_pull, or POST /api/v1/repos/{owner}/{name}/pulls with headRepo). From someone who cannot write here it runs nothing until a person approves that head; then it runs in the same isolated cell as the crew's, with none of the forge's data or secrets.",
      "A person reviews it. It lands only through the gate everything passes: `bun x tsc --noEmit` and `bun test` green, a test for every behaviour you add, zero new dependencies without a reason.",
      "To run your own apps and crew, deploy your own forge: the MCP tool spawn, or /forges/new.",
      "Anyone may propose. The bar decides what merges. A person lands it; an agent never does.",
    ],
    telemetry:
      "Ask the owner for the telemetry:read grant to read the pipeline (flow) and the machine (system) from the API (/api/v1/telemetry/flow, /api/v1/telemetry/system) and MCP (tools flow, system), with private repositories and sealed values cut out. Every read is logged.",
  };
}
