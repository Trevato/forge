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
  findConversations,
  pageAround,
  type Found,
  listConversations,
  listTurns,
  renameConversation,
  TITLE_MAX,
  TOO_MANY_WORDS,
  type Conversation,
} from "../../core/conversations.ts";
import { filesOf, repoOf, stepOf } from "../../core/talk_steps.ts";
import { workspaceOf } from "../../actions/talk_workspace.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate, wrap } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, Scroll, ago, drawLines, drawList, promptScreen, type ListRow } from "./common.ts";

const BAD_TITLE = `A title is up to ${TITLE_MAX} characters, on one line.`;

const WHO: Readonly<Record<string, string>> = { person: "You", agent: "Forge", tool: "Tool", confirm: "Asks" };

/**
 * One conversation, newest turns last: j/k scroll, s says something in it, r
 * reloads. `hit` is a search result's turn: the view opens on the page around
 * it, that turn marked ▶. p flips to what the chat is working on, the web's
 * pane beside the chat: the repository, what runs and where, the newest pull's
 * diff, and the files the chat touched. Turns are read when the view opens
 * and on r, not on every draw.
 */
function chatScreen(f: Session, ctx: Ctx, chat: Conversation, hit?: string): Screen {
  const scroll = new Scroll();
  let note = "";
  let width = 80;
  // Opened, and after r, the view sits on the newest turns.
  let follow = hit === undefined;
  // The page around a search hit, until r goes back to the newest; `mark` is the hit's first line.
  let around = hit;
  let mark = 0;
  let placed = false;
  let pane = false;
  type Turns = Exclude<ReturnType<typeof listTurns>, { ok: false }>["value"];
  let turns: Turns = [];
  let recent: Turns = [];
  let repo: string | undefined;
  const load = (): void => {
    if (f.user === undefined) return;
    const before = around === undefined ? undefined : pageAround(f.app.db, f.user.id, chat.id, around);
    const listed = listTurns(f.app.db, f.user.id, chat.id, { limit: 50, ...(before === undefined ? {} : { before }) });
    turns = listed.ok ? listed.value : [];
    const last = before === undefined ? listed : listTurns(f.app.db, f.user.id, chat.id, { limit: 50 });
    recent = last.ok ? last.value : [];
    repo = repoOf(recent);
  };
  load();
  const paneLines = (): string[] => {
    if (repo === undefined || f.user === undefined) return ["No repository yet."];
    const ws = workspaceOf(f.app, f.user, repo);
    if (ws === undefined) return ["Not a repository you can see."];
    const files = filesOf(recent, repo);
    return [
      `${repo} · ${ws.pull === undefined ? "Production" : `Pull #${String(ws.pull)}`}`,
      "",
      ws.url === undefined ? "Nothing running yet." : `Preview: ${ws.url}`,
      ws.pull === undefined ? "No open pull yet." : `Diff: /${repo}/pulls/${String(ws.pull)}/files`,
      "",
      ...(files.length === 0 ? ["No files touched yet."] : ["Files touched:", ...files.map((p) => `  ${p}`)]),
    ];
  };
  const lines = (): { text: string; style: ReturnType<typeof style> }[][] => {
    const c = ctx.theme.c;
    if (pane) return paneLines().flatMap((l) => wrap(l, Math.max(10, width - 2))).map((l) => [{ text: l, style: style(c.fg, c.bg) }]);
    if (turns.length === 0) return [[{ text: "Nothing said yet; s says something.", style: style(c.mutedFg, c.bg) }]];
    let n = 0;
    return turns.flatMap((t) => {
      if (t.id === around) mark = n;
      const step = t.role === "tool" ? stepOf(t.text) : undefined;
      const own = (step === undefined ? t.text : [step.label, ...step.details.map((d) => `  ${d}`)].join("\n")).split("\n").flatMap((l) => wrap(l, Math.max(10, width - 2)));
      n += own.length + 2;
      return [
        [{ text: `${t.id === around ? "▶ " : ""}${WHO[t.role] ?? t.role}${t.replaced ? " · replaced" : ""} · ${ago(t.createdAt)}`, style: style(c.mutedFg, c.bg) }],
        ...own.map((l) => [{ text: l, style: style(c.fg, c.bg) }]),
        [],
      ];
    });
  };
  const screen: Screen = {
    get title() {
      return chat.title === "" ? "Untitled conversation" : chat.title;
    },
    keys: [binding(["j", "k"], "scroll"), binding(["s"], "say"), binding(["r"], "reload"), binding(["p"], "pane"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      width = area.w;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const text = note !== "" ? note : `/talk/${chat.id}${repo === undefined ? "" : ` · working on ${repo}`}${chat.archivedAt === null ? "" : " · archived: sending does not bring it back"}`;
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const all = lines();
      if (follow || pane) scroll.to(pane ? 0 : all.length - body!.h, all.length);
      else if (around !== undefined && !placed) {
        scroll.to(mark, all.length);
        placed = true;
      }
      drawLines(s, body!, c, scroll, all);
    },
    key(e) {
      if (scroll.key(e, lines().length)) {
        follow = false;
        return true;
      }
      const user = f.user;
      if (user === undefined || e.ctrl || e.alt) return false;
      if (e.key === "p" || (pane && e.key === "esc")) {
        pane = !pane;
        ctx.invalidate();
        return true;
      }
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      if (e.key === "r") {
        note = "";
        follow = true;
        around = undefined;
        load();
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
  // A search's results replace the list until esc; each opens its chat at the matching turn.
  let found: { typed: string; hits: Found[] } | undefined;
  const items = (): Conversation[] =>
    found !== undefined ? found.hits.map((h) => h.conversation) : f.user === undefined ? [] : listConversations(f.app.db, f.user.id, { archived });
  const rows = (): ListRow[] =>
    found !== undefined
      ? found.hits.map((h) => ({
          title: h.conversation.title === "" ? "Untitled" : h.conversation.title,
          secondary: `${h.conversation.archivedAt === null ? "" : "archived · "}${h.snippet.replace(/\s+/g, " ")}`,
          meta: `/talk/${h.conversation.id}`,
        }))
      : items().map((c) => ({ title: c.title === "" ? "Untitled" : c.title, secondary: `/talk/${c.id}`, meta: `active ${ago(c.updatedAt)}` }));
  const say = (text: string): void => {
    found = undefined;
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
      binding(["/"], "search"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const text =
        note !== ""
          ? note
          : found !== undefined
            ? found.hits.length === 0 ? `Nothing found for "${found.typed}"; esc goes back.` : `Found for "${found.typed}" (archived ones too); enter opens at the match, esc goes back.`
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
      if (e.key === "esc" && found !== undefined) {
        found = undefined;
        state.index = 0;
        ctx.invalidate();
        return true;
      }
      if (e.key === "/") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Search conversations",
            label: "words in a title or in what was said",
            onSubmit: (typed) => {
              const hits = findConversations(f.app.db, user.id, typed);
              found = typed.trim() === "" ? undefined : { typed: typed.trim(), hits };
              state.index = 0;
              note = "";
              ctx.invalidate();
              return undefined;
            },
          }),
        );
        return true;
      }
      if (e.key === "a" && found === undefined) {
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
        ctx.push(chatScreen(f, ctx, here, found?.hits[state.index]?.turnId));
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
