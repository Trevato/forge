/**
 * The feed in the terminal — what happened, ranked, as the page and MCP
 * `feed` give it (`readFeed`), and `r` to reply.
 *
 * A reply is a comment on the issue or pull the post links to: the same
 * `addCommentThrough` the issue and pull screens call, offered on the same
 * posts to the same people as the page's Reply (`feed/reply.ts`). `l` likes
 * the post under the cursor and a second press takes it back: the page's
 * Like, behind the same `readInteraction` check (`feed/likes.ts`). Twenty
 * posts at a time; `n` reads the next page from the cursor the last returned.
 */

import { addCommentThrough } from "../../actions/issues.ts";
import { getIssue } from "../../core/issues.ts";
import { parseCursor, readFeed } from "../../feed/feed.ts";
import type { FeedItem } from "../../feed/rank.ts";
import { readInteraction } from "../../feed/interact.ts";
import { toggleLike } from "../../feed/likes.ts";
import { replyTarget } from "../../feed/reply.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { stepLine } from "../../flow/path.ts";
import { emptyState } from "../ui/widgets.ts";
import { ListState, ago, drawList, errorText, runAsync, type ListRow } from "./common.ts";
import type { PaletteEntry } from "./entries.ts";
import { Composer } from "./thread.ts";

const PAGE = 20;

const oneLine = (text: string): string => text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ");

/** `♥ 3` for a post the person likes, `♡ 3` for one others do; nothing when nobody does. */
const likeMark = (item: FeedItem): string =>
  item.liked === true ? `♥ ${item.likes ?? 1}` : (item.likes ?? 0) > 0 ? `♡ ${item.likes}` : "";

export function feedScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  const composer = new Composer();
  const items: FeedItem[] = [];
  let next: string | null = null;

  const read = (cursor?: string): void => {
    if (f.user === undefined) return;
    const parsed = cursor === undefined ? undefined : parseCursor(cursor);
    const page = readFeed(f.db, f.user, { limit: PAGE, ...(parsed ? { cursor: parsed } : {}) });
    items.push(...page.items);
    next = page.next_cursor;
    ctx.invalidate();
  };
  read();

  /** The post under the cursor, when it is about a thread this person may reply on. */
  const selected = () => {
    const item = items[state.index];
    return item === undefined ? undefined : replyTarget(f.db, f.user, item);
  };

  /** `l`: like the post under the cursor, or take the like back; the row then shows the count the forge answers. */
  const like = (): void => {
    const item = items[state.index];
    if (item === undefined || f.user === undefined) return;
    const act = readInteraction(f.db, f.user, { item: item.id, kind: "liked", app: item.app }, ["liked"]);
    if (!act.ok) {
      ctx.toast(act.error.message, "danger");
      return;
    }
    const now = toggleLike(f.db, f.user.id, act.value.itemId, act.value.target.repoId);
    items[state.index] = { ...item, likes: now.likes, liked: now.liked };
    ctx.toast(now.liked ? "liked" : "like taken back", "success");
    ctx.invalidate();
  };

  const submit = (): void => {
    const at = selected();
    if (at === undefined) return;
    const issue = getIssue(f.db, at.repo.id, at.thread.number);
    if (issue === undefined) return;
    const body = composer.value;
    runAsync(ctx, async () => {
      const added = await addCommentThrough(f.app, f.user, at.repo, issue, body);
      if (!added.ok) {
        ctx.toast(errorText(added.error), "danger");
        return;
      }
      composer.close();
      ctx.toast("reply posted", "success");
    });
  };

  return {
    title: "Feed",
    get keys() {
      return [
        binding(["j", "k"], "move"),
        ...(selected() === undefined ? [] : [binding(["r"], "reply")]),
        ...(items.length === 0 ? [] : [binding(["l"], "like")]),
        ...(next === null ? [] : [binding(["n"], "next page")]),
        binding(["esc", "q"], "back"),
      ];
    },
    render(area, s) {
      const c = ctx.theme.c;
      if (items.length === 0) {
        emptyState(s, area, c, { title: "Nothing in the feed yet", body: "Posts about the apps you can see land here." });
        return;
      }
      const [list, box] = split(area, "v", [fill(1), len(composer.height())]);
      const rows: ListRow[] = items.map((item) => ({
        title: oneLine(`${item.actor ?? item.app} ${item.what}`),
        secondary: item.app,
        meta: [likeMark(item), ago(item.at)].filter((m) => m !== "").join("  "),
        ...(item.step === undefined ? {} : { note: stepLine(item.step) }),
      }));
      drawList(s, list!, c, state, rows);
      if (composer.open) composer.render(s, box!, c, ctx);
    },
    paste: (text) => composer.paste(text),
    key(e) {
      if (composer.open) {
        const out = composer.key(e);
        if (out === "submit") submit();
        else if (out === "cancel") composer.close();
        return true;
      }
      if (e.key === "esc" || e.key === "q") ctx.pop();
      else if (e.key === "r") {
        const at = selected();
        if (at !== undefined) composer.start(`Reply on ${at.thread.owner}/${at.thread.name} #${at.thread.number}`);
      } else if (e.key === "l") like();
      else if (e.key === "n") {
        if (next !== null) read(next);
      } else state.key(e, items.length);
      return true;
    },
  };
}

/** The feed, as the page's `/feed` has it. */
export const entry: PaletteEntry = {
  id: "feed",
  title: "Feed",
  hint: "what happened, ranked; r replies on a post about an issue or pull, l likes",
  offered: (session) => session.user !== undefined,
  run: (session, ctx) => ctx.push(feedScreen(session, ctx)),
};
