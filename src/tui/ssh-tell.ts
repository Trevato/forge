/**
 * `ssh <forge> tell <words>`: the crew told in one line from any shell. An
 * exec of `tell` on a non-app login calls the same `tell()` the web composer
 * and the terminal use, as the account the presented key belongs to, with
 * `from` null, and prints the told line and the full address of the issue.
 * The words are the rest of the command line as given: no shell, no
 * expansion, no `eval`; a control character is refused before anything runs.
 */

import { tell } from "../actions/tell.ts";
import { SAY_SOMETHING_WORDS } from "../actions/tell_words.ts";
import type { App } from "../app.ts";
import { getRepo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import type { SshSession } from "../ssh/server.ts";
import { tellAnswer } from "./screens/tell.ts";

const CRLF = "\r\n";

/** What an unknown key is told: it is a guest, and a guest tells nothing. */
export const ACCOUNT_NEEDED_WORDS =
  "telling the crew needs an account — sign in on the web and add this key under Settings → Keys";

/** What a command with a control character in its words is refused with. */
export const CONTROL_WORDS = "the words may not hold control characters";

/** What a forge with no code repository to tell is refused with. */
export const NO_CREW_WORDS = "this forge has no repository to tell the crew in";

/** The words after `tell`, as given; undefined when the command is not a tell. */
export function parseTellCommand(command: string | undefined): string | undefined {
  if (command === undefined) return undefined;
  const m = /^tell(?:[ \t]+([\s\S]*))?$/.exec(command.trim());
  return m === null ? undefined : (m[1] ?? "");
}

const refuse = (session: SshSession, words: string): void => {
  session.writeStderr(`forge: ${words}${CRLF}`);
  session.exit(1);
};

/** Run one `tell` exec for `user` (undefined: an unknown key). */
export async function serveTell(
  app: App,
  session: SshSession,
  user: User | undefined,
  words: string,
): Promise<void> {
  if (user === undefined) return refuse(session, ACCOUNT_NEEDED_WORDS);
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(words)) return refuse(session, CONTROL_WORDS);
  const said = words.trim();
  if (said === "") return refuse(session, SAY_SOMETHING_WORDS);
  const [owner = "", name = ""] = (app.config.forgeRepo ?? "").split("/");
  const repo = getRepo(app.db, owner, name);
  if (repo === undefined) return refuse(session, NO_CREW_WORDS);
  const told = await tell(app, user, repo, said);
  const answer = tellAnswer(told);
  if (!told.ok) return refuse(session, answer.text);
  const base = app.config.url ?? `http://localhost:${app.config.port ?? 3000}`;
  session.write(
    `${answer.text}${CRLF}${base}/${repo.ownerName}/${repo.name}/issues/${told.value.issue.number}${CRLF}`,
  );
  session.exit(0);
}
