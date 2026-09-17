/**
 * What an event is called. One vocabulary for both surfaces, so "the forge
 * deployed the preview of #12" reads the same in a terminal pane and a
 * browser card, and a new event kind is named once.
 *
 * `eventVerb` is the verb phrase alone — the repository and the thing acted
 * on go on the next line, where they have room to be a link and to be
 * truncated at the end rather than mid-word. `eventActor` is who to credit
 * when the row has no actor: a deploy is the forge's own doing, and says so.
 */

import type { ForgeEvent } from "../core/events.ts";

/** The pull number an environment name carries, for `pull-12`. */
const previewNumber = (env: unknown): string =>
  typeof env === "string" && env.startsWith("pull-") ? env.slice(5) : "";

const environment = (env: unknown): string => {
  const preview = previewNumber(env);
  return preview === "" ? "production" : `the preview of #${preview}`;
};

/** Moments rather than facts: a feed shows what came of them instead. */
export const isTransientEvent = (kind: string): boolean =>
  kind === "run.queued" || kind === "run.started";

export function eventVerb(event: ForgeEvent): string {
  const { kind, payload } = event;
  if (kind === "run.finished") {
    const state = payload["state"];
    if (payload["kind"] === "deploy") {
      const what = environment(payload["env"]);
      if (state === "ok") return `deployed ${what}`;
      if (state === "failed") return `failed to deploy ${what}`;
      return `cancelled a deploy of ${what}`;
    }
    if (state === "ok") return "finished a crew run";
    if (state === "failed") return "ended a crew run without landing";
    return "had a crew run cancelled";
  }
  if (kind === "issue.assigned" || kind === "pull.assigned") {
    const thing = kind === "issue.assigned" ? "an issue" : "a pull request";
    const to = payload["assignee"];
    return typeof to === "string" && to !== ""
      ? `assigned ${thing} to @${to}`
      : `unassigned ${thing}`;
  }
  if (kind === "crew.added" || kind === "crew.removed") {
    const agent = payload["agent"];
    const who = typeof agent === "string" ? `@${agent}` : "an agent";
    return kind === "crew.added"
      ? `put ${who} on the crew`
      : `took ${who} off the crew`;
  }
  if (kind === "app.serving")
    return `started serving ${environment(payload["env"])}`;
  if (kind === "app.stopped") return `stopped ${environment(payload["env"])}`;
  if (kind === "app.env_set" || kind === "app.env_deleted") {
    const name = payload["name"];
    const which = typeof name === "string" ? name : "a variable";
    return kind === "app.env_set"
      ? `set ${which} in the app's environment`
      : `removed ${which} from the app's environment`;
  }
  return WORDS[kind] ?? "acted on this repository";
}

/** Who to credit when the row names nobody. */
export function eventActor(
  event: ForgeEvent,
  actorName: string | undefined,
): string {
  if (actorName !== undefined) return actorName;
  return event.kind.startsWith("run.") || event.kind.startsWith("app.")
    ? "the forge"
    : "someone";
}

const WORDS: Record<string, string> = {
  push: "pushed",
  "issue.opened": "opened an issue",
  "issue.closed": "closed an issue",
  "issue.reopened": "reopened an issue",
  "issue.commented": "commented on an issue",
  "issue.labeled": "labelled an issue",
  "pull.opened": "opened a pull request",
  "pull.merged": "merged a pull request",
  "pull.closed": "closed a pull request",
  "pull.reopened": "reopened a pull request",
  "pull.commented": "commented on a pull request",
  "pull.reviewed": "reviewed a pull request",
  "pull.labeled": "labelled a pull request",
  "pull.thread_resolved": "resolved a review thread",
  "repo.created": "created a repository",
  "repo.forked": "forked a repository",
  "repo.settings_updated": "changed repository settings",
  "repo.mirrored": "mirrored a repository",
  "repo.imported": "imported issues and pulls",
  "repo.pinned": "pinned a repository",
  "repo.unpinned": "unpinned a repository",
  "branch.created": "created a branch",
  "branch.deleted": "deleted a branch",
  "label.created": "added a label",
  "label.updated": "edited a label",
  "label.deleted": "removed a label",
  "webhook.created": "added a webhook",
  "webhook.deleted": "removed a webhook",
  "origin.connected": "connected an origin",
  "origin.disconnected": "disconnected an origin",
  "origin.needs_reauth": "needs to reconnect an origin",
  "run.queued": "queued a run",
  "run.started": "started a run",
  "app.created": "made it an app",
  "app.updated": "changed the app's settings",
  "app.deleted": "stopped serving it as an app",
};
