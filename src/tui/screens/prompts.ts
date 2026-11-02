/**
 * An app's prompt source in the terminal, its admin's: the Instagram account
 * whose top comment on the latest Reel becomes the crew's next tell, as
 * Settings › Prompts shows it and MCP `prompts` reads it. `a` connects one
 * (the token typed masked, then the hour), `f` fetches now, `d` removes it
 * after a confirm. Every rule is the action's (`actions/prompts.ts`); the
 * token is typed once, handed to `addPromptSource` and never held, drawn or
 * logged here, and the views carry none.
 */

import {
  addPromptSource,
  listPromptSources,
  removePromptSource,
  runPromptSource,
  type PromptSourceView,
} from "../../actions/prompts.ts";
import { REFRESH_AFTER_DAYS } from "../../crew/prompts.ts";
import type { Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import {
  ListState,
  ago,
  confirmScreen,
  drawList,
  hitList,
  later,
  promptScreen,
  runAsync,
  yesNo,
  type ListRow,
} from "./common.ts";

/** The action's refusals, in the page's words. */
const ERRORS: Record<string, string> = {
  not_found: "Only the app's admin manages its prompt source.",
  invalid_at: "The time is hours and minutes in UTC, like 15:00.",
  invalid_token: "Paste the long-lived token as Instagram gave it: one line, no spaces.",
  invalid_kind: "Only Instagram is known here.",
  already_connected: "An Instagram account is already connected here. Remove it first.",
  no_such_source: "No account by that id.",
  not_running: "The prompt routine is not running on this forge.",
};

const say = (code: string): string => ERRORS[code] ?? "That could not be done.";

/** Whether the viewer is offered the screen: a person, never an agent, whom the action lets list. */
export function mayManagePrompts(f: Session, repo: Repo): boolean {
  return f.user !== undefined && f.user.kind !== "agent" && listPromptSources(f.app, f.user, repo).ok;
}

/** The day the forge will refresh a token pasted or refreshed at `iso`. */
const refreshDay = (iso: string): string =>
  new Date(Date.parse(iso) + REFRESH_AFTER_DAYS * 24 * 3_600_000).toISOString().slice(0, 10);

const clean = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");

const row = (s: PromptSourceView): ListRow => ({
  title: `${s.account === "" ? "not read yet" : `@${clean(s.account)}`} · every day at ${s.atUtc} UTC`,
  secondary:
    (s.lastRanAt === null ? "Has not run yet." : `Last ran ${ago(s.lastRanAt)}. ${clean(s.lastSaid)}`) +
    ` Token refreshed ${ago(s.tokenRefreshedAt)}; refreshed again around ${refreshDay(s.tokenRefreshedAt)}.`,
});

export function promptsScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  let sources: PromptSourceView[] = [];
  let refused = false;
  let loaded = false;

  const read = (): void => {
    refused = !mayManagePrompts(f, repo);
    const listed = refused ? undefined : listPromptSources(f.app, f.user, repo);
    sources = listed?.ok === true ? listed.value : [];
    loaded = true;
    ctx.invalidate();
  };

  const add = (): void => {
    ctx.push(
      promptScreen(ctx, self, {
        title: "Connect Instagram",
        label: "Long-lived token (never shown again)",
        mask: true,
        onSubmit: (token) =>
          later(ctx, () =>
            promptScreen(ctx, self, {
              title: "Connect Instagram",
              label: "Every day at … UTC",
              value: "15:00",
              onSubmit: (at) => {
                const added = addPromptSource(f.app, f.user, repo, { kind: "instagram", token, at: at.trim() });
                if (!added.ok) return say(added.error);
                ctx.toast("Instagram is connected.");
                read();
                return undefined;
              },
            }),
          ),
      }),
    );
  };

  /** A fetch is a call to Instagram: one at a time, whatever the key repeat does. */
  let fetching = false;
  const fetchNow = (s: PromptSourceView): void => {
    if (fetching) return;
    fetching = true;
    runAsync(ctx, async () => {
      try {
        const ran = await runPromptSource(f.app, f.user, repo, s.id);
        if (!ran.ok) ctx.toast(say(ran.error), "danger");
        else ctx.toast(clean(ran.value.lastSaid) || "Fetched.");
      } finally {
        fetching = false;
      }
      read();
    });
  };

  const remove = (s: PromptSourceView): void => {
    const choose = (choice: number): void => {
      if (choice !== 0) return;
      const gone = removePromptSource(f.app, f.user, repo, s.id);
      ctx.toast(gone.ok ? "Instagram is disconnected." : say(gone.error), gone.ok ? undefined : "danger");
      read();
    };
    ctx.push(
      yesNo(
        ctx,
        confirmScreen(ctx, self, {
          title: "Remove prompt source",
          body: [`remove ${s.account === "" ? "the Instagram account" : `@${clean(s.account)}`}? y/n`],
          actions: [{ label: "Remove" }, { label: "Cancel", variant: "ghost" }],
          selected: 1,
          onChoose: choose,
        }),
        choose,
      ),
    );
  };

  const self: Screen = {
    title: "Prompts",
    get keys() {
      return refused
        ? [binding(["esc"], "back")]
        : [
            binding(["j", "k"], "move"),
            ...(sources.length === 0 ? [binding(["a"], "connect Instagram")] : []),
            ...(sources.length > 0 ? [binding(["f"], "fetch now"), binding(["d"], "remove it")] : []),
            binding(["r"], "refresh"),
            binding(["esc"], "back"),
          ];
    },
    load: async () => read(),
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      s.text(
        head!.x,
        head!.y,
        truncate(`${repo.ownerName}/${repo.name} · the top comment on the latest Reel becomes the next tell`, head!.w),
        style(c.mutedFg, c.bg),
        head!.x + head!.w,
      );
      if (refused || sources.length === 0) {
        emptyState(s, body!, c, {
          title: refused ? "Not yours" : loaded ? "No account connected" : "Reading…",
          body: refused ? say("not_found") : loaded ? "Press a to connect an Instagram account." : "Reading the prompt source",
        });
        return;
      }
      const rows = sources.map(row);
      drawList(s, body!, c, state, rows);
      hitList(ctx, body!, state, rows.length, {});
    },
    key(e) {
      if (refused) return false;
      if (state.key(e, sources.length)) return true;
      const selected = sources[state.index];
      if (e.key === "a" && sources.length === 0) add();
      else if (e.key === "f" && selected !== undefined) fetchNow(selected);
      else if (e.key === "d" && selected !== undefined) remove(selected);
      else if (e.key === "r") read();
      else return false;
      return true;
    },
  };
  return self;
}
