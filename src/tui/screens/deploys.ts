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
 * says the record still needed, and `-` removes it after `remove <host>? y/n`
 * — `addAppDomain`, `checkAppDomain` and `removeAppDomain`, the page's and
 * MCP `app_domains`' actions. `listAppDomains` is the admin gate: anyone it
 * refuses sees neither the domains nor the key.
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
import {
  addAppDomain,
  checkAppDomain,
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
import { envLabel, envRefusalText, redeployedText, stoppedText } from "../../actions/env_words.ts";
import { trendLine, visitorsLine } from "../../apps/vitals.ts";
import { listRepoRuns } from "../../actions/runs.ts";
import { carriedByRuns, carriesText } from "../../core/carried.ts";
import { appsRuntime } from "../../apps/runtime.ts";
import { getAppByRepo } from "../../core/apps.ts";
import { canWrite, type Repo } from "../../core/repos.ts";
import type { Knock } from "../../contract/probe.ts";
import { probeApp, type ProbeRow } from "../../contract/probes.ts";
import type { Run } from "../../core/runs.ts";
import type { Ctx, Screen } from "../app/app.ts";
import { binding } from "../app/keys.ts";
import type { Session } from "../session.ts";
import { style } from "../term/style.ts";
import { truncate } from "../term/width.ts";
import { fill, len, split } from "../ui/layout.ts";
import { emptyState } from "../ui/widgets.ts";
import {
  ListState,
  confirmScreen,
  drawList,
  hitList,
  promptScreen,
  runAsync,
  yesNo,
  type ListRow,
} from "./common.ts";
import { RunList, openRunLog, runRows } from "./runlist.ts";
import { appMembersScreen } from "./appmembers.ts";

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
  let members = false;
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
    pulls = appPullLines(f.app, f.user, repo);
    production = readProduction(f, repo);
    // The action's gate: a person who can write, never an agent.
    members =
      getAppByRepo(f.db, repo.id)?.access === "private" &&
      f.user !== undefined &&
      f.user.kind !== "agent" &&
      canWrite(f.db, repo, f.user);
    const listed = listAppDomains(f.app, f.user, repo);
    domains = listed.ok ? listed.value : undefined;
    loaded = true;
    ctx.invalidate();
  };

  const open = (run: Run): void => openRunLog(f, ctx, repo, run);
  // The MCP tool's gate, read once: only a writer is offered the knock.
  const mayProbe = canWrite(f.db, repo, f.user);

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
        ...(mayProbe ? [binding(["p"], "probe the running app's doors")] : []),
        ...(members ? [binding(["m"], "members")] : []),
        ...(domains !== undefined ? [binding(["n"], "the app's own domains")] : []),
      ];
    },
    load: async () => read(),
    render(area, s) {
      const c = ctx.theme.c;
      const named = domainsLine(domains);
      const [head, upper, tail] = split(area, "v", [
        len(
          1 +
            (visitors === "" ? 0 : 1) +
            (trend === "" ? 0 : 1) +
            (pace === "" ? 0 : 1) +
            side.length +
            (named === "" ? 0 : 1),
        ),
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
      [visitors, trend, pace, ...side, named]
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
      if (e.key === "p" && mayProbe) {
        ctx.push(probeScreen(f, ctx, repo));
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
            ...(domains.length > 0 ? [binding(["c"], "check its DNS now"), binding(["-"], "remove it")] : []),
            binding(["r"], "refresh"),
            binding(["esc"], "back"),
          ];
    },
    load: async () => read(),
    render(area, s) {
      const c = ctx.theme.c;
      const [head, body, foot] = split(area, "v", [len(1), fill(1), len(1)]);
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
        s.text(foot!.x, foot!.y, truncate(stillNeeded(selected), foot!.w), style(c.mutedFg, c.bg), foot!.x + foot!.w);
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
