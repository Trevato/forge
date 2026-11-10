/**
 * Talk to the forge's own agent (#7651): the one door every surface uses —
 * the API, `forge talk`, `ssh <forge> talk <words>`. The identity is already
 * verified by the door; this checks the crew is on, throttles by identity,
 * and hands the words to `crew/conversation.ts`, which runs as that person.
 */

import type { App } from "../app.ts";
import { getConversation } from "../core/conversations.ts";
import type { ConversationFile } from "../core/conversation_files.ts";
import { RateLimiter } from "../core/ratelimit.ts";
import type { User } from "../core/users.ts";
import { cancelQueued, queuedOf, conversationOptions, redo, say, stopTurn, type During, type RedoHow, type RedoRefusal, type SayRefusal, type Said } from "../crew/conversation.ts";
import { err, ok, type Result } from "../kernel/result.ts";

/** Messages a person may send in a minute. */
export const TALK_PER_MINUTE = 12;

export type TalkRefusal = SayRefusal | RedoRefusal | "off" | "rate_limited";

/** What each refusal says, with its status. */
export const TALK_WORDS: Readonly<Record<TalkRefusal, readonly [number, string]>> = {
  not_found: [404, "no such conversation"],
  unauthorized: [401, "sign in to talk to the forge"],
  empty: [422, "say something"],
  too_long: [422, "the message is too long"],
  no_account: [403, "no Claude account is granted to you; ask an admin for a grant"],
  resting: [429, "the account that serves you is resting or out of budget; try again later"],
  answering: [409, "the forge is still answering; send pictures when it has finished"],
  busy: [429, "the forge's agent is answering as many people as it can at once; try again in a minute"],
  off: [503, "the forge's agent is not running here"],
  running: [409, "the forge is still answering; wait for it to finish"],
  nothing: [409, "there is nothing here to do that to"],
  file_taken: [409, "that file already waits in another message"],
  queue_full: [429, "five messages are already waiting; cancel one or wait for the answer"],
  rate_limited: [429, `at most ${TALK_PER_MINUTE} messages a minute`],
};

const limiters = new WeakMap<App, RateLimiter>();

/** Throttle by identity: false past `TALK_PER_MINUTE` a minute. */
function take(app: App, user: User): boolean {
  let limiter = limiters.get(app);
  if (limiter === undefined) {
    limiter = new RateLimiter({ perMinute: TALK_PER_MINUTE, adminPerMinute: TALK_PER_MINUTE, enabled: true });
    limiters.set(app, limiter);
  }
  return limiter.take(`talk:${user.id}`, "rw").allowed;
}

const watch = (app: App, said: Said): void => {
  said.done?.catch((error: unknown) => app.log.error("conversation turn crashed", { error: String(error) }));
};

export function talk(app: App, user: User | undefined, text: string, files: readonly ConversationFile[] = [], during: During = "inject", conversationId?: string, about?: string | null): Result<Said, TalkRefusal> {
  if (user === undefined) return err("unauthorized");
  if (conversationId !== undefined && getConversation(app.db, user.id, conversationId) === undefined) return err("not_found");
  const options = conversationOptions(app);
  if (options === undefined) return err("off");
  if (!take(app, user)) return err("rate_limited");
  const said = say(app, options, user.id, text, files, during, conversationId, about);
  if (said.ok) watch(app, said.value);
  return said;
}

/** Edit the last message and resend it, regenerate the last reply, or retry a failed turn (#8817), in the named conversation or the latest. */
export function talkAgain(app: App, user: User | undefined, how: RedoHow, text = "", conversationId?: string): Result<Said, TalkRefusal> {
  if (user === undefined) return err("unauthorized");
  const options = conversationOptions(app);
  if (options === undefined) return err("off");
  if (!take(app, user)) return err("rate_limited");
  const said = redo(app, options, user.id, how, text, conversationId);
  if (said.ok) watch(app, said.value);
  return said;
}

/** Stop the person's running turn; `idle` when none runs. */
export function stopTalk(app: App, user: User | undefined): Result<true, "unauthorized" | "off" | "idle"> {
  if (user === undefined) return err("unauthorized");
  if (conversationOptions(app) === undefined) return err("off");
  return stopTurn(app, user.id) ? ok(true) : err("idle");
}

/** Take back a message waiting for the running turn; false when it already went. */
export const cancelTalk = (app: App, user: User | undefined, queuedId: string): boolean => user !== undefined && cancelQueued(app, user.id, queuedId);

/** The person's waiting messages, oldest first. */
export const queuedTalk = (app: App, user: User | undefined, conversationId?: string): readonly { id: string; text: string }[] =>
  user === undefined ? [] : queuedOf(app, user.id, conversationId).map((q) => ({ id: q.id, text: q.text }));
