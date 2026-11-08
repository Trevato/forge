/**
 * Talk conversations in the terminal (#8814): the same list, New, Rename and
 * Archive/Restore /talk has, through the same `core/conversations.ts` calls,
 * so a change here is the next thing a web viewer's list or stream reads.
 * `a` flips between the live list and the archived one; Enter opens one,
 * to read it and, with `s`, say something in it through `talk()`.
 */

import { TALK_WORDS, talk } from "../../actions/talk.ts";
import {
  archiveConversation,
  createConversation,
  listConversations,
  listTurns,
  renameConversation,
  TITLE_MAX,
  TOO_MANY_WORDS,
  type Conversation,
} from "../../core/conversations.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate, wrap } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, Scroll, ago, drawLines, drawList, promptScreen, type ListRow } from "./common.ts";

const BAD_TITLE = `A title is up to ${TITLE_MAX} characters, on one line.`;

const WHO: Readonly<Record<string, string>> = { person: "You", agent: "Forge", tool: "Tool", confirm: "Asks" };

/** One conversation, newest turns last: j/k scroll, s says something in it, r reloads. */
function chatScreen(f: Session, ctx: Ctx, chat: Conversation): Screen {
  const scroll = new Scroll();
  let note = "";
  let width = 80;
  // Opened, and after r, the view sits on the newest turns.
  let follow = true;
  const lines = (): { text: string; style: ReturnType<typeof style> }[][] => {
    const c = ctx.theme.c;
    const listed = f.user === undefined ? undefined : listTurns(f.app.db, f.user.id, chat.id, { limit: 50 });
    const turns = listed?.ok ? listed.value : [];
    if (turns.length === 0) return [[{ text: "Nothing said yet; s says something.", style: style(c.mutedFg, c.bg) }]];
    return turns.flatMap((t) => [
      [{ text: `${WHO[t.role] ?? t.role}${t.replaced ? " · replaced" : ""} · ${ago(t.createdAt)}`, style: style(c.mutedFg, c.bg) }],
      ...t.text.split("\n").flatMap((l) => wrap(l, Math.max(10, width - 2))).map((l) => [{ text: l, style: style(c.fg, c.bg) }]),
      [],
    ]);
  };
  const screen: Screen = {
    get title() {
      return chat.title === "" ? "Untitled conversation" : chat.title;
    },
    keys: [binding(["j", "k"], "scroll"), binding(["s"], "say"), binding(["r"], "reload"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      width = area.w;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const text = note !== "" ? note : `/talk/${chat.id}${chat.archivedAt === null ? "" : " · archived: sending does not bring it back"}`;
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const all = lines();
      if (follow) scroll.to(all.length - body!.h, all.length);
      drawLines(s, body!, c, scroll, all);
    },
    key(e) {
      if (scroll.key(e, lines().length)) {
        follow = false;
        return true;
      }
      const user = f.user;
      if (user === undefined || e.ctrl || e.alt) return false;
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      if (e.key === "r") {
        note = "";
        follow = true;
        ctx.invalidate();
        return true;
      }
      if (e.key === "s") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Say",
            label: "to the forge, in this conversation",
            onSubmit: (words) => {
              const said = talk(f.app, user, words, [], "inject", chat.id);
              if (!said.ok) return TALK_WORDS[said.error][1];
              note = "Sent; r reloads to see the answer.";
              ctx.invalidate();
              return undefined;
            },
          }),
        );
        return true;
      }
      return false;
    },
  };
  return screen;
}

export function talkChatsScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let archived = false;
  let note = "";
  const items = (): Conversation[] => (f.user === undefined ? [] : listConversations(f.app.db, f.user.id, { archived }));
  const rows = (): ListRow[] =>
    items().map((c) => ({ title: c.title === "" ? "Untitled" : c.title, secondary: `/talk/${c.id}`, meta: `active ${ago(c.updatedAt)}` }));
  const say = (text: string): void => {
    note = text;
    ctx.invalidate();
  };

  const screen: Screen = {
    get title() {
      return archived ? "Archived conversations" : "Conversations";
    },
    keys: [
      binding(["j", "k"], "move cursor"),
      binding(["enter"], "open"),
      binding(["n"], "new"),
      binding(["r"], "rename"),
      binding(["x"], "archive or restore"),
      binding(["a"], "archived"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const text =
        note !== ""
          ? note
          : items().length === 0
            ? archived ? "Nothing archived." : "No conversations yet; n starts one."
            : archived ? "Archived; x brings one back." : "Your talks with the forge's agent; each opens at its /talk address.";
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      drawList(s, body!, c, state, rows());
    },
    key(e) {
      if (state.key(e, items().length)) return true;
      const user = f.user;
      if (user === undefined || e.ctrl || e.alt) return false;
      const here = items()[state.index];
      if (e.key === "a") {
        archived = !archived;
        state.index = 0;
        note = "";
        ctx.invalidate();
        return true;
      }
      if (e.key === "n") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "New conversation",
            label: "a title (optional)",
            onSubmit: (title) => {
              const made = createConversation(f.app.db, user.id);
              if (!made.ok) return TOO_MANY_WORDS;
              if (title.trim() !== "" && !renameConversation(f.app.db, user.id, made.value.id, title).ok) return BAD_TITLE;
              archived = false;
              state.index = 0;
              say(`Started /talk/${made.value.id}.`);
              return undefined;
            },
          }),
        );
        return true;
      }
      if (here === undefined) return false;
      if (e.key === "enter") {
        ctx.push(chatScreen(f, ctx, here));
        return true;
      }
      if (e.key === "r") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Rename conversation",
            label: "a title (empty clears it)",
            value: here.title,
            onSubmit: (title) => {
              if (!renameConversation(f.app.db, user.id, here.id, title).ok) return BAD_TITLE;
              say("Renamed.");
              return undefined;
            },
          }),
        );
        return true;
      }
      if (e.key === "x") {
        archiveConversation(f.app.db, user.id, here.id, !archived);
        say(archived ? "Restored." : "Archived.");
        return true;
      }
      return false;
    },
  };
  return screen;
}
