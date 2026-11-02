/**
 * `ssh <forge> talk <words>`: the forge's own agent, in one line from any
 * shell. An exec of `talk` calls the same `talk()` the API and the MCP use,
 * as the account the presented key belongs to, and prints that the agent is
 * answering; the answer is read back with `forge talk` or on the feed. The
 * words are the rest of the command line as given: no shell, no expansion; a
 * control character is refused before anything runs. `talk /stop` (or
 * `--stop`) ends the running answer, as Stop does on /talk: what the agent
 * had said stays, its processes end, a held write is cancelled.
 */

import { TALK_WORDS, stopTalk, talk } from "../actions/talk.ts";
import { contextOf, contextText, dollars, turnCosts } from "../core/conversation_cost.ts";
import { openConversation } from "../core/conversations.ts";
import type { App } from "../app.ts";
import type { User } from "../core/users.ts";
import { CONTROL_WORDS } from "./ssh-tell.ts";
import type { SshSession } from "../ssh/server.ts";

const CRLF = "\r\n";

/** The words after `talk`, as given; undefined when the command is not a talk. */
export function parseTalkCommand(command: string | undefined): string | undefined {
  if (command === undefined) return undefined;
  const m = /^talk(?:[ \t]+([\s\S]*))?$/.exec(command.trim());
  return m === null ? undefined : (m[1] ?? "");
}

/** The words that stop the running answer instead of being said. */
export function isStop(words: string): boolean {
  return words.trim() === "/stop" || words.trim() === "--stop";
}

/** Run one `talk` exec for `user` (undefined: an unknown key). */
export function serveTalk(app: App, session: SshSession, user: User | undefined, words: string): void {
  const refuse = (text: string): void => {
    session.writeStderr(`forge: ${text}${CRLF}`);
    session.exit(1);
  };
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(words)) return refuse(CONTROL_WORDS);
  if (isStop(words)) {
    const stopped = stopTalk(app, user);
    if (!stopped.ok)
      return refuse(
        stopped.error === "idle" ? "no answer is running" : stopped.error === "off" ? TALK_WORDS.off[1] : TALK_WORDS.unauthorized[1],
      );
    session.write(`stopped the forge's agent; what it said stays${CRLF}`);
    return session.exit(0);
  }
  const said = talk(app, user, words);
  if (!said.ok) return refuse(TALK_WORDS[said.error][1]);
  session.write(
    `${said.value.how === "steered" ? "said to the forge's agent, mid-answer" : "the forge's agent is answering"}${CRLF}`,
  );
  if (user !== undefined) {
    // The figures of the turn before this one, from its own usage record.
    const conversation = openConversation(app.db, user.id);
    const last = [...turnCosts(app.db, conversation.id).values()].at(-1);
    const context = contextOf(app.db, conversation.id);
    if (last !== undefined) session.write(`last turn ${dollars(last)}${CRLF}`);
    if (context !== undefined) session.write(`${contextText(context)}${CRLF}`);
  }
  session.exit(0);
}
