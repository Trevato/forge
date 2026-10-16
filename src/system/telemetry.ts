/**
 * What the open read hooks hand out (#1789), built once so the page, the API
 * and the MCP tools say the same thing: the pipeline (flow), the machine
 * (system), the boards' sources (names and columns, never rows) and the
 * node's history. Everything here is counts, rates and names of public
 * things — no sealed value, no private repository's content, no person.
 */
import type { App } from "../app.ts";
import { SOURCES } from "../boards/sources.ts";
import { conflictedPulls, conflictedSays } from "../flow/conflicted.ts";
import { readPipeline, verdict } from "../flow/pipeline.ts";
import { readQueues } from "../flow/queue.ts";
import { readThroughput, stageOut, throughputSays } from "../flow/throughput.ts";
import type { Reader } from "../actions/telemetry.ts";
import { agentView, live } from "./live.ts";
import type { SystemView } from "./view.ts";

export function systemFor(app: App, reader: Reader): SystemView {
  const view = live().read();
  return reader.kind === "agent" ? agentView(app, view) : view;
}

export function flowFor(app: App, reader: Reader, now = new Date()) {
  const stages = readPipeline(app.db, now);
  const flow = readThroughput(app.db, stages.map((s) => s.key), now);
  const dup = systemFor(app, reader).duplicates;
  const conflicted = conflictedPulls(app.db, reader.kind === "agent");
  return {
    says: verdict(stages, now.getTime()),
    conflicted: { says: conflictedSays(conflicted, now.getTime()), pulls: conflicted },
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
export function queuesFor(app: App, reader: Reader, now = new Date()) {
  return readQueues(app.db, now).filter((q) => reader.kind === "owner" || publicRepo(app, q.repo));
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
  return app.db
    .query<
      { target: string; at: string; cpu_cores: number | null; memory_bytes: number | null; load: number | null },
      []
    >(
      `SELECT target, at, cpu_cores, memory_bytes, load FROM machine_sample
        WHERE step = 15 AND target IN ('node','forge')
          AND at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour') ORDER BY at, target`,
    )
    .all()
    .map((r) => ({ target: r.target, at: r.at, cpuCores: r.cpu_cores, memoryBytes: r.memory_bytes, load: r.load }));
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
    bottleneck: { says: verdict(stages, now.getTime()), see: "/flow (the owner's crew and any agent granted telemetry:read)" },
    welcomeLabel: WELCOME_LABEL,
    issues: issues.map((i) => ({
      repo: `${i.owner}/${i.name}`,
      number: i.number,
      title: i.title,
      path: `/${i.owner}/${i.name}/issues/${i.number}`,
    })),
    propose: [
      "Fork the repository (POST /api/v1/repos/{owner}/{name}/forks, or the Fork button) and push a branch to your fork.",
      "Open a pull against the default branch. Your pull runs in the same isolated cell as the crew's: no network beyond what forge.json declares, none of the forge's data or secrets.",
      "The crew's reviewers read it. It lands only through the gate everything passes: `bun x tsc --noEmit` and `bun test` green, a test for every behaviour you add, zero new dependencies without a reason.",
      "Anyone may propose. The bar decides what merges. A person lands it; an agent never does.",
    ],
    telemetry:
      "Ask the owner for the telemetry:read grant to read /flow and /system from the API and MCP (tools flow, system), with private repositories and sealed values cut out. Every read is logged.",
  };
}
