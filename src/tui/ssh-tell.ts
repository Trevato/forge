/**
 * `ssh <forge> tell <words>`: the crew told in one line from any shell. An
 * exec of `tell` calls the same `tell()` the web composer
 * and the terminal use, as the account the presented key belongs to, with
 * `from` null (on an app's login: through the app terminal's gate, to the
 * app's repository, `from` the app's production address), and prints the told line and the full address of the issue.
 * The words are the rest of the command line as given: no shell, no
 * expansion, no `eval`; a control character is refused before anything runs.
 */

import { tell } from "../actions/tell.ts";
import { SAY_SOMETHING_WORDS } from "../actions/tell_words.ts";
import { appGate, ttyRefusalText } from "../apps/tty.ts";
import { appsRuntime } from "../apps/runtime.ts";
import type { App } from "../app.ts";
import type { AppRecord } from "../core/apps.ts";
import { getRepo, getRepoById } from "../core/repos.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import type { EnvName } from "../apps/data.ts";
import type { SshSession } from "../ssh/server.ts";
import { tellAnswer } from "./screens/tell.ts";
import { AUTONOMY_FAILED_WORDS, firstAsk } from "../actions/first_ask.ts";
import { nextStepsFor } from "../core/next-steps.ts";
import { crewCanRun } from "../web/studio/crew_key.ts";

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
  door?: { app: AppRecord; env: EnvName },
): Promise<void> {
  // On an app's login the app terminal's gate decides first, in its words:
  // an app the viewer cannot enter is not there, and nothing is recorded.
  if (door !== undefined) {
    const refusal = appGate(app, user, door);
    const crew = getRepoById(app.db, door.app.repoId);
    const runtime = appsRuntime(app);
    if (refusal !== undefined || crew === undefined || runtime === undefined)
      return refuse(session, ttyRefusalText(refusal ?? "not_found", session.username));
    return told(app, session, user, words, crew, runtime.urlFor(door.app, "production"));
  }
  return told(app, session, user, words, undefined, null);
}

async function told(
  app: App,
  session: SshSession,
  user: User | undefined,
  words: string,
  appRepo: Repo | undefined,
  from: string | null,
): Promise<void> {
  if (user === undefined) return refuse(session, ACCOUNT_NEEDED_WORDS);
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(words)) return refuse(session, CONTROL_WORDS);
  const said = words.trim();
  if (said === "") return refuse(session, SAY_SOMETHING_WORDS);
  // A claimed forge's first ask makes a new app, as the page's does:
  // never an issue on the forge's own source.
  if (appRepo === undefined && (await isFirstAsk(app, user))) return firstTold(app, session, user, said);
  const [owner = "", name = ""] = (app.config.forgeRepo ?? "").split("/");
  const repo = appRepo ?? getRepo(app.db, owner, name);
  if (repo === undefined) return refuse(session, NO_CREW_WORDS);
  const result = await tell(app, user, repo, said, 1, from, from !== null);
  const answer = tellAnswer(result);
  if (!result.ok) return refuse(session, answer.text);
  const base = app.config.url ?? `http://localhost:${app.config.port ?? 3000}`;
  session.write(
    `${answer.text}${CRLF}${base}/${repo.ownerName}/${repo.name}/issues/${result.value.issue.number}${CRLF}`,
  );
  session.exit(0);
}

/** Whether this is the person's first ask on a forge spawned for them: it makes an app. */
async function isFirstAsk(app: App, user: User): Promise<boolean> {
  const steps = await nextStepsFor(app, user);
  return steps?.some((s) => s.key === "tell" && !s.done) === true;
}

async function firstTold(app: App, session: SshSession, user: User, said: string): Promise<void> {
  const first = await firstAsk(app, user, said, crewCanRun(app));
  if (!first.ok) return refuse(session, first.error.words);
  const { repo, told, autonomyFailed } = first.value;
  if (!told.ok) return refuse(session, tellAnswer(told).text);
  const base = app.config.url ?? `http://localhost:${app.config.port ?? 3000}`;
  session.write(
    `${tellAnswer(told).text}${CRLF}${autonomyFailed ? `${AUTONOMY_FAILED_WORDS}${CRLF}` : ""}${base}/${repo.ownerName}/${repo.name}/issues/${told.value.issue.number}${CRLF}`,
  );
  session.exit(0);
}
