/**
 * One app: its environments, what each is doing, and the four things a
 * person does about one — open it, read its log, deploy it again, stop it.
 *
 * Production is the first row and a preview per open pull follows, in pull
 * order. Every state is a word beside a dot, and a failed environment
 * carries its error on the row and in full in the panel beneath, because
 * "failed" alone is the one thing this screen must never say.
 *
 * Opening a private app goes through `openEnvUrl`, which returns a URL
 * carrying a signed grant; the screen hands that to `openLink`, so over SSH
 * it lands on the reader's clipboard with words that say so.
 */

import {
  appView,
  openEnvUrl,
  redeployEnv,
  sshCommandFor,
  stopEnv,
  type AppView,
} from "../../actions/apps.ts";
import { tellCrew } from "../../actions/crew.ts";
import type { EnvStatus } from "../../apps/runtime.ts";
import { envPull } from "../../apps/data.ts";
import { getIssuesByRef } from "../../core/issues.ts";
import { canWrite, type Repo } from "../../core/repos.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import { ITALIC, style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { card, emptyState } from "../ui/widgets.ts";
import type { Session } from "../session.ts";
import {
  ListState,
  ago,
  confirmScreen,
  drawFacts,
  drawList,
  errorText,
  hitList,
  live,
  metaOf,
  openLink,
  promptScreen,
  runAsync,
  type ListRow,
} from "./common.ts";
import { APP_EVENTS, envTone } from "./apps.ts";
import { runScreen } from "./run.ts";
import { envLabel, runsScreen } from "./runs.ts";
import { local, whereRows, whereStrip } from "./where.ts";
import { openAppTerminal } from "./apptty.ts";

/** The panel under the list: state, commit, url, since, run, error. */
const PANEL = 8;

export function appScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  let view: AppView | undefined;
  let titles = new Map<string, { title: string }>();
  let failed: string | undefined;
  const state = new ListState();
  const src = local(f, repo);
  const mayWrite = (): boolean => canWrite(f.db, repo, f.user);

  const reload = (): void => {
    const read = appView(f.app, f.user, repo);
    if (!read.ok) {
      failed =
        read.error === "not_found"
          ? "this repository is not an app"
          : errorText(read.error);
      ctx.invalidate();
      return;
    }
    failed = undefined;
    view = read.value;
    // The pull behind each preview, named — one grouped read for the page.
    titles = getIssuesByRef(
      f.db,
      view.environments.flatMap((env) => {
        const number = envPull(env.env);
        return number === undefined ? [] : [{ repoId: repo.id, number }];
      }),
    );
    ctx.invalidate();
  };

  const envs = (): EnvStatus[] => view?.environments ?? [];
  const selected = (): EnvStatus | undefined => envs()[state.index];

  const nameOf = (env: EnvStatus): string => {
    const number = envPull(env.env);
    if (number === undefined) return "production";
    const title = titles.get(`${repo.id}#${number}`)?.title;
    return title === undefined ? `pull #${number}` : `pull #${number} ${title}`;
  };

  /** The one line that says what an environment is doing, in words. */
  const stateText = (env: EnvStatus): string => {
    switch (env.state) {
      case "running":
        return env.since === undefined
          ? "running"
          : `running since ${ago(env.since)}`;
      case "deploying":
        return `deploying ${env.commitOid.slice(0, 7)}`;
      case "failed":
        return `failed: ${env.error ?? "the deploy did not finish"}`;
      case "asleep":
        return env.since === undefined
          ? "asleep; wakes on a request"
          : `asleep since ${ago(env.since)}; wakes on a request`;
      case "stopped":
        return env.dormant === undefined
          ? "stopped"
          : `asleep since ${ago(env.dormant.since)}; nobody touched the change since ${ago(env.dormant.idleSince)}`;
    }
  };

  const open = (env: EnvStatus | undefined): void => {
    if (env === undefined) return;
    const url = openEnvUrl(f.app, f.user, repo, env.env);
    if (!url.ok) {
      ctx.toast(errorText(url.error), "danger");
      return;
    }
    if (env.state !== "running")
      ctx.toast(
        `${envLabel(env.env)} is ${env.state}; the page will say so`,
        "attn",
      );
    openLink(ctx, url.value);
  };

  const openLog = (env: EnvStatus | undefined): void => {
    if (env === undefined) return;
    if (env.runId === undefined) {
      ctx.toast(`${envLabel(env.env)} has no run yet`, "attn");
      return;
    }
    ctx.push(runScreen(f, ctx, repo, env.runId));
  };

  const redeploy = (env: EnvStatus | undefined): void => {
    if (env === undefined) return;
    const label = envLabel(env.env);
    runAsync(ctx, async () => {
      ctx.toast(`redeploying ${label}…`);
      const queued = await redeployEnv(f.app, f.user, repo, env.env);
      if (!queued.ok) {
        ctx.toast(errorText(queued.error), "danger");
        return;
      }
      ctx.toast(
        queued.value === undefined
          ? `${label}: nothing to do`
          : `${label}: deploy queued — enter opens its log`,
        "success",
      );
      reload();
    });
  };

  const stop = (env: EnvStatus | undefined): void => {
    if (env === undefined) return;
    const label = envLabel(env.env);
    ctx.push(
      confirmScreen(ctx, screen, {
        title: `Stop ${label}`,
        body: [
          `${label} goes offline until it is deployed again.`,
          "Its data is kept; r brings it back.",
        ],
        actions: [
          { label: "Keep it running", variant: "ghost" },
          { label: "Stop", variant: "danger" },
        ],
        onChoose: (choice) => {
          if (choice !== 1) return;
          runAsync(ctx, async () => {
            ctx.toast(`stopping ${label}…`);
            const stopped = await stopEnv(f.app, f.user, repo, env.env);
            if (!stopped.ok) ctx.toast(errorText(stopped.error), "danger");
            else ctx.toast(`${label} stopped`, "success");
            reload();
          });
        },
      }),
    );
  };

  /** `T`: a sentence becomes an issue, handed to whichever builder is free. */
  const tell = (): void => {
    ctx.push(
      promptScreen(ctx, screen, {
        title: "Tell the crew",
        label: "What should change?",
        hint: "Becomes an issue, and starts whichever builder on the crew is free.",
        onSubmit: (text) => {
          if (text === "") return "say something first";
          return (async () => {
            const told = await tellCrew(f.app, f.user, repo, text);
            if (!told.ok) {
              ctx.toast(errorText(told.error), "danger");
              return;
            }
            const { routed } = told.value;
            ctx.toast(
              routed === undefined
                ? "told, but nobody is on the crew to take it yet"
                : `${routed.builder.user.username} is on it`,
              "success",
            );
          })();
        },
      }),
    );
  };

  const screen: Screen = {
    title: `${repo.ownerName}/${repo.name} · app`,
    get keys() {
      const writer = mayWrite();
      return [
        binding(["j", "k"], "move"),
        binding(["o"], "open"),
        binding(["t"], "terminal"),
        binding(["T"], "tell the crew", { disabled: !writer }),
        binding(["enter"], "log"),
        binding(["r"], "redeploy", { disabled: !writer }),
        binding(["s"], "stop", { disabled: !writer }),
        binding(["l"], "runs"),
        binding(["R"], "refresh"),
      ];
    },
    load(signal) {
      live(f, signal, { repoId: repo.id, kinds: APP_EVENTS }, reload);
      reload();
      return Promise.resolve();
    },
    render(area, s) {
      const c = ctx.theme.c;
      const [strip, head, list, panel] = split(area, "v", [
        len(whereRows(src)),
        len(2),
        fill(1),
        len(Math.min(PANEL, Math.max(0, area.h - whereRows(src) - 6))),
      ]);
      whereStrip(s, strip!, c, f, src, ctx.icons);
      if (failed !== undefined) {
        emptyState(s, list!, c, { title: failed });
        return;
      }
      if (view === undefined) return;
      const right = head!.x + head!.w;
      s.text(
        head!.x,
        head!.y,
        truncate(
          metaOf(
            `slug ${view.app.slug}`,
            `${view.app.access} app`,
            view.app.previewData === "copy"
              ? "previews start from a copy of production's data"
              : "previews start empty",
          ),
          head!.w,
        ),
        style(c.mutedFg, c.bg),
        right,
      );
      if (!view.serving)
        s.text(
          head!.x,
          head!.y + 1,
          truncate(errorText("no_runtime"), head!.w),
          style(c.attn, c.bg, ITALIC),
          right,
        );
      const rows = envs();
      if (rows.length === 0) {
        emptyState(s, list!, c, {
          title: view.serving ? "Nothing running yet" : "Nothing runs",
          body: view.serving
            ? "Production starts from the default branch once it has a commit."
            : errorText("no_runtime"),
        });
        return;
      }
      drawList(
        s,
        list!,
        c,
        state,
        rows.map((env): ListRow => {
          const tone = envTone(env.state);
          return {
            title: nameOf(env),
            ...(tone === undefined ? { hollow: true } : { tone }),
            secondary: stateText(env),
            meta: metaOf(
              env.commitOid === "" ? "" : env.commitOid.slice(0, 7),
              env.since === undefined ? "" : ago(env.since),
            ),
          };
        }),
      );
      hitList(ctx, list!, state, rows.length, {
        open: (index) => openLog(rows[index]),
      });
      const env = selected();
      if (env === undefined || panel!.h < 3) return;
      const inner = card(s, panel!, c, {
        title: nameOf(env),
        tone: env.state === "failed" ? "danger" : "default",
      });
      drawFacts(
        s,
        inner,
        c,
        [
          ["state", stateText(env)],
          ["commit", env.commitOid === "" ? "—" : env.commitOid],
          ["url", env.url],
          ...(sshCommandFor(f.app, view.app, env.env) === undefined
            ? []
            : [
                ["ssh", sshCommandFor(f.app, view.app, env.env) ?? ""] as const,
              ]),
          ["since", env.since === undefined ? "—" : ago(env.since)],
          ["run", env.runId === undefined ? "none yet" : "enter opens the log"],
          ...(env.error === undefined ? [] : [["error", env.error] as const]),
        ],
        c.card,
      );
    },
    key(e) {
      if (state.key(e, envs().length)) return true;
      if (e.key === "enter") {
        openLog(selected());
        return true;
      }
      if (e.key === "o") {
        open(selected());
        return true;
      }
      if (e.key === "t") {
        const env = selected();
        if (env) void openAppTerminal(f, ctx, repo, env.env);
        return true;
      }
      if (e.key === "T" && mayWrite()) {
        tell();
        return true;
      }
      if (e.key === "r" && mayWrite()) {
        redeploy(selected());
        return true;
      }
      if (e.key === "s" && mayWrite()) {
        stop(selected());
        return true;
      }
      if (e.key === "l") {
        ctx.push(runsScreen(f, ctx, repo));
        return true;
      }
      if (e.key === "R") {
        reload();
        return true;
      }
      return false;
    },
  };
  return screen;
}
