/**
 * Tell the crew: a sentence becomes an issue, the issue is routed to a
 * builder, and the builder is assigned, which is what starts a run. Every
 * door says it through this one action — the studio's box, the feed's
 * tells, a share to an agent, the MCP `tell` tool and the prompts that
 * turn a comment into a tell — so the rule of who may is asked once.
 */

import type { App } from "../app.ts";
import { listCrewRoles } from "../core/agents.ts";
import { MAX_BODY, type Issue, type TitleError } from "../core/issues.ts";
import type { Repo } from "../core/repos.ts";
import { listRuns } from "../core/runs.ts";
import type { User } from "../core/users.ts";
import { mayDirectCrew } from "../crew/direct.ts";
import { routeIssue, type Routed } from "../crew/route.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireParticipant } from "./access.ts";
import { assignIssue, openIssue, type MirrorError } from "./issues.ts";
import { parseFrom } from "./tell_from.ts";
import { requireVerified } from "./verify.ts";
import { VERIFY_FIRST } from "./verify_words.ts";

export interface Told {
  readonly issue: Issue;
  /** Who took it and how it was sized; absent when nobody is on the crew. */
  readonly routed: Routed | undefined;
  /** Whether the builder could be assigned (and so a run will start). */
  readonly assigned: boolean;
  /** Every issue the tell opened: one, or one per variant. */
  readonly issues: readonly Issue[];
  /** The numbers among them that a builder took, so a run starts for each. */
  readonly assignedNumbers: readonly number[];
  /** The group the variants share; null for an ordinary tell. */
  readonly variantGroup: string | null;
}

/** The longest title a tell keeps whole; a longer first line is cut and the body keeps it all. */
export const TELL_TITLE_MAX = 80;

/** The most tries one tell may ask for at once. */
export const VARIANTS_MAX = 4;

/** `variants` as the API takes it: absent is 1; otherwise an integer 1–4, or undefined for no. */
export function parseVariants(raw: unknown): number | undefined {
  if (raw === undefined) return 1;
  if (typeof raw !== "number" || !Number.isInteger(raw)) return undefined;
  return raw >= 1 && raw <= VARIANTS_MAX ? raw : undefined;
}

/**
 * An app's own address as a place a tell was said: scheme and host (and
 * port) only. Only the app terminal's door builds one and says `fromApp`; every other
 * caller takes `parseFrom`'s paths alone.
 */
const APP_ADDRESS = /^https?:\/\/[a-z0-9][a-z0-9.-]*(?::\d{1,5})?$/i;

/** What a bad `from` is refused with, at every door. */
export const FROM_WORDS =
  "from is a path on this forge, like /alice/notes/pulls/3, at most 512 characters";

/** What a client reads after asking for something, on the web and in the terminal. */
export const SENT_WORDS = "Sent. The agents will pick it up.";

export type TellError =
  | "empty"
  | "bad_from"
  | "not_found"
  | "unauthorized"
  /** The owner paused the planner (`core/planner_pause.ts`). */
  | "planner_paused"
  /** Someone who may not direct the crew here (`crew/direct.ts`). */
  | "forbidden"
  /** Someone whose email is not verified yet (`verify.ts`). */
  | "unverified"
  | TitleError
  | "body_too_long"
  | MirrorError;

export async function tell(
  app: App,
  actor: User | undefined,
  repo: Repo,
  said: string,
  variants = 1,
  from: string | null = null,
  fromApp = false,
): Promise<Result<Told, TellError>> {
  // A tell is a run: only someone who may direct the crew here says one,
  // and a refused tell opens nothing (`crew/direct.ts`).
  const participant = requireParticipant(app, actor, repo);
  if (!participant.ok) return participant;
  if (!mayDirectCrew(app.db, repo, participant.value)) return err("forbidden");
  // A tell sends the crew to work in this person's name: an address not yet
  // shown to be theirs tells nothing (`verify.ts`).
  if (!requireVerified(app, participant.value).ok) return err("unverified");
  const text = said.trim();
  if (text === "") return err("empty");
  // One long line becomes only a title, so the body cap never sees it.
  if (text.length > MAX_BODY) return err("body_too_long");
  if (from !== null && !(fromApp && APP_ADDRESS.test(from))) {
    const path = parseFrom(from);
    if (typeof path !== "string") return err("bad_from");
    from = path;
  }
  const firstLine = text.split(/\n/)[0]!.trim();
  const title =
    firstLine.length <= TELL_TITLE_MAX ? firstLine : `${firstLine.slice(0, 77).trimEnd()}…`;
  // Several tries are several issues, each its own branch and pull, sharing
  // one group the pulls carry (`variant_group`).
  const many = variants > 1;
  const variantGroup = many ? crypto.randomUUID() : null;
  const crew = listCrewRoles(app.db, repo.id);
  const inFlight = new Map<string, number>();
  for (const r of listRuns(app.db, repo.id, { kind: "agent", limit: 50 }))
    if ((r.state === "running" || r.state === "queued") && r.actorId !== null)
      inFlight.set(r.actorId, (inFlight.get(r.actorId) ?? 0) + 1);
  const issues: Issue[] = [];
  let routed: Routed | undefined;
  let assigned = false;
  const assignedNumbers: number[] = [];
  for (let k = 1; k <= variants; k++) {
    const note = many ? `Variant ${k} of ${variants}.` : "";
    const origin = from === null ? "" : `Told from [${from}](${from})`;
    // The body is what follows the title; a title cut short keeps the
    // whole text in the body, so nothing said is lost.
    const rest =
      title === firstLine ? text.slice(text.indexOf(firstLine) + firstLine.length).trim() : text;
    const opened = openIssue(app, actor, repo, {
      title,
      body: [rest, note, origin].filter((s) => s !== "").join("\n\n"),
    });
    if (!opened.ok) return issues.length === 0 ? opened : ok(told());
    issues.push(opened.value);
    const taker = await routeIssue(app, repo, opened.value, crew, inFlight);
    if (taker === undefined) continue;
    routed ??= taker;
    const made = assignIssue(
      app,
      actor,
      repo,
      opened.value,
      taker.builder.user,
      variantGroup ?? undefined,
    );
    if (k === 1) assigned = made.ok;
    if (made.ok) assignedNumbers.push(opened.value.number);
    inFlight.set(
      taker.builder.user.id,
      (inFlight.get(taker.builder.user.id) ?? 0) + 1,
    );
  }
  return ok(told());

  function told(): Told {
    return { issue: issues[0]!, routed, assigned, issues, assignedNumbers, variantGroup };
  }
}

/** What every door says when a tell is refused for an unverified address. */
export const UNVERIFIED_WORDS = VERIFY_FIRST;

/** What both doors say when `tell` refuses a text over `MAX_BODY`. */
export const TOO_LONG_WORDS = "That is too long to tell in one go.";

/** What happened, in the sentence both doors say. */
export function toldWords(told: Told): string {
  if (told.routed === undefined)
    return `Opened as issue #${told.issue.number}. Nobody is on the crew to take it yet — add someone under Settings → Crew.`;
  const r = told.routed;
  const who = r.builder.user.username;
  return told.assigned
    ? `${who} is on it — ${r.size} ${r.kind}${r.by === "rule" ? "" : `, ${r.by} decided in ${r.ms} ms`}.`
    : `Opened as issue #${told.issue.number}, but ${who} could not take it.`;
}
