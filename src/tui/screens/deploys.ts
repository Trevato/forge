/**
 * Deploys: an app's production deploys, each with the pulls it carries.
 *
 * A production deploy is a `kind=deploy` run with no issue, so no run list
 * a pull or an issue shows holds one. This is the list that does, read
 * through `listRepoRuns` (so it is gated like every other run read) and
 * joined to `deploy_pull` in one grouped read for `carries #3 #5`.
 *
 * Under production's deploys, anyone who may read the repository sees a
 * "Previews" group: one row per open pull with a preview environment,
 * `#N title · <state> · <address>`, the state in the studio's words
 * (`envPhrase`) and tone, all from one runtime `status()` read
 * (`appPreviews`). `j`/`k` walk from the last deploy into it, and Enter on a
 * preview opens that pull's screen. An app with none says `No previews.`.
 *
 * Below those, a signed-in viewer sees the app's open pulls, one line
 * each: `#N title · check <word> · <preview address or none>`. A guest sees
 * none.
 *
 * Until production first runs, the head carries one line of where the app
 * stands (`apps/onboarding.ts`, #10295), as the app page says it.
 *
 * A writer who is a person — never an agent — gets `b`: type a commit's
 * full id and `previewBuild` serves it at `<slug>--b<sha7>`, as the API's
 * `POST …/builds/preview` does (`docs/features/build-preview.md`).
 *
 * A writer redeploys production with `D` and stops it with `S`, each after a
 * one-line confirm, through `redeployEnv` and `stopEnv` — the page's and MCP
 * `app_deploy`'s actions — and is told the answer in the page's words
 * (`env_words.ts`). A stopped production offers only `D`; a reader sees
 * neither key.
 *
 * With a preview selected, `D` and `S` do the same to that pull's preview
 * (`redeploy #N's preview? y/n`), the env name read from its `appPreviews`
 * row; `S` is offered only while it runs, and a reader sees neither.
 *
 * A writer — whom the MCP tool `probe` lets knock — gets `p`: the same
 * `probeApp` against the running production app, every door tried as
 * nobody, a user and an admin, read-only, one line per door.
 *
 * A private app's writer who is a person — never an agent — gets `m`: the
 * people the app names, with `a` and `d` to let one in or out after a plan
 * and a confirm, as MCP `app_members` does (`appmembers.ts`). A public app
 * names nobody and is not offered `m`.
 *
 * The app's admin sees its own domains under the head, each with its state
 * in the settings page's words (`domain_words.ts`), and gets `n`: a domains
 * screen where `+` adds one, `c` checks the selected one's DNS proof now and
 * says the record still needed, `o` writes down the old DNS records before a
 * cut-over (`keepOldRecords`) and shows them under the list, and `-` removes
 * it after `remove <host>? y/n`
 * — `addAppDomain`, `checkAppDomain` and `removeAppDomain`, the page's and
 * MCP `app_domains`' actions. `listAppDomains` is the admin gate: anyone it
 * refuses sees neither the domains nor the key.
 *
 * The admin who is a person also gets `i`: the app's prompt source, the
 * Instagram account whose comments become the crew's tell (`prompts.ts`).
 * That admin also gets `X`, stop running as an app: after typing
 * `<owner>/<name>` it calls `disableApp`, as Settings does, and the screen
 * then says the repository is no longer an app.
 */

import { appOnboardingLine } from "../../apps/onboarding.ts";
import {
  appPace,
  appPreviews,
  appPullLines,
  appSideLines,
  appView,
  disableApp,
  appVisitors,
  redeployEnv,
  stopEnv,
  type AppPreview,
  type AppPullLine,
} from "../../actions/apps.ts";
import { previewBuild, previewBuildRefusalText } from "../../actions/build_preview.ts";
import { STOP_APP } from "../../web/danger_words.ts";
import { envPhrase } from "../../apps/env_phrase.ts";
import { recordsFromLine, type OldRecord } from "../../core/domains.ts";
import {
  addAppDomain,
  checkAppDomain,
  keepOldRecords,
  listAppDomains,
  removeAppDomain,
  type AppDomainView,
} from "../../actions/domains.ts";
import {
  NO_SUCH_DOMAIN,
  domainAddedText,
  domainRefusalText,
  domainRemovedText,
  domainSaidText,
  domainStateWord,
  recordsInWords,
} from "../../actions/domain_words.ts";
import type { EnvName } from "../../apps/data.ts";
import { envLabel, envRefusalText, redeployedText, stoppedText } from "../../actions/env_words.ts";
import { trendLine, visitorsLine } from "../../apps/vitals.ts";
import { egressModeSentence, undeclaredHosts } from "../../apps/egress_report.ts";
import { egressSetting } from "../../core/capacity.ts";
import { listRepoRuns } from "../../actions/runs.ts";
import { carriedByRuns, carriesText } from "../../core/carried.ts";
import { appsRuntime } from "../../apps/runtime.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { canAdmin, canWrite, type Repo } from "../../core/repos.ts";
import type { Knock } from "../../contract/probe.ts";
import { probeApp, type ProbeRow } from "../../contract/probes.ts";
import type { Run } from "../../core/runs.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import type { Rect } from "../term/screen.ts";
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
  promptScreen,
  runAsync,
  yesNo,
  type ListRow,
} from "./common.ts";
import { RunList, openRunLog, runRows } from "./runlist.ts";
import { envTone } from "./runwords.ts";
import { pullScreen } from "./pull.ts";
import { local } from "./where.ts";
import { appMembersScreen } from "./appmembers.ts";
import { mayManagePrompts, promptsScreen } from "./prompts.ts";

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
  /** Its forge.json sets `app.always_on`: production never sleeps. */
  readonly alwaysOn: boolean;
}

/**
 * The keys are offered by `canWrite`, the rule `requireWriter` applies; it
 * only decides what to show. `redeployEnv` and `stopEnv` gate again and
 * refuse in words (`env_words.ts`) — an unverified writer still sees `D`.
 */
function readProduction(f: Session, repo: Repo): Production {
  const view = appView(f.app, f.user, repo);
  if (!view.ok) return { state: "", redeploy: false, stop: false, alwaysOn: false };
  const env = view.value.environments.find((e) => e.env === "production");
  const state = env?.state ?? "";
  const writer = view.value.serving && f.user !== undefined && canWrite(f.db, repo, f.user);
  return {
    state,
    redeploy: writer,
    stop: writer && state !== "" && state !== "stopped",
    alwaysOn: env?.alwaysOn === true,
  };
}

/** `#N title · check <word> · <preview address or none>` */
function pullLine(p: AppPullLine): string {
  const title = p.title.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "").trim();
  return `#${p.number} ${title} · check ${p.check} · ${p.preview ?? "none"}`;
}

/** Previews drawn before the group scrolls. */
const PREVIEW_ROWS = 6;

/** `#N title · live · https://app--4.apps.example`, the dot in the studio's tone. */
export function previewRow(p: AppPreview): ListRow {
  const title = p.title.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "").trim();
  const { word, tone } = envPhrase(p.env);
  const t = envTone(tone);
  return { title: `#${p.number} ${title} · ${word} · ${p.env.url}`, ...(t === undefined ? {} : { tone: t }) };
}

/**
 * "Reached, not declared": the hosts the app's code called that `forge.json`
 * does not declare, as the app's page says them, then the line to add them.
 * Only a writer is told; nothing is drawn with none.
 */
function egressLines(f: Session, repo: Repo): string[] {
  if (!canWrite(f.db, repo, f.user)) return [];
  const record = getAppByRepo(f.db, repo.id);
  if (record === undefined) return [];
  const declared = appsRuntime(f.app)?.liveFor(record, "production")?.cell?.egress ?? [];
  const { reached, entries } = undeclaredHosts(f.app.config.dataDir, repo.id, declared);
  if (reached.length === 0) return [];
  return [
    "Reached, not declared",
    ...reached.map((r) => `  ${r.host}:${r.port} · ${r.count}× · last seen ${ago(r.last)}`),
    egressModeSentence(egressSetting(f.db)),
    `Add them to the egress list in forge.json: ${JSON.stringify(entries)}`,
  ];
}

export function deploysScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const list = new RunList(f);
  let carries = new Map<string, number[]>();
  let loaded = false;
  let visitors = "";
  let trend = "";
  let pace = "";
  let side: string[] = [];
  /** Where a new or migrated app stands until production runs, or "". */
  let onboarding = "";
  let egress: string[] = [];
  let pulls: AppPullLine[] = [];
  /** The app's previews, or undefined for anyone who may not see them. */
  let previews: AppPreview[] | undefined;
  const previewState = new ListState();
  /** Which list the cursor is in: production's deploys, or the previews under them. */
  let inPreviews = false;
  let production: Production = { state: "", redeploy: false, stop: false, alwaysOn: false };
  let members = false;
  let prompts = false;
  let stoppable = false;
  let isApp = true;
  /** The app's domains, or undefined for anyone `listAppDomains` refuses. */
  let domains: AppDomainView[] | undefined;

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
    const standing = appOnboardingLine(f.app, repo, f.user);
    onboarding = standing === undefined ? "" : `${standing.text}${standing.href === undefined ? "" : ` ${standing.href}`}`;
    egress = egressLines(f, repo);
    pulls = appPullLines(f.app, f.user, repo);
    previews = appPreviews(f.app, f.user, repo);
    previewState.clamp(previews?.length ?? 0);
    if ((previews?.length ?? 0) === 0) inPreviews = false;
    production = readProduction(f, repo);
    // The action's gate: a person who can write, never an agent.
    members =
      getAppByRepo(f.db, repo.id)?.access === "private" &&
      f.user !== undefined &&
      f.user.kind !== "agent" &&
      canWrite(f.db, repo, f.user);
    const listed = listAppDomains(f.app, f.user, repo);
    domains = listed.ok ? listed.value : undefined;
    prompts = mayManagePrompts(f, repo);
    isApp = getAppByRepo(f.db, repo.id) !== undefined;
    stoppable = isApp && f.user !== undefined && f.user.kind !== "agent" && canAdmin(f.db, repo, f.user);
    loaded = true;
    ctx.invalidate();
  };

  const open = (run: Run): void => openRunLog(f, ctx, repo, run);
  const openPreview = (p: AppPreview): void => ctx.push(pullScreen(f, ctx, local(f, repo), p.number));
  // The MCP tool's gate, read once: only a writer is offered the knock.
  const mayProbe = canWrite(f.db, repo, f.user);
  // Offered to a person who writes; `previewBuild` gates again, agents included.
  const mayBuild = mayProbe && f.user !== undefined && f.user.kind !== "agent";

  /** `b`: ask for a commit's id, then serve it as a build preview and say where. */
  const previewACommit = (): void => {
    ctx.push(
      promptScreen(ctx, screen, {
        title: "Preview a build",
        label: "Commit id",
        placeholder: "40 hex characters",
        hint: "Served at its own address for a while, with a copy of production's data.",
        onSubmit: (typed) => {
          const sha = typed.trim().toLowerCase();
          if (!/^[0-9a-f]{40}$/.test(sha)) return "Give the full 40-character commit id.";
          runAsync(ctx, async () => {
            const asked = await previewBuild(f.app, f.user, repo, sha);
            if (!asked.ok) ctx.toast(previewBuildRefusalText(asked.error), "danger");
            else ctx.toast(`Previewing ${sha.slice(0, 7)} at ${asked.value.url}`, "success");
            read();
          });
          return undefined;
        },
      }),
    );
  };

  /** Redeploy or stop `env` and say the answer in the page's words; one path for production and previews. */
  const act = async (verb: "Redeploy" | "Stop", env: EnvName): Promise<{ text: string; refused: boolean }> => {
    if (verb === "Redeploy") {
      const queued = await redeployEnv(f.app, f.user, repo, env);
      return queued.ok
        ? { text: redeployedText(env, queued.value), refused: false }
        : { text: envRefusalText(queued.error), refused: true };
    }
    const stopped = await stopEnv(f.app, f.user, repo, env);
    return stopped.ok
      ? { text: stoppedText(env), refused: false }
      : { text: envRefusalText(stopped.error), refused: true };
  };

  /**
   * Production asks with buttons; a preview asks `redeploy #N's preview? y/n`.
   * Either way the action gates again and a refusal toasts in red.
   */
  const confirm = (verb: "Redeploy" | "Stop", env: EnvName, pull?: number): void => {
    const go = (): void =>
      runAsync(ctx, async () => {
        const answer = await act(verb, env);
        ctx.toast(answer.text, answer.refused ? "danger" : undefined);
        read();
      });
    ctx.push(
      confirmScreen(
        ctx,
        screen,
        pull === undefined
          ? {
              title: `${verb} ${envLabel(env)}`,
              body: [`${verb} ${envLabel(env)} of ${repo.ownerName}/${repo.name}?`],
              actions: [{ label: "Cancel", variant: "ghost" }, { label: verb }],
              selected: 1,
              onChoose: (choice) => choice === 1 && go(),
            }
          : {
              title: `${verb} preview`,
              body: [`${verb.toLowerCase()} #${pull}'s preview? y/n`],
              actions: [{ label: verb }, { label: "Cancel", variant: "ghost" }],
              yesNo: true,
              onChoose: (choice) => choice === 0 && go(),
            },
      ),
    );
  };

  /** The selected preview and what may be done to it, or undefined outside the group or for a reader. */
  const previewActs = (): { p: AppPreview; stop: boolean } | undefined => {
    const p = inPreviews && production.redeploy ? previews?.[previewState.index] : undefined;
    return p === undefined ? undefined : { p, stop: p.env.state !== "stopped" };
  };

  const name = `${repo.ownerName}/${repo.name}`;
  /** `X`: type the name, then `disableApp` as Settings does; wrong names change nothing. */
  const stopApp = (): void => {
    ctx.push(
      promptScreen(ctx, screen, {
        title: STOP_APP,
        label: `Type ${name} to confirm`,
        hint: "All environments stop, data goes; code stays.",
        placeholder: name,
        onSubmit: (typed) => {
          if (typed !== name) return `Type ${name} to confirm.`;
          const done = disableApp(f.app, f.user, repo);
          ctx.toast(done.ok ? "no longer an app" : "That app is not there, or it is not yours to stop.", done.ok ? undefined : "danger");
          read();
          return undefined;
        },
      }),
    );
  };

  const screen: Screen = {
    title: "Deploys",
    get keys() {
      const preview = previewActs();
      return [
        binding(["j", "k"], "move"),
        binding(["enter"], inPreviews ? "open the pull" : "open the log"),
        binding(["r"], "refresh (the open pulls below the deploys: check, preview)"),
        ...(inPreviews
          ? [
              ...(preview !== undefined ? [binding(["D"], "redeploy preview")] : []),
              ...(preview?.stop === true ? [binding(["S"], "stop preview")] : []),
            ]
          : [
              ...(production.redeploy ? [binding(["D"], "redeploy production")] : []),
              ...(production.stop ? [binding(["S"], "stop production")] : []),
            ]),
        ...(mayProbe ? [binding(["p"], "probe the running app's doors")] : []),
        ...(members ? [binding(["m"], "members")] : []),
        ...(domains !== undefined ? [binding(["n"], "the app's own domains")] : []),
        ...(prompts ? [binding(["i"], "prompt source (Instagram)")] : []),
        ...(stoppable ? [binding(["X"], STOP_APP.toLowerCase())] : []),
        ...(mayBuild ? [binding(["b"], "preview a commit")] : []),
      ];
    },
    load: async () => read(),
    render(area, s) {
      const c = ctx.theme.c;
      const named = domainsLine(domains);
      const drawPreviews = (r: Rect): void => {
        s.text(r.x, r.y, truncate("Previews", r.w), style(c.mutedFg, c.bg), r.x + r.w);
        const body = { x: r.x, y: r.y + 1, w: r.w, h: r.h - 1 };
        if (previews === undefined || previews.length === 0) {
          s.text(body.x, body.y, truncate("No previews.", body.w), style(c.mutedFg, c.bg), body.x + body.w);
          return;
        }
        const rows = previews.map(previewRow);
        drawList(s, body, c, previewState, rows, inPreviews);
        hitList(ctx, body, previewState, rows.length, {
          select: () => {
            inPreviews = true;
            ctx.invalidate();
          },
          open: (index) => {
            const p = previews?.[index];
            if (p === undefined) return;
            inPreviews = true;
            openPreview(p);
          },
        });
      };
      const shown = previews === undefined ? 0 : Math.max(1, Math.min(previews.length, PREVIEW_ROWS));
      const [head, upper, middle, tail] = split(area, "v", [
        len(
          1 +
            (visitors === "" ? 0 : 1) +
            (trend === "" ? 0 : 1) +
            (pace === "" ? 0 : 1) +
            side.length +
            (onboarding === "" ? 0 : 1) +
            egress.length +
            (named === "" ? 0 : 1),
        ),
        fill(1),
        len(previews === undefined ? 0 : shown + 1),
        len(pulls.length === 0 ? 0 : pulls.length + 1),
      ]);
      const body = upper;
      if (previews !== undefined) drawPreviews(middle!);
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
          `${repo.ownerName}/${repo.name} · production deploys${production.state === "" ? "" : ` · ${production.state}`}${production.alwaysOn ? " · never sleeps (app.always_on)" : ""}`,
          head!.w,
        ),
        style(c.mutedFg, c.bg),
        head!.x + head!.w,
      );
      [onboarding, visitors, trend, pace, ...side, named, ...egress]
        .filter((line) => line !== "")
        .forEach((line, i) =>
          s.text(head!.x, head!.y + 1 + i, truncate(line, head!.w), style(c.mutedFg, c.bg), head!.x + head!.w),
        );
      if (list.runs.length === 0) {
        emptyState(s, body!, c, {
          title: loaded ? "No deploys" : "Reading…",
          body: loaded
            ? isApp
              ? "Nothing has been deployed to production yet."
              : "This repository is no longer an app."
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
      drawList(s, body!, c, list.state, rows, !inPreviews);
      hitList(ctx, body!, list.state, rows.length, {
        select: () => {
          inPreviews = false;
          ctx.invalidate();
        },
        open: (index) => {
          inPreviews = false;
          const run = list.runs[index];
          if (run !== undefined) open(run);
        },
      });
    },
    key(e) {
      const n = previews?.length ?? 0;
      const down = !e.ctrl && !e.alt && (e.key === "j" || e.key === "down");
      const up = !e.ctrl && !e.alt && (e.key === "k" || e.key === "up");
      if (!inPreviews && down && n > 0 && list.state.index >= list.runs.length - 1) {
        inPreviews = true;
        previewState.index = 0;
        return true;
      }
      if (inPreviews && up && previewState.index === 0) {
        inPreviews = list.runs.length === 0;
        return true;
      }
      if (inPreviews ? previewState.key(e, n) : list.state.key(e, list.runs.length)) return true;
      if (e.key === "enter" && inPreviews) {
        const p = previews?.[previewState.index];
        if (p !== undefined) openPreview(p);
        return true;
      }
      if (e.key === "enter") {
        const run = list.selected;
        if (run !== undefined) open(run);
        return true;
      }
      if (e.key === "r") {
        read();
        return true;
      }
      if ((e.key === "D" || e.key === "S") && inPreviews) {
        const target = previewActs();
        if (target !== undefined && (e.key === "D" || target.stop))
          confirm(e.key === "D" ? "Redeploy" : "Stop", target.p.env.env, target.p.number);
        return true;
      }
      if (e.key === "D" && production.redeploy) {
        confirm("Redeploy", "production");
        return true;
      }
      if (e.key === "S" && production.stop) {
        confirm("Stop", "production");
        return true;
      }
      if (e.key === "p" && mayProbe) {
        ctx.push(probeScreen(f, ctx, repo));
        return true;
      }
      if (e.key === "b" && mayBuild) {
        previewACommit();
        return true;
      }
      if (e.key === "m" && members) {
        ctx.push(appMembersScreen(f, ctx, repo));
        return true;
      }
      if (e.key === "n" && domains !== undefined) {
        ctx.push(domainsScreen(f, ctx, repo, read));
        return true;
      }
      if (e.key === "i" && prompts) {
        ctx.push(promptsScreen(f, ctx, repo));
        return true;
      }
      if (e.key === "X" && stoppable) {
        stopApp();
        return true;
      }
      return false;
    },
  };
  return screen;
}

// ---- Probe: `p`, the MCP tool `probe` from the deploys screen ----

/** Control characters out of anything the app or the OS said. */
const clean = (text: string): string =>
  text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").trim();

/** `GET /api/notes/0 as anon · 401 · ok`, or what was wrong instead of `ok`. */
export function knockLine(k: Knock): string {
  const where = k.door ?? `${k.resource}.${k.verb}`;
  const r = k.result;
  const status = r.kind === "admitted" || r.kind === "refused" || r.kind === "no_door" ? String(r.status) : "—";
  const said =
    k.verdict === "ok"
      ? "ok"
      : k.verdict === "mismatch"
        ? `wrong: the table says ${k.cell}, the door ${r.kind === "admitted" ? "let them in" : "refused"}`
        : r.kind === "unprobed"
          ? `not asked: ${r.why}`
          : r.kind === "no_door"
            ? "not asked: no such door"
            : r.kind === "error"
              ? `not asked: ${clean(r.message)}`
              : "not asked";
  return `${where} as ${k.as} · ${status} · ${said}`;
}

const knockRow = (k: Knock): ListRow => ({
  title: knockLine(k),
  tone: k.verdict === "ok" ? "success" : k.verdict === "mismatch" ? "danger" : "outline",
});

type Probing =
  | { readonly kind: "reading" }
  /** Nothing was tried, and why, in words. */
  | { readonly kind: "said"; readonly title: string; readonly body: string }
  | { readonly kind: "done"; readonly row: ProbeRow };

/**
 * Knock once, as the MCP tool does: same gate, same `probeApp`, so the row
 * is kept and the app's mismatch issue opened or closed the same way. An app
 * that is not running comes back `down` with no knock, and is said so.
 */
async function knock(f: Session, repo: Repo): Promise<Probing> {
  if (!canWrite(f.db, repo, f.user))
    return { kind: "said", title: "Not yours to probe", body: "You need write access to knock." };
  const record = getAppByRepo(f.db, repo.id);
  const runtime = appsRuntime(f.app);
  if (record === undefined || runtime === undefined)
    return { kind: "said", title: "Not an app here", body: "Nothing serves this repository here." };
  // No status check of our own: `probeApp` keeps a `down` row for a stopped
  // app, as MCP `probe` and the audit page do, and reads the status once.
  const row = await probeApp(f.app, runtime, record);
  if (row === undefined)
    return { kind: "said", title: "No contract", body: "No sound contract.json to compare with." };
  if (row.verdict === "down")
    return {
      kind: "said",
      title: "Not running",
      body: `No door was tried; it is ${runtime.envStatus(record, "production")?.state ?? "not deployed"}.`,
    };
  if (row.knocks.length === 0)
    return { kind: "said", title: "No doors", body: "The contract names no door to try." };
  return { kind: "done", row };
}

function probeScreen(f: Session, ctx: Ctx, repo: Repo): Screen {
  const state = new ListState();
  let probing: Probing = { kind: "reading" };
  const rows = (): ListRow[] => (probing.kind === "done" ? probing.row.knocks.map(knockRow) : []);
  // A probe that throws (the app died mid-knock) is said, never left on `Knocking…`.
  const run = async (): Promise<void> => {
    probing = { kind: "reading" };
    ctx.invalidate();
    try {
      probing = await knock(f, repo);
    } catch {
      probing = { kind: "said", title: "The probe failed", body: "The app stopped answering; press r to knock again." };
    }
    ctx.invalidate();
  };
  return {
    title: "Probe",
    keys: [binding(["j", "k"], "move"), binding(["r"], "knock again"), binding(["esc"], "back")],
    load: async () => run(),
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body] = split(area, "v", [len(1), fill(1)]);
      const summary =
        probing.kind === "done"
          ? (() => {
              const k = probing.row.knocks;
              const n = (v: Knock["verdict"]) => k.filter((x) => x.verdict === v).length;
              return ` · ${probing.row.commitOid.slice(0, 7)} · ${n("ok")} ok · ${n("mismatch")} wrong · ${n("unprobed")} not asked`;
            })()
          : "";
      s.text(
        head!.x,
        head!.y,
        truncate(`${repo.ownerName}/${repo.name} · production doors as nobody, a user and an admin${summary}`, head!.w),
        style(c.mutedFg, c.bg),
        head!.x + head!.w,
      );
      if (probing.kind !== "done") {
        emptyState(s, body!, c, {
          title: probing.kind === "said" ? probing.title : "Knocking…",
          body: probing.kind === "said" ? probing.body : "Trying every door, read-only",
        });
        return;
      }
      const list = rows();
      drawList(s, body!, c, state, list);
      hitList(ctx, body!, state, list.length, {});
    },
    key(e) {
      if (e.key === "r") {
        if (probing.kind !== "reading") void ctx.track(run());
        return true;
      }
      return state.key(e, rows().length);
    },
  };
}

// ---- Domains: `n`, the MCP tool `app_domains` from the deploys screen ----

/** `Domains: app.example.com live · shop.example.com waiting for DNS`, or "" with none. */
function domainsLine(domains: readonly AppDomainView[] | undefined): string {
  if (domains === undefined || domains.length === 0) return "";
  return `Domains: ${domains.map((d) => `${d.host} ${domainStateWord(d)}`).join(" · ")}`;
}

/** `requireRepoAdmin` answers `not_found` to anyone else, so nothing leaks; here it is said. */
const NOT_ADMIN = "Only the app's admin manages its domains.";

const domainRow = (d: AppDomainView): ListRow => ({
  title: `${d.host} · ${domainStateWord(d)}`,
  tone: d.verified ? "success" : "attn",
  secondary: clean(domainSaidText(d)),
});

/** What the proof still needs, for an unverified domain; "" once it is live. */
function stillNeeded(d: AppDomainView): string {
  return d.verified ? "" : `Still needed: ${recordsInWords(d.records)}.`;
}

const recordLine = (r: OldRecord): string => `${r.type} ${r.name} ${r.value}${r.ttl === undefined ? "" : ` ${r.ttl}`}`;

/** `Old records: A app.example.com 203.0.113.7 300`, or "" with none kept. */
const oldLine = (d: AppDomainView): string =>
  d.oldRecords.length === 0 ? "" : `Old records: ${d.oldRecords.map(recordLine).join("; ")}`;

/**
 * The app's domains, for its admin. Every key goes through the action, which
 * gates again; a refusal is said in the page's words. `changed` re-reads the
 * deploys screen beneath, so its domains line follows.
 */
export function domainsScreen(f: Session, ctx: Ctx, repo: Repo, changed: () => void = () => {}): Screen {
  const state = new ListState();
  let domains: AppDomainView[] = [];
  let refused: string | undefined;
  let loaded = false;

  const refusal = (code: string, fallback: string): string =>
    code === "not_found" ? NOT_ADMIN : domainRefusalText(code, fallback);
  const read = (): void => {
    const listed = listAppDomains(f.app, f.user, repo);
    refused = listed.ok ? undefined : refusal(listed.error, NO_SUCH_DOMAIN);
    domains = listed.ok ? listed.value : [];
    loaded = true;
    ctx.invalidate();
  };
  const after = (): void => {
    read();
    changed();
  };
  const add = (): void => {
    ctx.push(
      promptScreen(ctx, self, {
        title: "Add a domain",
        label: "Domain",
        placeholder: "app.example.com",
        hint: "Publish the two records it shows, then check it with c.",
        onSubmit: (host) => {
          const added = addAppDomain(f.app, f.user, repo, host);
          if (!added.ok) return refusal(added.error, "That domain could not be added.");
          ctx.toast(domainAddedText(added.value));
          after();
          return undefined;
        },
      }),
    );
  };

  const check = (d: AppDomainView): void =>
    runAsync(ctx, async () => {
      const checked = await checkAppDomain(f.app, f.user, repo, d.host);
      if (!checked.ok) ctx.toast(refusal(checked.error, NO_SUCH_DOMAIN), "danger");
      else
        ctx.toast(
          [clean(checked.value.said), stillNeeded(checked.value)].filter((t) => t !== "").join(" "),
          checked.value.verified ? "success" : "attn",
        );
      after();
    });

  /** Write down what the name carries today, before the cut: `keepOldRecords`, as the API's PUT and MCP `keep`. */
  const keep = (d: AppDomainView): void => {
    ctx.push(
      promptScreen(ctx, self, {
        title: `Old records of ${d.host}`,
        label: "Records",
        placeholder: "A app.example.com 203.0.113.7 300; CNAME www.example.com host.example.net",
        value: d.oldRecords.map(recordLine).join("; "),
        hint: "type name value [ttl], separated by ;. Replaces what was kept.",
        onSubmit: (line) => {
          const kept = keepOldRecords(f.app, f.user, repo, d.host, recordsFromLine(line));
          if (!kept.ok) return refusal(kept.error, NO_SUCH_DOMAIN);
          ctx.toast(`Kept ${kept.value.oldRecords.length} old record${kept.value.oldRecords.length === 1 ? "" : "s"} of ${d.host}.`);
          after();
          return undefined;
        },
      }),
    );
  };

  const remove = (d: AppDomainView): void => {
    const choose = (choice: number): void => {
      if (choice !== 0) return;
      const removed = removeAppDomain(f.app, f.user, repo, d.host);
      ctx.toast(removed.ok ? domainRemovedText(d.host) : refusal(removed.error, NO_SUCH_DOMAIN), removed.ok ? undefined : "danger");
      after();
    };
    ctx.push(
      yesNo(
        ctx,
        confirmScreen(ctx, self, {
          title: "Remove domain",
          body: [`remove ${d.host}? y/n`],
          actions: [{ label: "Remove" }, { label: "Cancel", variant: "ghost" }],
          selected: 1,
          onChoose: choose,
        }),
        choose,
      ),
    );
  };

  const self: Screen = {
    title: "Domains",
    get keys() {
      return refused !== undefined
        ? [binding(["esc"], "back")]
        : [
            binding(["j", "k"], "move"),
            binding(["+"], "add a domain"),
            ...(domains.length > 0 ? [binding(["c"], "check its DNS now"), binding(["o"], "old records"), binding(["-"], "remove it")] : []),
            binding(["r"], "refresh"),
            binding(["esc"], "back"),
          ];
    },
    load: async () => read(),
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body, foot] = split(area, "v", [len(1), fill(1), len(2)]);
      s.text(
        head!.x,
        head!.y,
        truncate(`${repo.ownerName}/${repo.name} · the app's own domains`, head!.w),
        style(c.mutedFg, c.bg),
        head!.x + head!.w,
      );
      if (refused !== undefined || domains.length === 0) {
        emptyState(s, body!, c, {
          title: refused !== undefined ? "Not yours" : loaded ? "No domains" : "Reading…",
          body: refused ?? (loaded ? "Press + to serve the app at a name of your own." : "Reading the domains"),
        });
        return;
      }
      const rows = domains.map(domainRow);
      drawList(s, body!, c, state, rows);
      hitList(ctx, body!, state, rows.length, {});
      const selected = domains[state.index];
      if (selected !== undefined)
        [stillNeeded(selected), oldLine(selected)].forEach((text, row) =>
          s.text(foot!.x, foot!.y + row, truncate(text, foot!.w), style(c.mutedFg, c.bg), foot!.x + foot!.w),
        );
    },
    key(e) {
      if (refused !== undefined) return false;
      if (state.key(e, domains.length)) return true;
      const selected = domains[state.index];
      if (e.key === "+") {
        add();
        return true;
      }
      if (e.key === "c" && selected !== undefined) {
        check(selected);
        return true;
      }
      if (e.key === "o" && selected !== undefined) {
        keep(selected);
        return true;
      }
      if (e.key === "-" && selected !== undefined) {
        remove(selected);
        return true;
      }
      if (e.key === "r") {
        read();
        return true;
      }
      return false;
    },
  };
  return self;
}
