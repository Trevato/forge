/**
 * `v` on the About card — what happened on a repository, newest first.
 *
 * The same read as MCP `events` and the API (`eventsPage`): the audience
 * filter runs there, so a webhook's URL and an app's variable names reach
 * only the admins. One line per event — when, who, what — in the words the
 * activity feed uses (`eventActor`, `eventVerb`). Fifty at a time; `n` reads
 * the next page from the cursor the last one returned.
 */

import { EVENTS_LIMIT_DEFAULT, eventsPage } from "../../core/events_page.ts";
import type { ForgeEvent } from "../../core/events.ts";
import type { Repo } from "../../core/repos.ts";
import { getUsersByIds } from "../../core/users.ts";
import { eventActor, eventVerb } from "../../design/activity.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { emptyState } from "../ui/widgets.ts";
import { ListState, ago, drawList, type ListRow } from "./common.ts";

/** What an event is about, when it says: `#12`, or the branch a push moved. */
function subjectOf(event: ForgeEvent): string {
  const number = event.payload["number"];
  if (typeof number === "number") return `#${number}`;
  if (event.kind !== "push") return "";
  const updates = event.payload["updates"];
  const ref = Array.isArray(updates) ? (updates[0] as { ref?: unknown } | undefined)?.ref : undefined;
  return typeof ref === "string" ? ref.replace(/^refs\/heads\//, "") : "";
}

/** One row per event: `who verb: subject`, with its age beside it. */
function eventRows(f: Session, events: readonly ForgeEvent[]): ListRow[] {
  const actors = getUsersByIds(f.db, events.map((e) => e.actorId ?? "").filter(Boolean));
  return events.map((event) => {
    const who = eventActor(event, event.actorId === null ? undefined : actors.get(event.actorId)?.username);
    const subject = subjectOf(event);
    const title = `${who} ${eventVerb(event)}${subject === "" ? "" : `: ${subject}`}`;
    return { title: title.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " "), meta: ago(event.createdAt) };
  });
}

export function eventsScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  let count = 0;
  const rows: ListRow[] = [];
  let next: string | null = null;
  const read = (cursor?: string): void => {
    const page = eventsPage(f.db, repo.id, f.user, EVENTS_LIMIT_DEFAULT, cursor);
    count += page.items.length;
    rows.push(...eventRows(f, page.items));
    next = page.next_cursor;
    ctx.invalidate();
  };
  read();
  return {
    title: "Events",
    get keys() {
      return [
        binding(["j", "k"], "move"),
        ...(next === null ? [] : [binding(["n"], "next page")]),
        binding(["esc", "q"], "back"),
      ];
    },
    render(area, s) {
      if (count === 0) {
        emptyState(s, area, ctx.theme.c, {
          title: "No events yet",
          body: "Pushes, merges and deploys land here.",
        });
        return;
      }
      drawList(s, area, ctx.theme.c, state, rows);
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "n") {
        if (next !== null) read(next);
      } else state.key(e, count);
      return true;
    },
  };
}
