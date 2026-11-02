/**
 * Talk to the forge's own agent (#7651): the one door every surface uses —
 * the API, `forge talk`, `ssh <forge> talk <words>`. The identity is already
 * verified by the door; this checks the crew is on, throttles by identity,
 * and hands the words to `crew/conversation.ts`, which runs as that person.
 */

import type { App } from "../app.ts";
import { RateLimiter } from "../core/ratelimit.ts";
import type { User } from "../core/users.ts";
import { conversationOptions, say, stopTurn, type SayRefusal, type Said } from "../crew/conversation.ts";
import { err, ok, type Result } from "../kernel/result.ts";

/** Messages a person may send in a minute. */
export const TALK_PER_MINUTE = 12;

export type TalkRefusal = SayRefusal | "off" | "rate_limited";

/** What each refusal says, with its status. */
export const TALK_WORDS: Readonly<Record<TalkRefusal, readonly [number, string]>> = {
  unauthorized: [401, "sign in to talk to the forge"],
  empty: [422, "say something"],
  too_long: [422, "the message is too long"],
  no_account: [403, "no Claude account is granted to you; ask an admin for a grant"],
  resting: [429, "the account that serves you is resting or out of budget; try again later"],
  busy: [429, "the forge's agent is answering as many people as it can at once; try again in a minute"],
  off: [503, "the forge's agent is not running here"],
  rate_limited: [429, `at most ${TALK_PER_MINUTE} messages a minute`],
};

const limiters = new WeakMap<App, RateLimiter>();

export function talk(app: App, user: User | undefined, text: string): Result<Said, TalkRefusal> {
  if (user === undefined) return err("unauthorized");
  const options = conversationOptions(app);
  if (options === undefined) return err("off");
  let limiter = limiters.get(app);
  if (limiter === undefined) {
    limiter = new RateLimiter({ perMinute: TALK_PER_MINUTE, adminPerMinute: TALK_PER_MINUTE, enabled: true });
    limiters.set(app, limiter);
  }
  if (!limiter.take(`talk:${user.id}`, "rw").allowed) return err("rate_limited");
  const said = say(app, options, user.id, text);
  if (said.ok && said.value.done !== undefined)
    said.value.done.catch((error: unknown) => app.log.error("conversation turn crashed", { error: String(error) }));
  return said;
}

/** Stop the person's running turn; `idle` when none runs. */
export function stopTalk(app: App, user: User | undefined): Result<true, "unauthorized" | "off" | "idle"> {
  if (user === undefined) return err("unauthorized");
  if (conversationOptions(app) === undefined) return err("off");
  return stopTurn(app, user.id) ? ok(true) : err("idle");
}
