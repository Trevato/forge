/**
 * The steps a repository offers: where its head can send somebody, and on
 * what conditions. One list for the head's tabs and "More" menu and for the
 * command palette, so a link the head shows is a palette row and a row the
 * head hides is not offered. Worked out once per request: the head and the
 * palette both ask, and the answer is the same.
 */

import { mayReadRuns } from "../actions/runs.ts";
import { appsRuntime } from "../apps/runtime.ts";
import { knownSpec, warmSpec } from "../apps/api_spec.ts";
import { runningCount } from "../core/runs.ts";
import { getAppByRepo } from "../core/apps.ts";
import { canAdmin, canEnterApp, visibleForks, type Repo } from "../core/repos.ts";
import type { Ctx } from "../http/context.ts";
import { sshCommand } from "../ssh/command.ts";
import { changesHref, tellsHref } from "./studio/nouns.ts";

export type RepoTab =
  | "code"
  | "issues"
  | "pulls"
  | "forks"
  | "map"
  | "commits"
  | "branches"
  | "app"
  | "runs"
  | "events"
  | "api"
  | "settings"
  /** A page that belongs to no tab (waves): nothing is marked current. */
  | "none";

export interface Step {
  key: RepoTab;
  label: string;
  href: string;
  shortcut?: string;
  /** How many forks, or runs going now, where the step counts them. */
  count?: number;
}

export interface Steps {
  steps: Step[];
  /** May this viewer open the repository's settings. */
  admin: boolean;
  /** An app speaks the studio's words; a plain repository git's. */
  studio: boolean;
}

/** The steps that stay a tab; every other one waits in "More". */
export const TAB_STEPS: ReadonlySet<string> = new Set(["Studio", "App", "Files", "Code", "Issues", "Pulls", "Settings"]);

const cache = new WeakMap<Ctx, Map<string, Steps>>();

/** `repo` is absent for a repository only browsed from elsewhere: no runs, events or settings here. */
export function repoSteps(ctx: Ctx, base: string, repo: Repo | undefined): Steps {
  const key = `${base}|${repo?.id ?? ""}`;
  let seen = cache.get(ctx);
  if (seen === undefined) cache.set(ctx, (seen = new Map()));
  let made = seen.get(key);
  if (made === undefined) seen.set(key, (made = work(ctx, base, repo)));
  return made;
}

function work(ctx: Ctx, base: string, repo: Repo | undefined): Steps {
  // Settings appears only for an admin of a repository we hold — a tab that
  // 404s is a lie about what you can do.
  const admin = repo !== undefined && canAdmin(ctx.app.db, repo, ctx.auth.user);
  const record = repo === undefined ? undefined : getAppByRepo(ctx.app.db, repo.id);
  const studio = record !== undefined;
  // An app's home is the app, for every viewer, and its code is the Files
  // step one tab over; any other repository's home is its code.
  const steps: Step[] = [
    ...(studio
      ? [
          { key: "app" as const, label: "Studio", href: base },
          { key: "code" as const, label: "Files", href: `${base}/files`, shortcut: "g c" },
        ]
      : [{ key: "code" as const, label: "Code", href: base, shortcut: "g c" }]),
    // Issues and pull requests are called that in every mode (#3241).
    { key: "issues", label: "Issues", href: tellsHref(base), shortcut: "g i" },
    { key: "pulls", label: "Pulls", href: changesHref(base), shortcut: "g p" },
    { key: "map", label: "Map", href: `${base}/map`, shortcut: "g a" },
    ...(studio
      ? []
      : [
          { key: "commits" as const, label: "Commits", href: `${base}/commits`, shortcut: "g m" },
          { key: "branches" as const, label: "Branches", href: `${base}/branches`, shortcut: "g b" },
        ]),
  ];
  if (repo !== undefined) {
    // The family: a fork, or a repository with forks this viewer may read
    // (a private fork is not counted), gets the tree.
    const forks = visibleForks(ctx.app.db, repo.id, ctx.auth.user).length;
    if (forks > 0 || repo.forkParentId !== null)
      steps.splice(3, 0, {
        key: "forks",
        label: "Forks",
        href: `${base}/forks`,
        shortcut: "g f",
        ...(forks > 0 ? { count: forks } : {}),
      });
    // The runs, for who may read them (a private app's are for those who may enter it).
    if (mayReadRuns(ctx.app, ctx.auth.user, repo)) {
      const running = runningCount(ctx.app.db, repo.id);
      steps.push({
        key: "runs",
        label: "Runs",
        href: `${base}/runs`,
        shortcut: "g r",
        ...(running > 0 ? { count: running } : {}),
      });
    }
    steps.push({ key: "events", label: "Events", href: `${base}/events` });
    // An app that serves /openapi.json gets its API reference. The spec is
    // read in the background and remembered, so a header never waits.
    if (record !== undefined && canEnterApp(ctx.app.db, repo, record, ctx.auth.user)) {
      warmSpec(record, appsRuntime(ctx.app)?.envStatus(record, "production")?.port);
      if (knownSpec(record.id) != null) steps.push({ key: "api", label: "API", href: `${base}/api` });
    }
  }
  // How to open the terminal (the TUI over SSH), for whoever has keys.
  if (ctx.auth.user !== undefined && sshCommand(ctx.app) !== undefined)
    steps.push({ key: "none", label: "Terminal", href: "/settings/keys#terminal" });
  if (admin) steps.push({ key: "settings", label: "Settings", href: `${base}/settings`, shortcut: "g s" });
  return { steps, admin, studio };
}
