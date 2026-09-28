/**
 * Whose name a studio row carries — the one place that decides it, so the
 * app's page, a run's own page and the front door never sign the same piece
 * of work to two different people.
 *
 * The decision, once: **an agent's name is not a secret.** A change's own
 * page and `/changes` already name the agent that opened it to anyone who
 * can read the repository, and nothing here could take that back. What
 * "the crew" stands in for is narrower — who is on the crew is part of the
 * roster, the ceiling and the ledger, the owner's own book-keeping
 * (`docs/STUDIO.md`, _The owner's facts and the public's_) — and it is a
 * matter of voice, not of secrecy: a visitor reads a *run* of the crew's
 * as the app's own story rather than as an unfamiliar name's.
 *
 * So masking asks two questions and needs both, and the first is about the
 * actor rather than the viewer:
 *
 *  1. Is the actor an agent? A person is named to every viewer that can see
 *     the row at all — their authorship is theirs, and the app page must
 *     say what `/changes` and the change's own page say.
 *  2. Can this viewer see the owner's facts? A writer reads the real name.
 *
 * Nothing here decides *whether* a row is visible: a viewer who cannot see
 * a change still cannot see it. This only names the one they can already
 * see.
 */

/** The name a run, a change or a tell is signed with when no name is shown. */
export const CREW = "the crew";

/** Who did the thing: a name, and whether that name is a crew member. */
export interface Actor {
  /** The username, or undefined when the row names nobody at all. */
  readonly name: string | undefined;
  /** Whether that actor is an agent on the crew rather than a person. */
  readonly isAgent: boolean;
}

/**
 * The name to print beside a piece of work, and to draw the avatar from, so
 * the initials always match the name beside them.
 *
 * `unnamed` is what a row that names nobody reads as — "the crew" on the
 * app's page and the front door, `unnamedRun` on a run's own.
 */
export function voiceFor(
  actor: Actor,
  writer: boolean,
  unnamed: string = CREW,
): string {
  if (actor.name === undefined) return unnamed;
  if (!actor.isAgent) return actor.name;
  return writer ? actor.name : CREW;
}

/**
 * What a run with no actor on it reads as: "an agent" is a name for nobody,
 * honest enough for a writer who can see the roster anyway and would
 * otherwise read the run as the whole crew's, and "the crew" for everyone
 * else — the voice they read every other run of the crew's in.
 */
export const unnamedRun = (writer: boolean): string =>
  writer ? "an agent" : CREW;
