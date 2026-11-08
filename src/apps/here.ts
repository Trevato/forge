/**
 * What an app's `/__forge/` door shows, for an agent holding the app's link:
 * the same facts (`pillWhere`, `crewAll`, `reportUrl`) the door and pill
 * render from, as plain data. Anyone the door would turn away is refused.
 */

import { getRepoById, canEnterApp } from "../core/repos.ts";
import { mayView } from "../core/sealed.ts";
import { getIssue } from "../core/issues.ts";
import type { User } from "../core/users.ts";
import type { AppsRuntime } from "./runtime.ts";
import { crewAll } from "./crew.ts";
import { isHostPort, pillWhere, reportUrl, resolveAppHostname } from "./proxy.ts";

export type Here = {
  app: string;
  repo: string | null;
  environment: string;
  pull: { number: number; title: string } | null;
  working: string[];
  links: { home: string; repo: string | null; report: string | null };
};

/** `undefined` is the door's refusal: not an app host here, or not yours to enter. */
export function hereOf(runtime: AppsRuntime, link: string, user: User): Here | undefined {
  let host: string;
  try {
    const url = new URL(link);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    host = url.host;
  } catch {
    return undefined;
  }
  if (!isHostPort(host)) return undefined;
  const app = runtime.app;
  const target = resolveAppHostname(app, runtime.options.domain, host);
  if (target === undefined || target === "unknown" || target.nested) return undefined;
  const repo = getRepoById(app.db, target.app.repoId);
  if (repo === undefined || repo.archivedAt != null) return undefined;
  if (!canEnterApp(app.db, repo, target.app, user)) return undefined;
  const number = /^pull-(\d+)$/.exec(target.env)?.[1];
  if (number !== undefined) {
    const pull = getIssue(app.db, repo.id, Number(number));
    if (pull?.sealed === true && !mayView(app.db, repo, pull, user)) return undefined;
  }
  const where = pillWhere(runtime, target, { id: user.id, name: user.username, role: "user" });
  const forgeUrl = runtime.options.forgeUrl;
  const report = reportUrl(runtime, target);
  return {
    app: where.app,
    repo: where.repo ?? null,
    environment: target.env,
    pull:
      where.pull !== undefined && where.title !== undefined
        ? { number: where.pull, title: where.title }
        : null,
    working: crewAll(app.db, forgeUrl, target.app, target.env, user.id).map((c) => c.who),
    links: {
      home: forgeUrl,
      repo: where.repo === undefined ? null : new URL(`/${where.repo}`, forgeUrl).href,
      report: report?.href ?? null,
    },
  };
}
