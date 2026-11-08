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

import { VIA_WORDS } from "../core/acting_via.ts";
import type { ForgeEvent } from "../core/events.ts";

/** The pull number an environment name carries, for `pull-12`. */
const previewNumber = (env: unknown): string =>
  typeof env === "string" && env.startsWith("pull-") ? env.slice(5) : "";

const environment = (env: unknown): string => {
  const preview = previewNumber(env);
  return preview === "" ? "production" : `the preview of #${preview}`;
};

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
  // An app taken in as one of the forge's features.
  if (kind === "app.absorbed") {
    const name = payload["name"];
    return `absorbed ${typeof name === "string" ? name : "the app"} as a forge feature`;
  }
  if (kind === "app.feature_declared") {
    const name = payload["name"];
    return `accepted the feature's declared name ${typeof name === "string" ? name : "and page"}`;
  }
  if (kind === "app.unabsorbed") return "put the app back as an ordinary app";
  if (kind === "app.feature_settings") {
    const keys = payload["keys"];
    const which = Array.isArray(keys) && keys.every((k) => typeof k === "string") ? keys.join(", ") : "settings";
    return `changed the feature's ${which}`;
  }
  if (kind === "app.egress.granted" || kind === "app.egress.revoked") {
    const destination = payload["destination"];
    const which = typeof destination === "string" ? destination : "a destination";
    return kind === "app.egress.granted"
      ? `granted the app ${which}`
      : `revoked the app's grant on ${which}`;
  }
  if (kind.startsWith("app.domain.")) {
    const host = payload["host"];
    const which = typeof host === "string" ? host : "a domain";
    if (kind === "app.domain.added") return `gave the app the domain ${which}`;
    if (kind === "app.domain.verified") return `verified the domain ${which}`;
    return `removed the domain ${which}`;
  }
  if (kind === "build.shots") {
    const label = payload["label"];
    const pin = typeof label === "string" && label !== "" ? `the pin ${label}` : "a pin";
    const change = payload["change"];
    if (change === "added") return `added a screenshot to ${pin}`;
    if (change === "picked") return `picked screenshots from the deploy for ${pin}`;
    if (change === "moved") return `reordered the screenshots of ${pin}`;
    if (change === "captioned") return `captioned a screenshot of ${pin}`;
    if (change === "removed") return `removed a screenshot from ${pin}`;
    return `changed the screenshots of ${pin}`;
  }
  if (kind === "prompt.told") {
    const issue = payload["issue"];
    return typeof issue === "number"
      ? `told the crew the top Instagram comment as #${issue}`
      : "told the crew the top Instagram comment";
  }
  return WORDS[kind] ?? "acted on this repository";
}

const KIND_LABELS: Record<string, string> = {
  push: "Pushes",
  "issue.opened": "Opened issues",
  "issue.closed": "Closed issues",
  "pull.opened": "Opened pulls",
  "pull.merged": "Merged pulls",
  "pull.closed": "Closed pulls",
  "webhook.created": "New webhooks",
  "repo.settings_updated": "Settings changes",
};

/** An event kind in a person's words, for a button that narrows to it: `Merged pulls`. */
export function eventKindLabel(kind: string): string {
  const known = KIND_LABELS[kind];
  if (known !== undefined) return known;
  const words = kind.replace(/[._]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Who to credit when the row names nobody. */
export function eventActor(
  event: ForgeEvent,
  actorName: string | undefined,
): string {
  if (actorName !== undefined)
    return event.via === undefined ? actorName : `${actorName} ${VIA_WORDS}`;
  return event.kind.startsWith("run.") ||
    event.kind.startsWith("app.") ||
    event.kind.startsWith("prompt.") ||
    (event.kind === "pull.released" && event.actorId === null)
    ? "the forge"
    : "someone";
}

const WORDS: Record<string, string> = {
  push: "pushed",
  "issue.opened": "opened an issue",
  "issue.closed": "closed an issue",
  "issue.reopened": "reopened an issue",
  "issue.commented": "commented on an issue",
  "issue.edited": "edited an issue",
  "issue.labeled": "labelled an issue",
  "issue.teams": "named the teams on an issue",
  "issue.sealed": "sealed a security report",
  "issue.unsealed": "unsealed a security report",
  "pull.opened": "opened a pull request",
  "pull.merged": "merged a pull request",
  "pull.edited": "edited a pull request",
  "pull.closed": "closed a pull request",
  "pull.reopened": "reopened a pull request",
  "pull.commented": "commented on a pull request",
  "pull.reviewed": "reviewed a pull request",
  "pull.run_granted": "let a pull request's head run",
  "pull.guest_approved": "approved a guest pull request",
  "pull.labeled": "labelled a pull request",
  "pull.held": "held a pull request",
  "pull.released": "released a pull request",
  "pull.thread_resolved": "resolved a review thread",
  "repo.created": "created a repository",
  "repo.forked": "forked a repository",
  "repo.detached": "detached a fork from its parent",
  "repo.settings_updated": "changed repository settings",
  "repo.upstream_follow": "changed which upstream the repository follows",
  "repo.source_added": "followed another source",
  "repo.source_removed": "stopped following a source",
  "repo.following": "turned following an upstream on or off",
  "repo.crew_outsiders": "changed who may trigger the crew",
  "repo.mirrored": "mirrored a repository",
  "repo.imported": "imported issues and pulls",
  "repo.pinned": "pinned a repository",
  "repo.unpinned": "unpinned a repository",
  "board.pins": "changed their pinned panels",
  "branch.created": "created a branch",
  "branch.deleted": "deleted a branch",
  "label.created": "added a label",
  "label.updated": "edited a label",
  "label.deleted": "removed a label",
  "webhook.created": "added a webhook",
  "webhook.deleted": "removed a webhook",
  "webhook.paused": "paused a webhook",
  "webhook.resumed": "resumed a webhook",
  "origin.connected": "connected an origin",
  "origin.disconnected": "disconnected an origin",
  "origin.needs_reauth": "needs to reconnect an origin",
  "origin.mirror_reattached": "reconnected a frozen mirror to its origin",
  "build.pinned": "pinned a build",
  "build.deleted": "removed a build pin",
  "build.noted": "noted a pinned build",
  "run.queued": "queued a run",
  "run.started": "started a run",
  "app.created": "made it an app",
  "app.updated": "changed the app's settings",
  "app.deleted": "stopped serving it as an app",
  "prompt.source_added": "connected an Instagram account to prompt the crew",
  "prompt.source_removed": "disconnected the Instagram account",
};
