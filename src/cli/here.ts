/**
 * The repository of the folder you are in: `--repo owner/name` when given,
 * else the current folder's `origin` remote — but only when that remote
 * points at the configured workbench. A clone of somewhere else is not a
 * repository this forge can act on, and guessing would act on the wrong one.
 */

import { runLocal } from "../git/local.ts";
import { parseRepoRef } from "./args.ts";

export interface RepoRef {
  readonly owner: string;
  readonly name: string;
}

/**
 * `owner/name` from a remote URL, when its host is the workbench's. Reads
 * `https://host/o/n(.git)`, `ssh://user@host[:port]/o/n(.git)` and the scp
 * form `user@host:o/n(.git)`.
 */
export function repoFromRemote(
  remote: string,
  workbench: string,
): RepoRef | undefined {
  const want = hostOf(workbench);
  if (want === undefined) return undefined;
  const text = remote.trim();
  let host: string;
  let path: string;
  const scp = /^[^/@\s]+@([^:/\s]+):(?!\/)(.+)$/.exec(text);
  if (scp !== null) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return undefined;
    }
    if (!["http:", "https:", "ssh:"].includes(url.protocol)) return undefined;
    host = url.hostname;
    path = url.pathname.replace(/^\//, "");
  }
  if (host.toLowerCase() !== want) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path.replace(/\.git$/, "").replace(/\/$/, ""));
  } catch {
    return undefined;
  }
  return parseRepoRef(decoded);
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** The `origin` remote of `cwd`, or undefined when there is none. */
export async function originUrl(cwd: string): Promise<string | undefined> {
  try {
    const out = await runLocal(["remote", "get-url", "origin"], { cwd });
    return out.ok && out.value.trim() !== "" ? out.value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `--repo` if given (and well-formed), else the folder's origin. The string
 * case is the one line to print when neither names a repository.
 */
export async function resolveRepo(
  given: string | undefined,
  workbench: string,
  cwd: string = process.cwd(),
): Promise<RepoRef | string> {
  if (given !== undefined) {
    return parseRepoRef(given) ?? "--repo expects owner/name";
  }
  const remote = await originUrl(cwd);
  if (remote === undefined)
    return "no origin remote here — pass --repo owner/name";
  // The remote itself is not echoed: an https remote may carry a token.
  return (
    repoFromRemote(remote, workbench) ??
    `origin is not on ${workbench} — pass --repo owner/name`
  );
}
