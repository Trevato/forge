/**
 * `ssh <forge> talk <words>`: the forge's own agent, in one line from any
 * shell. An exec of `talk` calls the same `talk()` the API and the MCP use,
 * as the account the presented key belongs to, and prints that the agent is
 * answering; the answer is read back with `forge talk` or on the feed. The
 * words are the rest of the command line as given: no shell, no expansion; a
 * control character is refused before anything runs.
 */

import { TALK_WORDS, talk } from "../actions/talk.ts";
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

/** Run one `talk` exec for `user` (undefined: an unknown key). */
export function serveTalk(app: App, session: SshSession, user: User | undefined, words: string): void {
  const refuse = (text: string): void => {
    session.writeStderr(`forge: ${text}${CRLF}`);
    session.exit(1);
  };
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(words)) return refuse(CONTROL_WORDS);
  const said = talk(app, user, words);
  if (!said.ok) return refuse(TALK_WORDS[said.error][1]);
  session.write(
    `${said.value.how === "steered" ? "said to the forge's agent, mid-answer" : "the forge's agent is answering"}${CRLF}`,
  );
  session.exit(0);
}
