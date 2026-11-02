/**
 * Make it yours, from a repository screen's `:` palette (#810): the
 * terminal's door to the toolbar's button, for whoever cannot write the
 * repository. It is the fork screen (#606) the `F` key opens.
 */

import { COPIES_PER_DAY, makeItYours, type MakeItYoursError } from "../../actions/make_it_yours.ts";
import { APP_ALREADY_YOURS } from "../../actions/origin_app_words.ts";
import { PROVE_FIRST } from "../../actions/verify_words.ts";
import { NOT_A_MEMBER } from "../../core/roles.ts";
import { canWrite, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Command } from "../app/palette.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { field } from "../ui/widgets.ts";
import { confirmScreen, runAsync } from "./common.ts";
import { repoScreen } from "./repo.ts";
import { local } from "./where.ts";

/** A refusal in the words MCP `make_it_yours` uses; a new error kind fails the type check here. */
function refusalText(error: MakeItYoursError): string {
  switch (error.kind) {
    case "limit":
      return `at most ${COPIES_PER_DAY} copies a day; another after ${error.resetsAt}`;
    case "repository_limit":
    case "storage_limit":
      return error.message;
    case "invalid":
      return error.message;
    case "own":
      return APP_ALREADY_YOURS;
    case "not_member":
      return NOT_A_MEMBER;
    case "unverified":
      return PROVE_FIRST;
    case "not_found":
    case "unauthorized":
      return "no such app or repository (owner/name)";
  }
}

/**
 * `Y` on a repository you can see but do not own: a name (the original's) and
 * a visibility, the plan as MCP `make_it_yours` plans it, and a copy only
 * after a confirm. The copy opens on success.
 */
export function makeItYoursScreen(f: Session, ctx: Ctx, source: Repo): Screen {
  let name = source.name;
  let visibility: "public" | "private" = "private";
  let error: string | undefined;
  const from = `${source.ownerName}/${source.name}`;
  const input = (dryRun: boolean) => ({ dryRun, name, visibility });

  const refuse = (e: MakeItYoursError): void => {
    error = refusalText(e);
    ctx.toast(error, "danger");
  };

  const make = (): void =>
    runAsync(ctx, async () => {
      const made = await makeItYours(f.app, f.user, source, input(false));
      if (!made.ok) return refuse(made.error);
      const done = made.value.made;
      if (done === undefined) return;
      ctx.toast(`${done.repo.ownerName}/${done.repo.name} is yours`, "success");
      ctx.replace(repoScreen(f, ctx, local(f, done.repo)));
    });

  const plan = (): void =>
    runAsync(ctx, async () => {
      const planned = await makeItYours(f.app, f.user, source, input(true));
      if (!planned.ok) return refuse(planned.error);
      const p = planned.value;
      ctx.push(
        confirmScreen(ctx, self, {
          title: "Make it yours",
          body: p.existing
            ? [`You already have ${p.repo}: it opens.`]
            : [
                `${from} -> ${p.repo} (${p.visibility})`,
                `Copied: ${p.copied.join(", ")}.`,
                `Not copied: ${p.notCopied.join(", ")}.`,
                "It follows the original.",
                `Copies left today: ${p.copiesLeft}.`,
              ],
          actions: [{ label: p.existing ? "Open" : "Make it yours" }, { label: "Cancel" }],
          onChoose: (choice) => {
            if (choice === 0) make();
          },
        }),
      );
    });

  const self: Screen = {
    title: "Make it yours",
    keys: [
      binding(["enter"], "plan"),
      binding(["tab"], "visibility"),
      binding(["esc"], "cancel"),
    ],
    render(area, s) {
      const c = ctx.theme.c;
      s.text(
        area.x,
        area.y,
        truncate(`Make ${from} your own`, area.w),
        style(c.fg, c.bg),
        area.x + area.w,
      );
      const cursor = field(s, { x: area.x, y: area.y + 2, w: Math.min(60, area.w), h: 3 }, c, {
        label: `Name (${visibility}, tab to change)`,
        value: name,
        cursor: [...name].length,
        focused: true,
        ...(error === undefined
          ? { hint: "Code and history are copied, data and secrets are not." }
          : { error }),
      });
      ctx.setCursor(cursor);
    },
    key(e) {
      if (e.key === "enter") {
        plan();
        return true;
      }
      if (e.key === "tab") {
        visibility = visibility === "private" ? "public" : "private";
        error = undefined;
        return true;
      }
      if (e.key === "backspace") {
        name = [...name].slice(0, -1).join("");
        error = undefined;
        return true;
      }
      if (!e.ctrl && !e.alt && [...e.key].length === 1) {
        name += e.key;
        error = undefined;
        return true;
      }
      return false;
    },
  };
  return self;
}

export function yoursCommands(f: Session, ctx: Ctx, repo: Repo | undefined): Command[] {
  if (repo === undefined || f.user === undefined || canWrite(f.db, repo, f.user)) return [];
  return [
    {
      id: "make-it-yours",
      title: `${repo.ownerName}/${repo.name} — Make it yours`,
      hint: "fork it",
      run: () => ctx.push(makeItYoursScreen(f, ctx, repo)),
    },
  ];
}
