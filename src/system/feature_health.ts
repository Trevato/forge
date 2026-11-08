/**
 * How the apps absorbed as features are doing, now (#9887): one row per
 * absorbed app with its production environment's state, the commit serving
 * and, when a newer deploy failed or the app is down, why. A read of what
 * the runtime already knows: no git read, no model, nothing started. The
 * owner sees every absorbed app; an agent granted telemetry:read, only those
 * whose repository is public (the same cut `agentView` makes of processes).
 */
import type { App } from "../app.ts";
import type { Reader } from "../actions/telemetry.ts";
import { getAppById } from "../core/apps.ts";
import { getRepoById } from "../core/repos.ts";
import { listAbsorbed } from "../core/features.ts";
import { appsRuntime, type EnvState, type EnvStatus } from "../apps/runtime.ts";

export interface FeatureHealth {
  readonly slug: string;
  /** The menu label the admin absorbed it under. */
  readonly name: string;
  readonly repo: string;
  /** Production's state; `none` when the runtime has no production environment for it. */
  readonly state: EnvState | "none";
  /** True when production is serving (`running`), the one state that is well. */
  readonly healthy: boolean;
  /** The first 7 characters of the commit serving or being brought up. */
  readonly commit: string | null;
  /** When production started serving or last changed state. */
  readonly since: string | null;
  /** Why it is down, or why a newer deploy did not come up. */
  readonly problem: string | null;
}

/** One row from an environment's status; `undefined` is an app the runtime holds nothing for. */
export function healthOf(base: Pick<FeatureHealth, "slug" | "name" | "repo">, env: EnvStatus | undefined): FeatureHealth {
  const state = env?.state ?? "none";
  const problem = env?.error ?? (env?.failedDeploy ? `a newer deploy failed: ${env.failedDeploy.error}` : null);
  return {
    ...base,
    state,
    healthy: state === "running" && env?.failedDeploy === undefined,
    commit: env ? env.commitOid.slice(0, 7) : null,
    since: env?.servingAt ?? env?.since ?? null,
    problem: problem === null ? null : problem.slice(0, 300),
  };
}

/** Unhealthy first, then by name. */
export function featureHealth(app: App, reader: Reader): FeatureHealth[] {
  const runtime = appsRuntime(app);
  const out: FeatureHealth[] = [];
  for (const row of listAbsorbed(app.db)) {
    const record = getAppById(app.db, row.appId);
    const repo = record && getRepoById(app.db, record.repoId);
    if (!record || !repo) continue;
    if (reader.kind === "agent" && repo.visibility !== "public") continue;
    const env = runtime?.status(record).find((e) => e.env === "production");
    out.push(healthOf({ slug: record.slug, name: row.name, repo: `${repo.ownerName}/${repo.name}` }, env));
  }
  return out.sort((a, b) => Number(a.healthy) - Number(b.healthy) || a.name.localeCompare(b.name));
}
