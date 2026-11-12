/**
 * What a Talk conversation is working on (#11009), for both doors: the
 * repository its last call named, found only as the person may read it, the
 * newest open pull, and the address of what runs (that pull's preview, else
 * production). The web draws it as the pane beside the chat
 * (`web/pages/talk_preview.ts`); the terminal as the Talk screen's `p` view.
 */

import type { App } from "../app.ts";
import { previewEnv } from "../apps/data.ts";
import { getRepo, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { requireReader } from "./access.ts";
import { appPreviews, openEnvUrl } from "./apps.ts";

/** What the workspace needs from the apps module: the newest open preview's pull, and an environment's address. */
export interface Apps {
  readonly newestPull: (repo: Repo) => number | undefined;
  readonly urlOf: (repo: Repo, env: string) => string | undefined;
}

export const realApps = (app: App, user: User): Apps => ({
  newestPull: (repo) => appPreviews(app, user, repo)?.[0]?.number,
  urlOf: (repo, env) => {
    const opened = openEnvUrl(app, user, repo, env);
    return opened.ok ? opened.value : undefined;
  },
});

export interface Workspace {
  readonly name: string;
  readonly repo: Repo;
  readonly pull: number | undefined;
  /** The running app's address, and its origin alone (what `frame-src` may name); both or neither. */
  readonly url: string | undefined;
  readonly origin: string | undefined;
}

/** Scheme, host and port, nothing else: no userinfo, so `https://a.com@evil.com/` has none. */
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?(?=\/|$)/i;

export const originOf = (url: string): string | undefined => ORIGIN.exec(url)?.[0];

/** The workspace `name` stands for, or undefined when it is no repository this person can read. */
export function workspaceOf(app: App, user: User, name: string, apps: Apps = realApps(app, user)): Workspace | undefined {
  const [owner, repoName, extra] = name.split("/");
  if (owner === undefined || repoName === undefined || extra !== undefined) return undefined;
  const repo = getRepo(app.db, owner, repoName);
  if (repo === undefined || !requireReader(app, user, repo).ok) return undefined;
  const pull = apps.newestPull(repo);
  const found = apps.urlOf(repo, pull === undefined ? "production" : previewEnv(pull));
  const origin = found === undefined ? undefined : originOf(found);
  return { name, repo, pull, url: origin === undefined ? undefined : found, origin };
}
