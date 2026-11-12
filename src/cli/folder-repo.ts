/**
 * Which repository this folder is a clone of, as far as the configured
 * workbench is concerned: the `origin` remote, when it points at that host.
 * A remote elsewhere (GitHub, a colleague's forge) answers undefined — the
 * caller says so rather than asking the wrong server about the wrong repo.
 */

import { parseRepoRef } from "./args.ts";

/** `owner/name` out of an origin URL, if its host is the workbench's. */
export function repoFromRemote(
  remote: string,
  workbenchUrl: string,
): { owner: string; name: string } | undefined {
  let host: string;
  let path: string;
  const text = remote.trim();
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(text);
  if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    try {
      const url = new URL(text);
      host = url.hostname;
      path = url.pathname;
    } catch {
      return undefined;
    }
  }
  let wanted: string;
  try {
    wanted = new URL(workbenchUrl).hostname;
  } catch {
    return undefined;
  }
  if (host.toLowerCase() !== wanted.toLowerCase()) return undefined;
  return parseRepoRef(
    path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, ""),
  );
}

/** The folder's `origin`, read with git (argv, never a shell). */
export async function folderRepo(
  dir: string,
  workbenchUrl: string,
): Promise<{ owner: string; name: string } | undefined> {
  try {
    const proc = Bun.spawn(["git", "-C", dir, "remote", "get-url", "origin"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return undefined;
    return repoFromRemote(text, workbenchUrl);
  } catch {
    return undefined;
  }
}
