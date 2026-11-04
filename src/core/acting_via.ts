/**
 * How the caller of this request acts: as itself, or as a person by way of
 * the forge's agent (`conversation:<id>`). The listener opens the scope once
 * auth is resolved; `EventBus.append` reads it, so every event a request
 * writes carries it without any append site passing it along (#7648).
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** Who acts through the agent, and in which conversation. */
interface Acting {
  readonly userId: string;
  /** The conversation it acts in, when the agent is speaking for the person. */
  readonly via?: string;
  /** The door it came in by: `session`, `edge`, `password` or `token:<name>`. */
  readonly door?: string;
}

const store = new AsyncLocalStorage<Acting | undefined>();

/** Run `fn` with `acting` as how its writes are made; undefined is "as itself". */
export const actingVia = <T>(acting: Acting | undefined, fn: () => T): T =>
  store.run(acting, fn);

/**
 * The `via` an event by `actorId` carries now: only the person the agent
 * acts for is marked, so what the forge itself writes on the way (a run, a
 * check) is never said to be theirs.
 */
export const currentVia = (actorId: string | undefined): string | undefined => {
  const acting = store.getStore();
  return acting !== undefined && acting.userId === actorId ? acting.via : undefined;
};

/** The door an actor's request came in by, for the audit of what it did; none outside a request (the terminal, a tick). */
export const currentDoor = (actorId: string): string | undefined => {
  const acting = store.getStore();
  return acting !== undefined && acting.userId === actorId ? acting.door : undefined;
};

/** The words that follow the person's name on the trail. */
export const VIA_WORDS = "via the forge's agent";
