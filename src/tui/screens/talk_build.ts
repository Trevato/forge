/**
 * Talk builds an app, in the terminal (#11010): the same one prompt, versions,
 * diff, Restore and Publish the page has, through the same `actions/build.ts`
 * calls, so each is gated as the page is (the person's own conversation, a
 * writer of the repository) and a change here is what a web viewer's next
 * read shows: Restore announces its push and Publish merges the pull.
 */

import { buildState, BUILD_WORDS, publishBuild, restoreVersion, startBuild, versionDiff, type BuildState } from "../../actions/build.ts";
import { TALK_WORDS } from "../../actions/talk.ts";
import { offeredTemplates } from "../../core/app_templates.ts";
import { buildsOf } from "../../core/chat_build.ts";
import { getRepoById } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import type { Session } from "../session.ts";
import { fill, len, split } from "../ui/layout.ts";
import { ListState, Scroll, ago, confirmScreen, drawLines, drawList, promptScreen, runAsync, type ListRow } from "./common.ts";

const words = (error: string): string => BUILD_WORDS[error] ?? "That did not go through.";

/** What one version changed, file by file. */
function diffScreen(f: Session, ctx: Ctx, conversationId: string, number: number, subject: string): Screen {
  const scroll = new Scroll();
  let lines: { text: string; style: ReturnType<typeof style> }[][] | undefined;
  runAsync(ctx, async () => {
    const diff = await versionDiff(f.app, f.user, conversationId, number);
    const c = ctx.theme.c;
    lines = !diff.ok
      ? [[{ text: words(diff.error), style: style(c.mutedFg, c.bg) }]]
      : diff.value.files.length === 0
        ? [[{ text: "This version changed no files.", style: style(c.mutedFg, c.bg) }]]
        : diff.value.files.map((file) => [
            { text: `${file.path} `, style: style(c.fg, c.bg) },
            { text: `${file.status}, +${file.additions} -${file.deletions}`, style: style(c.mutedFg, c.bg) },
          ]);
    ctx.invalidate();
  });
  return {
    title: `v${number}: ${subject}`,
    keys: [binding(["j", "k"], "scroll"), binding(["esc"], "back")],
    render(area, s) {
      drawLines(s, area, ctx.theme.c, scroll, lines ?? []);
    },
    key(e) {
      if (scroll.key(e, lines?.length ?? 0)) return true;
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      return false;
    },
  };
}

/** One build: its versions, newest first; Enter shows a version's files, R restores it, P publishes. */
function buildScreen(f: Session, ctx: Ctx, conversationId: string, title: string): Screen {
  const state = new ListState();
  let current: BuildState | undefined;
  let note = "Loading…";
  const load = (): void => {
    runAsync(ctx, async () => {
      const got = await buildState(f.app, f.user, conversationId);
      if (got.ok) {
        current = got.value;
        note = "";
      } else note = words(got.error);
      ctx.invalidate();
    });
  };
  load();
  const versions = () => [...(current?.versions ?? [])].reverse();
  const screen: Screen = {
    title,
    keys: [binding(["j", "k"], "move"), binding(["enter"], "files changed"), binding(["R"], "restore"), binding(["P"], "publish"), binding(["r"], "reload"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(2), fill(1)]);
      const where = current === undefined ? "" : current.published ? `${current.repoName} · published ${current.productionUrl ?? ""}` : `${current.repoName} · preview ${current.previewUrl ?? "not up yet"}${current.previewState === null ? "" : ` (${current.previewState})`}`;
      s.text(head!.x, head!.y, truncate(where, head!.w), style(c.fg, c.bg), head!.x + head!.w);
      s.text(head!.x, head!.y + 1, truncate(note !== "" ? note : current?.versions.length === 0 ? "No version yet: the first change makes v1." : "R restores the chosen version as a new one; P publishes to production.", head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const rows: ListRow[] = versions().map((v) => ({ title: `v${v.number}  ${v.subject}`, meta: ago(v.date) }));
      state.clamp(rows.length);
      drawList(s, body!, c, state, rows);
    },
    key(e) {
      if (state.key(e, versions().length)) return true;
      if (e.ctrl || e.alt) return false;
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      if (e.key === "r") {
        load();
        return true;
      }
      const at = versions()[state.index];
      if (e.key === "enter" && at !== undefined) {
        ctx.push(diffScreen(f, ctx, conversationId, at.number, at.subject));
        return true;
      }
      if (e.key === "R" && at !== undefined && current?.published === false) {
        ctx.push(
          confirmScreen(ctx, screen, {
            title: "Restore",
            body: [`Make a new version holding exactly what v${at.number} held. History is kept.`],
            actions: [{ label: "Restore" }, { label: "Cancel" }],
            onChoose: (i) => {
              if (i !== 0) return;
              runAsync(ctx, async () => {
                const done = await restoreVersion(f.app, f.user, conversationId, at.number);
                ctx.toast(done.ok ? `Restored v${at.number} as a new version.` : words(done.error), done.ok ? "success" : "danger");
                load();
              });
            },
          }),
        );
        return true;
      }
      if (e.key === "P" && current !== undefined && !current.published) {
        ctx.push(
          confirmScreen(ctx, screen, {
            title: "Publish",
            body: ["Merge this build to the default branch and deploy production."],
            actions: [{ label: "Publish" }, { label: "Cancel" }],
            onChoose: (i) => {
              if (i !== 0) return;
              runAsync(ctx, async () => {
                const done = await publishBuild(f.app, f.user, conversationId);
                ctx.toast(done.ok ? "Published. Production is deploying." : words(done.error), done.ok ? "success" : "danger");
                load();
              });
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

/** The person's builds; `n` starts one from a prompt, `t` chooses the template it starts from. */
export function talkBuildScreen(f: Session, ctx: Ctx): Screen {
  const state = new ListState();
  let note = "";
  // "" is the forge's default template; the rest are those on offer to this person.
  let template = "";
  const items = () => (f.user === undefined ? [] : buildsOf(f.app.db, f.user.id));
  const screen: Screen = {
    title: "Build an app",
    keys: [binding(["j", "k"], "move"), binding(["enter"], "open"), binding(["n"], "new build"), binding(["t"], "template"), binding(["esc"], "back")],
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const text = note !== "" ? note : `Starting from ${template === "" ? "the default template" : template}; n says what to build, t changes the template.`;
      s.text(head!.x, head!.y, truncate(text, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w);
      const rows: ListRow[] = items().map((b) => ({
        title: b.title === "" ? "Untitled build" : b.title,
        secondary: (() => {
          const repo = getRepoById(f.app.db, b.repoId);
          return repo === undefined ? "" : `${repo.ownerName}/${repo.name}`;
        })(),
        meta: `${b.published ? "published · " : ""}${ago(b.updatedAt)}`,
      }));
      state.clamp(rows.length);
      drawList(s, body!, c, state, rows);
    },
    key(e) {
      if (state.key(e, items().length)) return true;
      const user = f.user;
      if (user === undefined || e.ctrl || e.alt) return false;
      if (e.key === "esc" || e.key === "q") {
        ctx.pop();
        return true;
      }
      if (e.key === "t") {
        const on = ["", ...offeredTemplates(f.app.db, user)];
        template = on[(on.indexOf(template) + 1) % on.length] ?? "";
        ctx.invalidate();
        return true;
      }
      if (e.key === "n") {
        ctx.push(
          promptScreen(ctx, screen, {
            title: "Build an app",
            label: "What do you want to build?",
            onSubmit: (prompt) => {
              if (prompt.trim() === "") return "Say what to build.";
              runAsync(ctx, async () => {
                const started = await startBuild(f.app, user, { prompt, ...(template === "" ? {} : { template }) });
                note = started.ok ? (started.value.said === undefined ? "Started; Enter opens it." : `The app is made, but ${TALK_WORDS[started.value.said][1]}.`) : words(started.error);
                ctx.invalidate();
              });
              return undefined;
            },
          }),
        );
        return true;
      }
      const at = items()[state.index];
      if (e.key === "enter" && at !== undefined) {
        ctx.push(buildScreen(f, ctx, at.conversationId, at.title === "" ? "Build" : at.title));
        return true;
      }
      return false;
    },
  };
  return screen;
}
