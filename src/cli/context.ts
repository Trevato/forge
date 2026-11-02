/** What more than one command needs: the signed-in config and the report as data. */
import {
  configPath,
  loadConfig,
  PLAIN_HTTP_REFUSAL,
  type Config,
} from "./config.ts";
import { EXIT } from "./exit.ts";
import type { Out } from "./out.ts";
import { dirtyCount } from "./report.ts";
import type { RepoReport, SyncReport } from "./sync.ts";

export async function requireConfig(out: Out): Promise<Config | number> {
  const loaded = await loadConfig();
  if (loaded === "no_config") {
    out.err("forge: not signed in — run `forge login <url>`");
    return EXIT.notConfigured;
  }
  if (loaded === "no_token") {
    out.err(`forge: ${configPath()} has no usable token — run \`forge login\``);
    return EXIT.notConfigured;
  }
  if (loaded === "plain_http") {
    out.err(`forge: ${PLAIN_HTTP_REFUSAL}`);
    return EXIT.usage;
  }
  return loaded.config;
}

/**
 * The report as data. `--json` exists so a script can branch on the same
 * facts the table shows without parsing columns — so every field the table
 * draws from is here, spelled the way the rest of the client spells it.
 */
export function asJson(report: SyncReport): Record<string, unknown> {
  return {
    root: report.root,
    pinsUnavailable: report.pinsUnavailable,
    failures: report.failures,
    repos: report.repos.map((r: RepoReport) => ({
      owner: r.owner,
      name: r.name,
      path: r.dir,
      present: r.present,
      cloned: r.cloned,
      pinned: r.pinned,
      branch: r.branch,
      upstream: r.upstream,
      ahead: r.ahead,
      behind: r.behind,
      staged: r.staged,
      changed: r.changed,
      untracked: r.untracked,
      conflicted: r.conflicted,
      dirty: dirtyCount(r),
      stashes: r.stashes,
      unpushed: r.unpushed,
      fastForwarded: r.fastForwarded,
      lastFetch: r.lastFetch === null ? null : r.lastFetch.toISOString(),
      error: r.error,
    })),
  };
}
