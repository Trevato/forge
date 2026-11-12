/**
 * What the forge pill tells a person, for an agent: given an app host's URL,
 * the app, the environment, the pull a preview serves, the state of that
 * pull's check, its first failure and its log, and who is working on it.
 * Plain data in, plain data out; the MCP `preview` tool is the door.
 */

import type { App } from "../app.ts";
import { runLog } from "../actions/runs.ts";

import { getPull } from "../core/pulls.ts";
import { checkSummary, workingAgentRuns } from "../core/runs.ts";
import { mayView, mayViewId } from "../core/sealed.ts";
import { canRead, getRepoById } from "../core/repos.ts";
import { getUserById, type User } from "../core/users.ts";
import { resolveAppHostname } from "./proxy.ts";
import { appsRuntime } from "./runtime.ts";
import { servingWords, type ServingWords } from "./serving_words.ts";

export interface PreviewView {
  readonly app: string;
  readonly environment: string;
  readonly pull: { readonly number: number; readonly title: string } | null;
  readonly check: "green" | "red" | "running" | null;
  readonly firstFailure: string | null;
  readonly logUrl: string | null;
  readonly working: readonly string[];
  /** Whether anything is serving there, in the words of the proxy's page. */
  readonly serving: ServingWords & { readonly runUrl: string | null };
}

export type PreviewRefusal = "foreign" | "no_such_app" | "no_such_pull";

export function previewOf(
  app: App,
  domain: string | undefined,
  user: User,
  origin: string,
  raw: unknown,
): { ok: true; value: PreviewView } | { ok: false; error: PreviewRefusal; number?: number } {
  const url = typeof raw === "string" && raw.length <= 2048 ? URL.parse(raw) : null;
  if (domain === undefined || url === null || (url.protocol !== "http:" && url.protocol !== "https:"))
    return { ok: false, error: "foreign" };
  const target = resolveAppHostname(app, domain, url.host);
  if (target === undefined) return { ok: false, error: "foreign" };
  const db = app.db;
  if (target === "unknown" || target.nested) return { ok: false, error: "no_such_app" };
  const repo = getRepoById(db, target.app.repoId);
  if (repo === undefined || !canRead(db, repo, user)) return { ok: false, error: "no_such_app" };
  const name = `${repo.ownerName}/${repo.name}`;
  const number = /^pull-(\d+)$/.exec(target.env)?.[1];
  let pull: PreviewView["pull"] = null;
  let check: PreviewView["check"] = null;
  let firstFailure: string | null = null;
  let logUrl: string | null = null;
  let pullIssueId: string | undefined;
  let pullIssueState: string | undefined;
  if (number !== undefined) {
    const found = getPull(db, repo.id, Number(number));
    if (found === undefined || !mayView(db, repo, found, user))
      return { ok: false, error: "no_such_pull", number: Number(number) };
    pullIssueId = found.id;
    pullIssueState = found.state;
    pull = { number: found.number, title: found.title };
    const { state, run } = checkSummary(db, found.id, found.headOid);
    check =
      state === "ok" ? "green" : state === "failed" ? "red" : state === "running" || state === "queued" ? "running" : null;
    if (run !== null) {
      if (state === "failed") firstFailure = run.checkDetail?.names[0] ?? (run.summary || null);
      const log = runLog(app, user, repo, run.id);
      if (log.ok && !log.value.logHidden) logUrl = `${origin}/${name}/runs/${run.id}`;
    }
  }
  const working = new Set<string>();
  // As the pill: this pull's runs on a preview, the app's on production, and
  // never a run on an issue the viewer may not see.
  for (const run of workingAgentRuns(db, repo.id, pullIssueId)) {
    if (!mayViewId(db, repo, run.issueId, user)) continue;
    const who = run.actorId === null ? undefined : getUserById(db, run.actorId);
    if (who !== undefined) working.add(who.username);
  }
  const runtime = appsRuntime(app);
  const status = runtime?.envStatus(target.app, target.env);
  // An open pull is never gone; a pull seen above is open or closed.
  const words = servingWords(status, number === undefined ? null : pullIssueState === "closed" ? "closed" : "open");
  const runUrl =
    runtime === undefined || status?.runId === undefined
      ? null
      : `${runtime.options.forgeUrl}/runs/${status.runId}`;
  return {
    ok: true,
    value: {
      app: name,
      environment: target.env,
      pull,
      check,
      firstFailure,
      logUrl,
      working: [...working],
      serving: { ...words, runUrl },
    },
  };
}
