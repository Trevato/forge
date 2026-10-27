/**
 * Deploys: an app's production deploys, each with the pulls it carries.
 *
 * A production deploy is a `kind=deploy` run with no issue, so no run list
 * a pull or an issue shows holds one. This is the list that does, read
 * through `listRepoRuns` (so it is gated like every other run read) and
 * joined to `deploy_pull` in one grouped read for `carries #3 #5`.
 *
 * Below the deploys, a signed-in viewer sees the app's open pulls, one line
 * each: `#N title · check <word> · <preview address or none>`. A guest sees
 * none.
 *
 * A writer redeploys production with `D` and stops it with `S`, each after a
 * one-line confirm, through `redeployEnv` and `stopEnv` — the page's and MCP
 * `app_deploy`'s actions — and is told the answer in the page's words
 * (`env_words.ts`). A stopped production offers only `D`; a reader sees
 * neither key.
 */

import {
  appPace,
  appPullLines,
  appSideLines,
  appView,
  appVisitors,
  redeployEnv,
  stopEnv,
  type AppPullLine,
} from "../../actions/apps.ts";
import { envLabel, envRefusalText, redeployedText, stoppedText } from "../../actions/env_words.ts";
import { trendLine, visitorsLine } from "../../apps/vitals.ts";
import { listRepoRuns } from "../../actions/runs.ts";
import { carriedByRuns, carriesText } from "../../core/carried.ts";
import { canWrite, type Repo } from "../../core/repos.ts";
import type { Run } from "../../core/runs.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import { confirmScreen, drawList, hitList, runAsync } from "./common.ts";
import { RunList, openRunLog, runRows } from "./runlist.ts";

const LIMIT = 50;

/** Production deploys the actor may read, newest first. */
function readDeploys(f: Session, repo: Repo): Run[] {
  const listed = listRepoRuns(f.app, f.user, repo, {
    kind: "deploy",
    env: "production",
    limit: LIMIT,
  });
  return listed.ok ? listed.value : [];
}

/** Production's state word, and what the actor may do to it from here. */
interface Production {
  readonly state: string;
  readonly redeploy: boolean;
  readonly stop: boolean;
}

/**
 * The keys are offered by `canWrite`, the rule `requireWriter` applies; it
 * only decides what to show. `redeployEnv` and `stopEnv` gate again and
 * refuse in words (`env_words.ts`) — an unverified writer still sees `D`.
 */
function readProduction(f: Session, repo: Repo): Production {
  const view = appView(f.app, f.user, repo);
  if (!view.ok) return { state: "", redeploy: false, stop: false };
  const state = view.value.environments.find((e) => e.env === "production")?.state ?? "";
  const writer = view.value.serving && f.user !== undefined && canWrite(f.db, repo, f.user);
  return { state, redeploy: writer, stop: writer && state !== "" && state !== "stopped" };
}

/** `#N title · check <word> · <preview address or none>` */
function pullLine(p: AppPullLine): string {
  const title = p.title.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "").trim();
  return `#${p.number} ${title} · check ${p.check} · ${p.preview ?? "none"}`;
}

export function deploysScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const list = new RunList(f);
  let carries = new Map<string, number[]>();
  let loaded = false;
  let visitors = "";
  let trend = "";
  let pace = "";
  let side: string[] = [];
  let pulls: AppPullLine[] = [];
  let production: Production = { state: "", redeploy: false, stop: false };

  const read = (): void => {
    const runs = readDeploys(f, repo);
    list.set(runs);
    carries = carriedByRuns(
      f.db,
      runs.map((r) => r.id),
    );
    const seen = appVisitors(f.app, f.user, repo);
    visitors = seen === undefined ? "" : visitorsLine(seen);
    trend = seen === undefined ? "" : trendLine(seen.loadDays);
    pace = appPace(f.app, f.user, repo);
    side = appSideLines(f.app, f.user, repo);
    pulls = appPullLines(f.app, f.user, repo);
    production = readProduction(f, repo);
    loaded = true;
    ctx.invalidate();
  };

  const open = (run: Run): void => openRunLog(f, ctx, repo, run);

  const confirm = (verb: "Redeploy" | "Stop", act: () => Promise<{ text: string; refused: boolean }>): void => {
    ctx.push(
      confirmScreen(ctx, screen, {
        title: `${verb} ${envLabel("production")}`,
        body: [`${verb} ${envLabel("production")} of ${repo.ownerName}/${repo.name}?`],
        actions: [{ label: "Cancel", variant: "ghost" }, { label: verb }],
        selected: 1,
        onChoose: (choice) => {
          if (choice !== 1) return;
          runAsync(ctx, async () => {
            const answer = await act();
            ctx.toast(answer.text, answer.refused ? "danger" : undefined);
            read();
          });
        },
      }),
    );
  };

  const redeploy = (): void =>
    confirm("Redeploy", async () => {
      const queued = await redeployEnv(f.app, f.user, repo, "production");
      return queued.ok
        ? { text: redeployedText("production", queued.value), refused: false }
        : { text: envRefusalText(queued.error), refused: true };
    });

  const stop = (): void =>
    confirm("Stop", async () => {
      const stopped = await stopEnv(f.app, f.user, repo, "production");
      return stopped.ok
        ? { text: stoppedText("production"), refused: false }
        : { text: envRefusalText(stopped.error), refused: true };
    });

  const screen: Screen = {
    title: "Deploys",
    get keys() {
      return [
        binding(["j", "k"], "move"),
        binding(["enter"], "open the log"),
        binding(["r"], "refresh (the open pulls below the deploys: check, preview)"),
        ...(production.redeploy ? [binding(["D"], "redeploy production")] : []),
        ...(production.stop ? [binding(["S"], "stop production")] : []),
      ];
    },
    load: async () => read(),
    render(area, s) {
      const c = ctx.theme.c;
      const [head, upper, tail] = split(area, "v", [
        len(1 + (visitors === "" ? 0 : 1) + (trend === "" ? 0 : 1) + (pace === "" ? 0 : 1) + side.length),
        fill(1),
        len(pulls.length === 0 ? 0 : pulls.length + 1),
      ]);
      const body = upper;
      pulls.forEach((p, i) =>
        s.text(
          tail!.x,
          tail!.y + 1 + i,
          truncate(pullLine(p), tail!.w),
          style(c.mutedFg, c.bg),
          tail!.x + tail!.w,
        ),
      );
      if (pulls.length > 0)
        s.text(tail!.x, tail!.y, truncate("Open pulls", tail!.w), style(c.mutedFg, c.bg), tail!.x + tail!.w);
      s.text(
        head!.x,
        head!.y,
        truncate(
          `${repo.ownerName}/${repo.name} · production deploys${production.state === "" ? "" : ` · ${production.state}`}`,
          head!.w,
        ),
        style(c.mutedFg, c.bg),
        head!.x + head!.w,
      );
      [visitors, trend, pace, ...side]
        .filter((line) => line !== "")
        .forEach((line, i) =>
          s.text(head!.x, head!.y + 1 + i, truncate(line, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w),
        );
      if (list.runs.length === 0) {
        emptyState(s, body!, c, {
          title: loaded ? "No deploys" : "Reading…",
          body: loaded
            ? "Nothing has been deployed to production yet."
            : "Reading the deploys",
        });
        return;
      }
      const rows = runRows(list.runs, new Map(), ctx.icons).map((row, i) => {
        const text = carriesText(carries.get(list.runs[i]!.id) ?? []);
        return text === ""
          ? row
          : { ...row, secondary: [row.secondary, text].filter((t) => t !== "").join(" · ") };
      });
      drawList(s, body!, c, list.state, rows);
      hitList(ctx, body!, list.state, rows.length, {
        open: (index) => {
          const run = list.runs[index];
          if (run !== undefined) open(run);
        },
      });
    },
    key(e) {
      if (list.state.key(e, list.runs.length)) return true;
      if (e.key === "enter") {
        const run = list.selected;
        if (run !== undefined) open(run);
        return true;
      }
      if (e.key === "r") {
        read();
        return true;
      }
      if (e.key === "D" && production.redeploy) {
        redeploy();
        return true;
      }
      if (e.key === "S" && production.stop) {
        stop();
        return true;
      }
      return false;
    },
  };
  return screen;
}
