/**
 * The routing decision: a sentence arrives — told in the studio, or picked
 * off the map by a repository running on its own — and three things are
 * decided before a builder starts: who takes it, how big it is, what kind
 * of thing it is. One fixed-choice question each, answered by the forge's
 * decider when there is one and by the rules otherwise (`crew/decide.ts`).
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import type { Agent, CrewRole } from "../core/agents.ts";
import type { Issue } from "../core/issues.ts";
import type { Repo } from "../core/repos.ts";
import { certain, decideOr, type Answers, type Questions } from "./decide.ts";
import { markReaders } from "./direct.ts";

export const SIZES = ["tiny", "small", "large"] as const;
export type Size = (typeof SIZES)[number];
export const KINDS = ["bug", "feature", "question", "chore"] as const;
export type Kind = (typeof KINDS)[number];

export interface Routed {
  readonly builder: Agent;
  readonly size: Size;
  readonly kind: Kind;
  /** Who decided: a decider's name, or `rule`. */
  readonly by: string;
  readonly ms: number;
  /** How sure the decider was of the builder, 0–1; 1 for a rule. */
  readonly p: number;
}

/**
 * The rule for who takes an issue: its own assignee when that is a builder
 * here, else the builder with the least in flight, then by name.
 */
export function pickBuilder(
  issue: Issue,
  builders: readonly Agent[],
  inFlight: ReadonlyMap<string, number>,
): Agent | undefined {
  if (builders.length === 0) return undefined;
  const own = builders.find((b) => b.user.id === issue.assigneeId);
  if (own) return own;
  return [...builders].sort(
    (a, b) =>
      (inFlight.get(a.user.id) ?? 0) - (inFlight.get(b.user.id) ?? 0) ||
      a.user.username.localeCompare(b.user.username),
  )[0];
}

/**
 * Who takes an issue given the decider's preference: a ranking, not an
 * exclusive pick. The most preferred builder with nothing in flight takes
 * it — one agent runs one thing at a time, so a busy favourite would leave
 * the other slots empty (#7006) — and with every builder busy, the most
 * preferred. Ties keep the decider's choice first, then the crew's order.
 */
export function rankedBuilder(
  builders: readonly Agent[],
  preference: Readonly<Record<string, number>>,
  choice: string,
  inFlight: ReadonlyMap<string, number>,
): Agent | undefined {
  const score = (b: Agent) => (b.user.username === choice ? Infinity : 0);
  const ranked = [...builders].sort(
    (a, b) =>
      (preference[b.user.username] ?? 0) - (preference[a.user.username] ?? 0) || score(b) - score(a),
  );
  return ranked.find((b) => (inFlight.get(b.user.id) ?? 0) === 0) ?? ranked[0];
}

/** The rule for size: how much was said, roughly how much there is to do. */
export function sizeByWords(text: string): Size {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((w) => w !== "").length;
  return words < 12 ? "tiny" : words < 60 ? "small" : "large";
}

/** The rule for kind: a few words that mean a bug, else a feature. */
export function kindByWords(text: string): Kind {
  const t = text.toLowerCase();
  if (/\b(bug|broken|crash|error|fails?|doesn'?t work|wrong|fix)\b/.test(t))
    return "bug";
  if (/\?\s*$/.test(t.trim()) || /^\s*(why|how|what|is|does|can)\b/.test(t))
    return "question";
  if (/\b(rename|upgrade|bump|clean|refactor|tidy|remove|delete)\b/.test(t))
    return "chore";
  return "feature";
}

/** What the decider is told: the sentence, the place, the people. */
export function routingState(
  db: Database,
  repo: Repo,
  issue: Issue,
  crew: readonly { agent: Agent; role: CrewRole }[],
): Record<string, unknown> {
  // A reader's words are read here too, so they carry the brief's mark.
  const { untrusted } = markReaders(db, repo, [issue])[0]!;
  return {
    repository: `${repo.ownerName}/${repo.name}${repo.description ? ` — ${repo.description}` : ""}`,
    told: issue.title,
    ...(issue.body.trim() === ""
      ? {}
      : { details: issue.body.trim().slice(0, 1200) }),
    ...(untrusted === undefined ? {} : { untrusted }),
    crew: crew.map((c) => ({
      name: c.agent.user.username,
      role: c.role,
      ...(c.agent.brief === ""
        ? {}
        : { brief: c.agent.brief.split("\n")[0]!.slice(0, 200) }),
    })),
  };
}

/**
 * Decide who takes an issue, how big it is and what kind it is. `builders`
 * are the crew members who build here; with none, there is nobody to route
 * to and the answer is undefined.
 */
export async function routeIssue(
  app: App,
  repo: Repo,
  issue: Issue,
  crew: readonly { agent: Agent; role: CrewRole }[],
  inFlight: ReadonlyMap<string, number>,
): Promise<Routed | undefined> {
  const builders = crew.filter((c) => c.role === "builder").map((c) => c.agent);
  const byRule = pickBuilder(issue, builders, inFlight);
  if (byRule === undefined) return undefined;
  const names = builders.map((b) => b.user.username);
  const text = `${issue.title}\n${issue.body}`;
  const questions = {
    builder: {
      options: names,
      about: "Which builder should take what was told, given what each is for.",
      describe: Object.fromEntries(
        builders.map((b) => [
          b.user.username,
          b.brief.split("\n")[0]!.slice(0, 200) || b.user.username,
        ]),
      ),
    },
    size: {
      options: SIZES,
      about: "How much work this is for one run by one builder.",
      describe: {
        tiny: "One line or one file.",
        small: "One feature across a few files.",
        large: "Needs a plan and several runs.",
      },
    },
    kind: {
      options: KINDS,
      about: "What kind of ask this is.",
      describe: {
        bug: "Something that should work does not.",
        feature: "Something new, or something made better.",
        question: "Wants an answer, not a change.",
        chore: "Housekeeping: renames, upgrades, cleanups.",
      },
    },
  } satisfies Questions;
  const rule = (): Answers<typeof questions> => ({
    builder: certain(names, byRule.user.username),
    size: certain(SIZES, sizeByWords(text)),
    kind: certain(KINDS, kindByWords(text)),
  });
  // An issue already carrying a builder's name keeps it: the decider picks
  // for the unassigned, and the rule already honours the assignment.
  const own = builders.find((b) => b.user.id === issue.assigneeId);
  // A sealed report is routed by the rule here, never sent to a decider
  // elsewhere (`core/sealed.ts`).
  const decided = await decideOr(
    own || issue.sealed ? undefined : app.config.decider,
    routingState(app.db, repo, issue, crew),
    questions,
    rule,
  );
  const preferred = decided.answers.builder;
  const builder =
    own ?? rankedBuilder(builders, preferred.probabilities, preferred.choice, inFlight) ?? byRule;
  return {
    builder,
    size: decided.answers.size.choice as Size,
    kind: decided.answers.kind.choice as Kind,
    by: decided.by,
    ms: decided.ms,
    p: own ? preferred.p : (preferred.probabilities[builder.user.username] ?? 0),
  };
}
