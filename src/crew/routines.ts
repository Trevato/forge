/**
 * The routines run (#11011): once a minute the forge asks each admin's
 * routines whether one is due, and a due one posts at most three lines into
 * the person's Captain thread in Talk, where their next message is an
 * instruction the agent acts on at once. Only a report that says something
 * needs the person goes to their phone (`crew/notify.ts`'s URL and sender).
 * What a routine says is deterministic (`routine_report.ts`): no model, no spend.
 */

import { during } from "../perf/jobs.ts";
import type { App } from "../app.ts";
import { appendTurn, getConversation, listConversations, newConversation, renameConversation, type Conversation } from "../core/conversations.ts";
import { due, listRoutines, markRan, ROUTINE_NAMES, type RoutineKind } from "../core/talk_routines.ts";
import { getUserById, type User } from "../core/users.ts";
import { compose, facts, type Report } from "./routine_report.ts";
import { notifyUrlOf, post, type Sender } from "./notify.ts";

export const THREAD_TITLE = "Captain";

/** The thread routines post into: the stored one while it stands, else the person's "Captain" conversation, made once. */
export function captainThread(app: App, userId: string, stored: string | null): Conversation {
  const kept = stored === null ? undefined : getConversation(app.db, userId, stored);
  if (kept !== undefined && kept.archivedAt === null) return kept;
  const named = listConversations(app.db, userId).find((c) => c.title === THREAD_TITLE);
  if (named !== undefined) return named;
  const fresh = newConversation(app.db, userId);
  renameConversation(app.db, userId, fresh.id, THREAD_TITLE);
  return { ...fresh, title: THREAD_TITLE };
}

/** The text posted: the routine's name, then its lines. */
export const routineText = (kind: RoutineKind, report: Report): string => `**${ROUTINE_NAMES[kind]}**\n${report.lines.map((l) => `- ${l}`).join("\n")}`;

export interface Posted {
  readonly kind: RoutineKind;
  readonly conversationId: string;
  readonly pushed: boolean;
}

/** Run one routine now for `user`: post its lines, push only when it needs them. */
export async function runRoutine(app: App, user: User, kind: RoutineKind, now: Date, send: Sender = post): Promise<Posted> {
  const row = listRoutines(app.db, user.id).find((r) => r.kind === kind)!;
  const thread = captainThread(app, user.id, row.conversationId);
  const report = compose(kind, await facts(app, user, now.getTime(), row.lastAt === null ? undefined : Date.parse(row.lastAt)));
  appendTurn(app.db, user.id, thread.id, { role: "agent", text: routineText(kind, report) });
  // Marked before the push: a dead endpoint must not make the routine run again.
  markRan(app.db, user.id, kind, thread.id, now);
  const url = report.needs ? notifyUrlOf(app.db, user.id) : undefined;
  let pushed = false;
  if (url !== undefined) {
    const base = app.config.url ?? "";
    pushed = await send(url, `${ROUTINE_NAMES[kind]}: ${report.lines[0] ?? ""}\n${base}/talk/${thread.id}`, { title: ROUTINE_NAMES[kind] });
  }
  return { kind, conversationId: thread.id, pushed };
}

/** One pass over every admin's routines: each due one runs. A failing routine is logged and does not stop the rest. */
export async function runDue(app: App, now: Date, send: Sender = post): Promise<Posted[]> {
  const done: Posted[] = [];
  const admins = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE is_admin = 1 AND kind = 'user'").all();
  for (const { id } of admins) {
    const user = getUserById(app.db, id);
    if (user === undefined) continue;
    for (const r of listRoutines(app.db, id)) {
      if (!due(r, now.getTime())) continue;
      try {
        done.push(await runRoutine(app, user, r.kind, now, send));
      } catch (error) {
        app.log.warn("routine failed", { kind: r.kind, error: String(error) });
      }
    }
  }
  return done;
}

/** Start the minute clock; returns what stops it. The first pass waits 30 s so the boot is not slowed. */
export function startRoutines(app: App, signal: AbortSignal): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const loop = (wait: number): void => {
    timer = setTimeout(() => {
      if (signal.aborted) return;
      void during("routines", () => runDue(app, new Date())).finally(() => loop(60_000));
    }, wait);
    timer.unref();
  };
  loop(30_000);
  return () => clearTimeout(timer);
}
