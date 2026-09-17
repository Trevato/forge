/**
 * Being someone to an app under test. The proxy names a visitor only from
 * a grant it signed itself, and drops any identity headers a client sends,
 * so a test that wants to be alice goes in the way alice would: through
 * `/apps/open`, which vouches for her and answers with the grant cookie.
 */

import { openEnvUrl } from "../../src/actions/apps.ts";
import type { App } from "../../src/app.ts";
import type { AppRecord } from "../../src/core/apps.ts";
import { getRepoById } from "../../src/core/repos.ts";
import type { User } from "../../src/core/users.ts";

export async function grantedCookie(
  app: App,
  base: string,
  user: User,
  record: AppRecord,
  env = "production",
): Promise<string> {
  const repo = getRepoById(app.db, record.repoId);
  if (!repo) throw new Error("no repository for the app");
  const link = openEnvUrl(app, user, repo, env);
  if (!link.ok) throw new Error(`no grant: ${String(link.error)}`);
  const url = new URL(link.value);
  const granted = await fetch(`${base}${url.pathname}${url.search}`, {
    headers: { host: url.host },
    redirect: "manual",
  });
  const cookie = (granted.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  if (cookie === "")
    throw new Error(`the grant set no cookie (${granted.status})`);
  return cookie;
}
