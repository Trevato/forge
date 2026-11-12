/**
 * Triage (#652): the planner places every thought. A person streams
 * thoughts; within minutes each is read as one of five kinds (work, an
 * amendment to an open issue, a vision, a decision, a reversal), acted on
 * in the map, and answered in a line or two under the thought in the feed.
 *
 * The kind, the issue it concerns and the pillar are chosen by the decider
 * among fixed choices (`decide.ts`); a rule answers when it is absent, slow
 * or wrong. Nothing here is a run: it spends no builder slot, and stops
 * where the day's ceiling stops the repository. Thoughts that arrive within
 * `BATCH_MS` of each other are placed together, in the order they came, so
 * a later one that reverses an earlier one sees what the earlier did.
 */

import type { App } from "../app.ts";
import { addComment } from "../actions/issues.ts";
import { openPlan } from "../actions/plan.ts";
import { addDependency, repoGraph } from "../core/dependencies.ts";
import { getIssue, MAX_TITLE, type Issue } from "../core/issues.ts";
import {
  authorsWithUnplaced,
  KINDS,
  savePlacement,
  thoughtAuthor,
  unplaced,
  type Kind,
  type Placed,
  type Placement,
} from "../core/placements.ts";
import { isStructural, pillarsOf, type Pillars } from "../core/pillars.ts";
import { listAutonomousRepos, type Repo } from "../core/repos.ts";
import { getUserById, type User } from "../core/users.ts";
import { createLog } from "../kernel/log.ts";
import { autonomyStatus, ensureDirectionIssue } from "./autonomy.ts";
import { certain, decideOr, type Answers, type Questions } from "./decide.ts";
import { linkThoughts, raiseIssue } from "../core/thought_links.ts";
import { crewOffInPreview } from "./preview.ts";
import { proposeVision } from "./vision.ts";

const log = createLog("triage");

/** Thoughts this close together are placed in one pass. */
export const BATCH_MS = 2 * 60_000;
/** The most thoughts one pass places. */
export const BATCH_MAX = 10;
/** Under this probability the kind is a guess and the reply asks. */
export const SURE = 0.6;
/** A thought older than this is no longer the planner's to place. */
const STALE_MS = 24 * 60 * 60_000;
const OPEN_SHOWN = 40;
const TEXT_SHOWN = 2_000;

const STOP = new Set("the a an and or to of in on for with is are be it this that we i you should would could can will not do so as at by from have has just also".split(" "));
const words = (text: string): Set<string> =>
  new Set((text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []).filter((w) => !STOP.has(w)));
const overlap = (a: Set<string>, b: Set<string>): number => [...a].filter((w) => b.has(w)).length;

interface Open {
  readonly number: number;
  readonly title: string;
}

/** What the rule reads a thought as, with how sure it is. */
export function ruleKind(text: string, hasOpen: boolean): { kind: Kind; p: number } {
  const t = text.toLowerCase();
  if (/\b(actually|never ?mind|scrap (that|this)|forget (that|this|what)|instead of|revert|undo|reverse|stop (doing|building|working)|changed my mind|no longer)\b/.test(t))
    return { kind: "reversal", p: 0.7 };
  if (/\b(vision|direction|long[- ]term|from now on|north star|should become|the goal|where this is going)\b/.test(t))
    return { kind: "vision", p: 0.7 };
  if (/\b(decided|decision|we will|we'll go with|let's go with|go with|the answer is|use \S+ not)\b/.test(t))
    return { kind: "decision", p: 0.7 };
  if (hasOpen && /#\d+\b|\b(also|in addition|while you're at it|one more thing|add to)\b/.test(t))
    return { kind: "amendment", p: 0.65 };
  if (words(text).size < 3) return { kind: "work", p: 0.4 };
  return { kind: "work", p: 0.7 };
}

function targetOf(text: string, open: readonly Open[]): Open | undefined {
  for (const m of text.matchAll(/#(\d+)\b/g)) {
    const hit = open.find((o) => o.number === Number(m[1]));
    if (hit) return hit;
  }
  const mine = words(text);
  let best: Open | undefined;
  let most = 1;
  for (const o of open) {
    const n = overlap(mine, words(o.title));
    if (n > most) (best = o), (most = n);
  }
  return best;
}

/** Words that say an idea can wait. */
const SNOOZE = /\b(someday|some day|maybe later|not now|eventually|nice to have|when we have time|low priority)\b/i;
/** At most this many issues come of one note. */
const IDEAS_MAX = 8;
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+/;

/**
 * The ideas in a dump: its bullets or numbered lines when it has two or more
 * (a line that continues one belongs to it), else its blank-line paragraphs;
 * otherwise the whole text, one idea. An item of under three words is
 * a heading or a stray, and is kept with the one before it.
 */
export function splitIdeas(text: string): string[] {
  const lines = text.split("\n");
  let items: string[] = [];
  if (lines.filter((l) => BULLET.test(l)).length >= 2) {
    for (const l of lines) {
      if (BULLET.test(l)) items.push(l.replace(BULLET, "").trim());
      else if (items.length > 0 && l.trim() !== "") items[items.length - 1] += `\n${l.trim()}`;
    }
  } else items = text.split(/\n\s*\n/).map((p) => p.trim());
  const kept: string[] = [];
  for (const item of items.filter((i) => i !== "")) {
    if (words(item).size < 3 && kept.length > 0) kept[kept.length - 1] += `\n${item}`;
    else kept.push(item);
  }
  return kept.length < 2 || kept.length > IDEAS_MAX ? [text] : kept;
}

/** The open issue an idea clearly touches (most of the shorter side's words are shared), else none. */
export function attachTarget(idea: string, open: readonly Open[]): Open | undefined {
  const mine = words(idea);
  let best: Open | undefined;
  let most = 0;
  for (const o of open) {
    const theirs = words(o.title);
    const n = overlap(mine, theirs);
    if (n >= 3 && n / Math.min(mine.size, theirs.size) >= 0.6 && n > most && !opposed(idea, o.title)) (best = o), (most = n);
  }
  return best;
}

function pillarOf(text: string, set: Pillars): string | undefined {
  if (set.pillars.length === 0) return undefined;
  const mine = words(text);
  let best = set.pillars[0]!;
  let most = 0;
  for (const p of set.pillars) {
    const n = overlap(mine, words(`${p.name} ${p.umbrella.title}`));
    if (n > most) (best = p), (most = n);
  }
  return best.short;
}

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const quote = (text: string): string => text.split("\n").map((l) => `> ${l}`).join("\n");

/** Under this share of shared words two thoughts are not the same ask. */
const REPEAT_SHARE = 0.8;
const EARLIER = 100;

/** Words that turn a sentence around: a text that has one the other lacks says something else. */
const NEGATION = /\b(not|no|never|without|cancel|remove|stop)\b|n't\b/g;
const OPPOSITES: readonly (readonly [string, string])[] = [
  ["visible", "hidden"], ["show", "hide"], ["add", "remove"], ["enable", "disable"], ["on", "off"],
  ["more", "less"], ["increase", "decrease"], ["open", "close"], ["allow", "block"], ["include", "exclude"],
];

/** True when one text takes back, negates or flips a word of the other. */
function opposed(a: string, b: string): boolean {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if ((la.match(NEGATION)?.length ?? 0) !== (lb.match(NEGATION)?.length ?? 0)) return true;
  const wa = new Set(la.match(/[a-z']+/g));
  const wb = new Set(lb.match(/[a-z']+/g));
  return OPPOSITES.some(([x, y]) => (wa.has(x) && wb.has(y) && !wa.has(y) && !wb.has(x)) || (wa.has(y) && wb.has(x) && !wa.has(x) && !wb.has(y)));
}

/**
 * A thought the author already sent that placed an issue of `repo`, and says
 * the same. The same words always repeat; a close restatement only does when
 * the planner reads this one as a plain ask (`work`/`amendment`) and nothing
 * in it turns the earlier one around: the later thought wins, so a reversal
 * must never raise what it takes back.
 */
function repeatOf(app: App, repo: Repo, thought: Thought, kind: Kind): { before: Earlier; issue: Issue | undefined; number: number } | undefined {
  const mine = words(thought.text);
  const slug = `${repo.ownerName}/${repo.name}`;
  for (const before of earlierPlaced(app, thought)) {
    const theirs = words(before.text);
    const same =
      before.text === thought.text ||
      ((kind === "work" || kind === "amendment") &&
        mine.size >= 3 &&
        overlap(mine, theirs) / Math.max(mine.size, theirs.size) >= REPEAT_SHARE &&
        !opposed(thought.text, before.text));
    if (!same) continue;
    const at = before.placed.find((p) => p.repo === slug && (p.action === "opened" || p.action === "linked" || p.action === "amended"));
    if (!at) continue;
    return { before, issue: getIssue(app.db, repo.id, at.number), number: at.number };
  }
  return undefined;
}

interface Earlier {
  readonly id: string;
  readonly text: string;
  readonly receivedAt: string;
  readonly kind: Kind;
  readonly placed: Placed[];
}

/** The author's placed thoughts received before this one, newest first. */
function earlierPlaced(app: App, thought: Thought): Earlier[] {
  return app.db
    .query<{ id: string; text: string; received_at: string; kind: string; placed: string }, [string, number]>(
      `SELECT t.id, t.text, t.received_at, p.kind, p.placed FROM thought t JOIN placement p ON p.thought_id = t.id
        WHERE t.id != ?1 AND t.author = (SELECT author FROM thought WHERE id = ?1)
          AND t.received_at <= (SELECT received_at FROM thought WHERE id = ?1)
        ORDER BY t.received_at DESC, t.id DESC LIMIT ?2`,
    )
    .all(thought.id, EARLIER)
    .map((r) => ({ id: r.id, text: r.text, receivedAt: r.received_at, kind: r.kind as Kind, placed: JSON.parse(r.placed) as Placed[] }));
}

function openIssues(app: App, repo: Repo, set: Pillars, direction: Issue | undefined): Open[] {
  return app.db
    .query<{ id: string; number: number; title: string }, [string, number]>(
      "SELECT id, number, title FROM issue WHERE repo_id = ?1 AND kind = 'issue' AND state = 'open' ORDER BY number DESC LIMIT ?2",
    )
    .all(repo.id, OPEN_SHOWN)
    .filter((i) => i.id !== direction?.id && !isStructural(set, i.id))
    .map((i) => ({ number: i.number, title: i.title }));
}

/** Where the author's thoughts go: their autonomous repository, "forge" first. */
export function homeOf(app: App, authorId: string): Repo | undefined {
  const mine = listAutonomousRepos(app.db).filter(
    (r) => r.ownerId === authorId && r.autonomyBy !== null,
  );
  return mine.find((r) => r.name === "forge") ?? mine[0];
}

export interface Thought {
  readonly id: string;
  readonly text: string;
}

const SLUG = /^(?:https?:\/\/[^\s/]+\/)?[\w.-]+\/[\w.-]+(?:\.git)?\/?$/;

/** Nothing to act on: empty, or only a repository slug or a URL to one. */
export function isNote(text: string): boolean {
  const t = text.trim();
  return t === "" || SLUG.test(t);
}

/** Place one thought. Always answers: a best placement, and a question when unsure. */
export async function placeThought(
  app: App,
  repo: Repo,
  by: User,
  thought: Thought,
  now = new Date(),
): Promise<Placement> {
  const slug = `${repo.ownerName}/${repo.name}`;
  // A note has no kind of its own: "decision" by "rule" with an empty `placed` stands in for it.
  if (isNote(thought.text))
    return finish(app, thought, "decision", "rule", true, [], `Kept as a note: what should change in ${slug}?`, now);
  const set = pillarsOf(app.db, repo);
  const direction = ensureDirectionIssue(app, by, repo);
  const open = openIssues(app, repo, set, direction);
  const text = thought.text;
  const ref = `From thought \`${thought.id}\`:`;

  const ruled = ruleKind(text, open.length > 0);
  const ruledTarget = targetOf(text, open);
  const ruledPillar = pillarOf(text, set);
  const questions: Record<string, { options: readonly string[]; about: string }> = {
    kind: {
      options: KINDS,
      about:
        "What is this thought? work: something new to build. amendment: a change to an open issue. vision: a change of direction. decision: a choice already made. reversal: it takes back an earlier thought or issue.",
    },
  };
  if (open.length > 0)
    questions["target"] = {
      options: [...open.map((o) => `#${o.number}`), "none"],
      about: "Which open issue does this thought concern, if any?",
    };
  if (set.pillars.length > 0)
    questions["pillar"] = {
      options: set.pillars.map((p) => p.short),
      about: "Which pillar does work from this thought serve?",
    };
  const rule = (): Answers<Questions> => {
    const out: Record<string, ReturnType<typeof certain>> = {
      kind: {
        choice: ruled.kind,
        p: ruled.p,
        probabilities: Object.fromEntries(KINDS.map((k) => [k, k === ruled.kind ? ruled.p : (1 - ruled.p) / 4])),
      },
    };
    if (questions["target"]) out["target"] = certain(questions["target"].options, ruledTarget ? `#${ruledTarget.number}` : "none");
    if (questions["pillar"]) out["pillar"] = certain(questions["pillar"].options, ruledPillar!);
    return out;
  };
  const decided = await decideOr(
    app.config.decider,
    {
      thought: clip(text, TEXT_SHOWN),
      pillars: set.pillars.map((p) => p.name),
      open: open.map((o) => `#${o.number} ${clip(o.title, 120)}`),
    },
    questions,
    rule,
  );
  let kind = decided.answers["kind"]!.choice as Kind;
  const sure = decided.answers["kind"]!.p >= SURE;
  const pickedTarget = decided.answers["target"]?.choice;
  const target = open.find((o) => `#${o.number}` === pickedTarget);
  const pillar = decided.answers["pillar"]?.choice;

  // The same thing said again is the same thought: link and raise, never duplicate.
  const again = repeatOf(app, repo, thought, kind);
  if (again) {
    const { before, issue, number } = again;
    const said = before.receivedAt.slice(0, 10);
    linkThoughts(app.db, thought.id, before.id, "repeats");
    let reply = `You asked this on ${said}; #${number} is ${issue ? (issue.state === "open" ? "still open" : "closed") : "gone"}.`;
    if (issue?.state === "open" && repoGraph(app.db, repo.id).deferred.has(issue.id)) {
      reply = `You asked this on ${said}; #${number} is open but deferred behind the Later gate, so it is not raised.`;
    } else if (issue?.state === "open") {
      raiseIssue(app.db, issue.id, now);
      // The ready order moved: say so on the repository, so a cached map misses.
      app.bus.append({ kind: "issue.raised", repoId: repo.id, payload: { number: issue.number } });
      const done = addComment(app, by, repo, issue, `Asked again; raised in the ready order.\n\n${ref}\n\n${quote(text)}`);
      if (!done.ok) log.warn("could not comment", { issue: issue.number, error: String(done.error) });
      reply = `You asked this on ${said}; #${number} is open${issue.assigneeId ? " and being built" : ""}. Raised it.`;
    }
    return finish(app, thought, before.kind, "rule", false, [{ action: "linked", repo: slug, number }], reply, now);
  }


  const placed: Placed[] = [];
  const say: string[] = [];
  let question = sure ? "" : `I read this as ${kind === "amendment" ? "an amendment" : `a ${kind}`}; is that right?`;
  const comment = (issue: Issue, lead: string): void => {
    const done = addComment(app, by, repo, issue, `${lead}\n\n${ref}\n\n${quote(text)}`);
    if (!done.ok) log.warn("could not comment", { issue: issue.number, error: String(done.error) });
  };
  const here = (n: number): Issue | undefined => getIssue(app.db, repo.id, n);

  if ((kind === "amendment" || kind === "reversal") && !target) {
    // Nothing to amend or take back was named: keep the words where they will be seen.
    question = kind === "reversal" ? "Which issue does this take back?" : "Is this an amendment to an open issue? Which one?";
    kind = kind === "reversal" ? "decision" : "work";
  }
  if (kind === "work") {
    // A long dump is several ideas: each is attached to the open issue it
    // touches, or becomes an issue of its own, linked back to this thought.
    const ideas = splitIdeas(text);
    const fresh: string[] = [];
    for (const idea of ideas) {
      const near = attachTarget(idea, open);
      const issue = near ? here(near.number) : undefined;
      if (issue) {
        comment(issue, "A new thought touches this:");
        placed.push({ action: "amended", repo: slug, number: issue.number });
        say.push(`Added to #${issue.number}.`);
      } else fresh.push(idea);
    }
    // Said to wait: it is opened, and sits behind the Later gate until its author says otherwise.
    const waits = (idea: string): boolean => set.gate !== undefined && SNOOZE.test(idea);
    const opened =
      fresh.length === 0
        ? undefined
        : openPlan(
            app,
            by,
            repo,
            fresh.map((idea, i) => ({
              key: `thought${i}`,
              title: clip(idea.split("\n")[0] ?? "", Math.min(MAX_TITLE, 120)) || "Thought",
              body: `${ref}\n\n${quote(idea)}${pillar ? `\n\nServes ${set.pillars.find((p) => p.short === pillar)?.name}.` : ""}`,
              blockedBy: [],
              ...(waits(idea) ? { later: "You said it can wait." } : pillar ? { pillar } : {}),
            })),
          );
    if (opened?.ok) {
      const name = set.pillars.find((p) => p.short === pillar)?.name;
      const numbers = opened.value.opened.map((o) => o.number);
      const later = new Set(fresh.flatMap((idea, i) => (waits(idea) ? [`thought${i}`] : [])));
      const waiting = opened.value.opened.filter((o) => later.has(o.key)).map((o) => o.number);
      for (const number of numbers) {
        const waits = waiting.includes(number);
        placed.push({ action: "opened", repo: slug, number, ...(pillar && !waits ? { pillar } : {}) });
        if (waits) placed.push({ action: "deferred", repo: slug, number });
      }
      const list = (ns: readonly number[]) => ns.map((n) => `#${n}`).join(", ");
      const now = numbers.filter((n) => !waiting.includes(n));
      if (now.length > 0) say.push(`Opened ${list(now)}${name ? ` under ${name}` : ""}.`);
      if (waiting.length > 0) say.push(`Snoozed: you said it can wait, so ${list(waiting)} sits behind the Later gate.`);
    } else if (opened && direction) {
      comment(direction, "A thought that could not be opened as an issue:");
      placed.push({ action: "amended", repo: slug, number: direction.number });
      say.push(`Could not open it as an issue (${opened.error.message}); kept on #${direction.number}.`);
    }
  } else if (kind === "amendment" && target) {
    const issue = here(target.number);
    if (issue) {
      comment(issue, "Amended by a new thought:");
      placed.push({ action: "amended", repo: slug, number: issue.number });
      say.push(`Added to #${issue.number}.`);
    }
  } else if (kind === "reversal" && target) {
    const issue = here(target.number);
    if (issue) {
      comment(issue, "Superseded by a later thought; this is not to be built as written:");
      const gate = set.gate;
      const deferred = gate && issue.id !== gate.id && addDependency(app.db, issue, gate, by.id).ok;
      if (deferred && gate)
        app.bus.append({ kind: "issue.blocked", repoId: repo.id, actorId: by.id, payload: { number: issue.number, blockedBy: gate.number } });
      placed.push({ action: deferred ? "deferred" : "superseded", repo: slug, number: issue.number });
      // The earlier thoughts that placed this issue are the ones taken back.
      const taken = earlierPlaced(app, thought).filter((e) =>
        e.placed.some((p) => p.repo === slug && p.number === issue.number && p.action !== "superseded" && p.action !== "deferred"),
      );
      for (const e of taken) linkThoughts(app.db, thought.id, e.id, "supersedes");
      const when = taken[0] ? ` (you said it on ${taken[0].receivedAt.slice(0, 10)})` : "";
      say.push(deferred ? `Superseded #${issue.number}${when} and put it behind the Later gate.` : `Marked #${issue.number}${when} superseded.`);
    }
  } else if (direction) {
    comment(direction, kind === "vision" ? "The direction changes:" : "A decision:");
    placed.push({ action: "amended", repo: slug, number: direction.number });
    say.push(`${kind === "vision" ? "Noted as direction" : "Recorded as a decision"} on #${direction.number}.`);
    if (kind === "vision") {
      const proposed = await proposeVision(app, by, repo, thought, now);
      if (proposed.ok) {
        const n = proposed.pull.number;
        placed.push({ action: "proposed", repo: slug, number: n, pull: n });
        say.push(`Proposed the edit to docs/VISION.md as #${n}; you land it.`);
      } else log.warn("could not propose the vision edit", { thought: thought.id, why: proposed.why });
    }
  }
  if (say.length === 0) say.push("Kept; nothing on the map changed.");
  return finish(app, thought, kind, decided.by, question !== "", placed, [say.join(" "), question].filter(Boolean).join(" "), now);
}

function finish(
  app: App,
  thought: Thought,
  kind: Kind,
  decidedBy: string,
  asked: boolean,
  placed: Placed[],
  reply: string,
  now = new Date(),
): Placement {
  const placement: Placement = {
    thoughtId: thought.id,
    kind,
    placed,
    reply,
    asked,
    decidedBy,
    placedAt: now.toISOString(),
  };
  savePlacement(app.db, placement);
  const author = thoughtAuthor(app.db, thought.id);
  app.bus.append({ kind: "thought.placed", ...(author ? { actorId: author } : {}), payload: { id: thought.id, kind } });
  return placement;
}

/** One turn of triage: every author's quiet batch of thoughts, placed. Returns how many. */
export async function triageTick(app: App, now = new Date()): Promise<number> {
  if (crewOffInPreview()) return 0;
  let placedCount = 0;
  // Thoughts older than a day are never placed; the cutoff is in the query so they cannot crowd out fresh ones.
  const since = new Date(now.getTime() - STALE_MS).toISOString();
  for (const authorId of authorsWithUnplaced(app.db, since)) {
    try {
      const repo = homeOf(app, authorId);
      const by = repo?.autonomyBy ? getUserById(app.db, repo.autonomyBy) : undefined;
      if (!repo || !by) continue;
      const waiting = unplaced(app.db, authorId, since, BATCH_MAX * 3);
      const oldest = waiting[0];
      if (!oldest) continue;
      const first = new Date(oldest.receivedAt).getTime();
      // The batch closes once its first thought is two minutes old.
      if (now.getTime() - first < BATCH_MS) continue;
      // Over the day's ceiling the planner waits; so does the repository.
      const paused = autonomyStatus(app, repo, now).paused;
      if (paused === "ceiling" || paused === "forge ceiling") continue;
      const batch = waiting.filter((t) => new Date(t.receivedAt).getTime() - first <= BATCH_MS).slice(0, BATCH_MAX);
      for (const t of batch) {
        await placeThought(app, repo, by, t, now);
        placedCount++;
      }
    } catch (error) {
      log.error("triage failed", { author: authorId, error: String(error) });
    }
  }
  return placedCount;
}
