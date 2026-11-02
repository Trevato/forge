/**
 * An app's variables in the terminal, an admin's (#7232): the names and
 * scopes the settings page lists, from a repository's `:` palette. `a` adds
 * or replaces one — a name, a value typed masked, a scope — and `d` unsets
 * the one under the cursor after a confirm, through the same actions as the
 * page and MCP `app_env`, refused in the same words. A value is write-only:
 * it is held in a closure from the masked field to the action and is never
 * drawn, toasted or logged.
 */

import { deleteAppEnvVar, listAppEnv, setAppEnvVar } from "../../actions/apps.ts";
import {
  APP_ENV_ERRORS,
  APP_ENV_NO_SUCH,
  APP_ENV_NOT_SET,
  SCOPE_WORDS,
} from "../../actions/app_env_words.ts";
import { APP_ENV_SCOPES, type AppEnvName } from "../../core/app_env.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { canAdmin, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Command } from "../app/palette.ts";
import { style } from "../term/style.ts";
import { wrap } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import type { Session } from "../session.ts";
import {
  ListState,
  confirmScreen,
  drawList,
  later,
  pickerScreen,
  promptScreen,
  runAsync,
  type ListRow,
} from "./common.ts";

/** The palette's "Variables", for an admin of a repository that is an app. */
export function appEnvCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || f.user === undefined) return [];
  if (getAppByRepo(f.app.db, repo.id) === undefined || !canAdmin(f.app.db, repo, f.user)) return [];
  return [
    {
      id: "app-env",
      title: `${repo.ownerName}/${repo.name} — Variables`,
      hint: "the app's environment: names and scopes, never a value",
      run: () => ctx.push(appEnvScreen(f, ctx, repo)),
    },
  ];
}

export function appEnvScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  let rows: AppEnvName[] = [];
  // Whether the action lists for this viewer; it decides, not the screen.
  let canChange = false;
  let note = "";
  const reload = (): void => {
    const listed = listAppEnv(f.app, f.user, repo);
    canChange = listed.ok;
    rows = listed.ok ? listed.value : [];
    state.clamp(rows.length);
    ctx.invalidate();
  };
  reload();
  const say = (text: string): void => {
    note = text;
    reload();
  };
  const where = (v: { scope: AppEnvName["scope"] }): string =>
    v.scope === "all" ? "everywhere" : `for ${SCOPE_WORDS[v.scope]}`;

  const add = (): Screen =>
    promptScreen(ctx, screen, {
      title: "Set a variable",
      label: "name, like STRIPE_SECRET_KEY",
      placeholder: "ADMIN_PASSWORD",
      onSubmit: (name) => {
        if (name === "") return "A variable needs a name.";
        return later(ctx, () =>
          promptScreen(ctx, screen, {
            title: name,
            label: "the value (sealed, never shown again)",
            mask: true,
            onSubmit: (value) =>
              later(ctx, () =>
                pickerScreen(ctx, screen, {
                  title: `Where ${name} goes`,
                  items: APP_ENV_SCOPES.map((s) => ({ id: s, label: SCOPE_WORDS[s] })),
                  onPick: ([scope]) =>
                    runAsync(ctx, async () => {
                      const set = await setAppEnvVar(f.app, f.user, repo, name, value, scope);
                      say(
                        set.ok
                          ? `${set.value.name} is set ${where(set.value)}.`
                          : (APP_ENV_ERRORS[set.error] ?? APP_ENV_NOT_SET),
                      );
                    }),
                }),
              ),
          }),
        );
      },
    });

  const unset = (v: AppEnvName): Screen =>
    confirmScreen(ctx, screen, {
      title: "Unset this variable",
      body: [`${v.name}, ${SCOPE_WORDS[v.scope]}`, "The app restarts without it."],
      actions: [{ label: "Keep", variant: "ghost" }, { label: "Unset", variant: "danger" }],
      onChoose: (i) => {
        if (i !== 1) return;
        runAsync(ctx, async () => {
          const removed = await deleteAppEnvVar(f.app, f.user, repo, v.name, v.scope);
          say(removed.ok ? `${v.name} is unset ${where(v)}.` : APP_ENV_NO_SUCH);
        });
      },
    });

  const lines = (): ListRow[] =>
    rows.map((v) => ({
      title: v.name,
      meta: `${SCOPE_WORDS[v.scope]} · set ${v.updatedAt.slice(0, 16).replace("T", " ")} UTC`,
    }));

  const screen: Screen = {
    title: "Variables",
    get keys() {
      return [
        ...(canChange ? [binding(["a"], "set one"), binding(["d"], "unset")] : []),
        binding(["j", "k"], "move cursor"),
      ];
    },
    render(area, s) {
      const c = ctx.theme.c;
      const text =
        note !== ""
          ? note
          : !canChange
            ? "An app's variables are its admin's."
            : rows.length === 0
              ? `${repo.ownerName}/${repo.name} sets no variable. Press a to set one.`
              : `${rows.length} set for ${repo.ownerName}/${repo.name}; a value is never shown.`;
      // A refusal is the page's sentence, whole: it wraps rather than cuts.
      const said = wrap(text, Math.max(1, area.w)).slice(0, 3);
      const [head, list] = split(area, "v", [len(said.length), fill(1)]);
      said.forEach((line, i) =>
        s.text(head!.x, head!.y + i, line, style(c.mutedFg, c.bg), head!.x + head!.w),
      );
      drawList(s, list!, c, state, lines());
    },
    key(e) {
      if (state.key(e, rows.length)) return true;
      if (e.ctrl || e.alt || !canChange) return false;
      if (e.key === "a") {
        ctx.push(add());
        return true;
      }
      const v = rows[state.index];
      if (e.key === "d" && v !== undefined) {
        ctx.push(unset(v));
        return true;
      }
      return false;
    },
  };
  return screen;
}
