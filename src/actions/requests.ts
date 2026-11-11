/**
 * Answering a stranger's request for an account, for a forge admin who is a
 * person (an agent and everyone else is told `not_found`). Every door calls
 * these: the page's buttons, the API and MCP.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { answerRequest, waitingRequests, type AccountRequest } from "../core/requests.ts";
import { setMember } from "../core/roles.ts";
import { getUserByName, type User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export type RequestError = "not_found" | "not_waiting";

function admin(actor: User | undefined): Result<User, "not_found"> {
  return actor?.isAdmin === true && actor.kind === "user" ? ok(actor) : err("not_found");
}

export function listRequests(app: App, actor: User | undefined): Result<AccountRequest[], "not_found"> {
  const who = admin(actor);
  return who.ok ? ok(waitingRequests(app.db)) : who;
}

function answer(
  app: App,
  actor: User | undefined,
  username: string,
  state: "allowed" | "declined",
): Result<AccountRequest, RequestError> {
  const who = admin(actor);
  if (!who.ok) return who;
  const done = answerRequest(app.db, username, state, who.value.id, new Date().toISOString());
  if (done === undefined) return err("not_waiting");
  // Allowed, they are a member under the newcomer's small quotas and with
  // no model grant: they can make things, and the crew spends nothing until
  // an admin gives credits.
  if (state === "allowed") {
    const person = getUserByName(app.db, username);
    if (person !== undefined) setMember(app.db, person.id, true, who.value.id, new Date());
  }
  app.bus.append({
    kind: state === "allowed" ? "account.allowed" : "account.declined",
    actorId: who.value.id,
    payload: { username: done.username },
  });
  return ok(done);
}

export const allowRequest = (app: App, actor: User | undefined, username: string) =>
  answer(app, actor, username, "allowed");

export const declineRequest = (app: App, actor: User | undefined, username: string) =>
  answer(app, actor, username, "declined");

/** Past this many waiting, the phone hears one count line, not one per person. */
export const LINES_EACH = 3;

/**
 * What an admin's phone hears at once: a line per request while a few wait,
 * then one line with the count (its id moves on every 25 more), linking to
 * the Waiting list where Allow and Decline are one tap. The notifier sends
 * each id once (`crew/notify.ts`), so a flood cannot spam the phone.
 */
export function requestLines(
  db: Database,
  user: User,
): { id: string; line: string; items: readonly string[]; link: string }[] {
  if (!user.isAdmin || user.kind !== "user") return [];
  const link = "/settings/accounts#waiting";
  const waiting = waitingRequests(db);
  if (waiting.length > LINES_EACH) {
    const id = `request:many:${Math.ceil(waiting.length / 25)}`;
    return [{ id, line: `${waiting.length} people ask for an account`, items: [id], link }];
  }
  return waiting.map((r) => {
    const id = `request:${r.username}`;
    const note = r.note === "" ? "" : `: ${r.note.slice(0, 120)}`;
    return { id, line: `${r.username} asks for an account${note}`, items: [id], link };
  });
}
