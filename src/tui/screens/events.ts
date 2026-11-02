/**
 * `v` on the About card — what happened on a repository, newest first.
 *
 * The same read as MCP `events` and the API (`eventsPage`): the audience
 * filter runs there, so a webhook's URL and an app's variable names reach
 * only the admins. One line per event — when, who, what — in the words the
 * activity feed uses (`eventActor`, `eventVerb`). Fifty at a time; `n` reads
 * the next page from the cursor the last one returned; `s` keeps only the
 * settings changes (the same `kind` filter), each saying from what to what;
 * `t` keeps only the kind of the row under the cursor, and again lifts it.
 */

import { EVENTS_LIMIT_DEFAULT, eventsPage } from "../../core/events_page.ts";
import type { ForgeEvent } from "../../core/events.ts";
import type { Repo } from "../../core/repos.ts";
import { getUsersByIds } from "../../core/users.ts";
import { eventActor, eventKindLabel, eventVerb } from "../../design/activity.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { emptyState } from "../ui/widgets.ts";
import { ListState, ago, drawList, type ListRow } from "./common.ts";
import { issueScreen } from "./issue.ts";
import { pullScreen } from "./pull.ts";
import { local } from "./where.ts";

/** The one kind `s` keeps. */
export const SETTINGS_KIND = "repo.settings_updated";

/** A setting's value on one line, clipped: `true`, `"a yard"`. */
function shown(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/** What a settings change moved: `requireReview false → true, …`. */
export function settingsMoved(event: ForgeEvent): string {
  const changed = event.payload["changed"];
  if (changed === null || typeof changed !== "object" || Array.isArray(changed)) return "";
  return Object.entries(changed as Record<string, { from?: unknown; to?: unknown }>)
    .map(([k, v]) => `${k} ${shown(v?.from)} → ${shown(v?.to)}`)
    .join(", ");
}

/** What an event is about, when it says: `#12`, or the branch a push moved. */
function subjectOf(event: ForgeEvent): string {
  if (event.kind === SETTINGS_KIND) return settingsMoved(event);
  const number = event.payload["number"];
  if (typeof number === "number") return `#${number}`;
  if (event.kind !== "push") return "";
  const updates = event.payload["updates"];
  const ref = Array.isArray(updates) ? (updates[0] as { ref?: unknown } | undefined)?.ref : undefined;
  return typeof ref === "string" ? ref.replace(/^refs\/heads\//, "") : "";
}

/** The issue or pull number an event names, and which; the web page's rule. */
export function opensOf(event: ForgeEvent): { pull: boolean; number: number } | undefined {
  const number = event.payload["number"];
  if (typeof number !== "number" || !Number.isInteger(number) || number < 1) return undefined;
  return { pull: event.kind.startsWith("pull."), number };
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
  const opens: ({ pull: boolean; number: number } | undefined)[] = [];
  let next: string | null = null;
  let kind: string | undefined;
  const kinds: string[] = [];
  const narrow = (to: string | undefined): void => {
    kind = to;
    count = 0;
    rows.length = 0;
    kinds.length = 0;
    opens.length = 0;
    state.index = 0;
    state.offset = 0;
    read();
  };
  const read = (cursor?: string): void => {
    const page = eventsPage(f.db, repo.id, f.user, EVENTS_LIMIT_DEFAULT, cursor, kind);
    count += page.items.length;
    rows.push(...eventRows(f, page.items));
    kinds.push(...page.items.map((e) => e.kind));
    opens.push(...page.items.map(opensOf));
    next = page.next_cursor;
    ctx.invalidate();
  };
  read();
  return {
    get title() {
      return kind === undefined ? "Events" : `Events · ${eventKindLabel(kind).toLowerCase()}`;
    },
    get keys() {
      return [
        binding(["j", "k"], "move"),
        ...(opens[state.index] === undefined ? [] : [binding(["enter"], "open")]),
        ...(next === null ? [] : [binding(["n"], "next page")]),
        binding(["s"], kind === SETTINGS_KIND ? "all events" : "settings only"),
        binding(["t"], kind === undefined ? "this kind only" : "all events"),
        binding(["esc", "q"], "back"),
      ];
    },
    render(area, s) {
      if (count === 0) {
        emptyState(s, area, ctx.theme.c, {
          title: kind === undefined ? "No events yet" : `No ${kind} events`,
          body: kind === undefined ? "Pushes, merges and deploys land here." : "Press t for every event.",
        });
        return;
      }
      drawList(s, area, ctx.theme.c, state, rows);
    },
    key(e) {
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "n") {
        if (next !== null) read(next);
      } else if (e.key === "enter") {
        const target = opens[state.index];
        if (target !== undefined) {
          const src = local(f, repo);
          ctx.push(target.pull ? pullScreen(f, ctx, src, target.number) : issueScreen(f, ctx, src, target.number));
        }
      } else if (e.key === "s") narrow(kind === SETTINGS_KIND ? undefined : SETTINGS_KIND);
      else if (e.key === "t") narrow(kind === undefined ? kinds[state.index] : undefined);
      else state.key(e, count);
      return true;
    },
  };
}
