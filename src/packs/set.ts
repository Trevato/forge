/**
 * Changing which repos are packs, for every door (#10532): the web page, the
 * terminal and MCP all come here, so a write is checked, kept and read into
 * the catalog the same way, and shows on /packs at once.
 */

import type { App } from "../app.ts";
import { refreshCatalogQuietly } from "./catalog.ts";
import { updateMarkedRepos, type MarkedUpdate } from "./marked.ts";

export type SetPacks =
  | { ok: true; repos: string[]; problems: readonly string[] }
  | Exclude<MarkedUpdate, { ok: true }>;

/** Save the marked repos as `user` (an admin who is not an agent), then re-read git. */
export async function setPackRepos(
  app: App,
  user: { id: string; isAdmin: boolean; kind: string } | undefined,
  text: string,
): Promise<SetPacks> {
  const saved = updateMarkedRepos(app.db, user, text);
  if (!saved.ok) return saved;
  const { problems } = await refreshCatalogQuietly(app);
  return { ok: true, repos: saved.repos, problems };
}
