/**
 * Where a forge may keep its state: anywhere but the tree it runs from.
 *
 * A forge started with its data directory set to its own checkout leaves
 * `forge.db`, `ssh/host_ed25519` and a socket beside the source, and the
 * next commit carries a private key into every clone (#622). So boot asks
 * git one question: is the data directory the checkout itself, or a path
 * inside it that `.gitignore` does not cover? Either is refused, with the
 * reason in one line. A forge running from no checkout (an image, a
 * `checkout-index` deploy) has nothing to protect and is let through.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

/** The real path of `path`, or of its nearest existing ancestor with the rest appended. */
function real(path: string): string {
  const missing: string[] = [];
  let at = resolve(path);
  while (!existsSync(at)) {
    const up = dirname(at);
    if (up === at) break;
    missing.unshift(at.slice(up.length).replace(/^[/\\]+/, ""));
    at = up;
  }
  return resolve(realpathSync(at), ...missing);
}

function git(args: string[], cwd: string): { code: number; out: string } {
  const run = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
  });
  return { code: run.exitCode ?? 1, out: run.stdout.toString().trim() };
}

/**
 * Why `dataDir` may not hold this forge's state, in one line; `null` when
 * it may. `checkout` is any directory inside the forge's own source tree.
 */
export function dataHomeRefusal(
  dataDir: string,
  checkout: string,
): string | null {
  if (!existsSync(checkout)) return null;
  const top = git(["rev-parse", "--show-toplevel"], checkout);
  if (top.code !== 0 || top.out === "") return null;
  const root = real(top.out);
  const data = real(dataDir);
  const rel = relative(root, data);
  if (rel === "")
    return `forge: refusing to boot: the data directory ${data} is the repository checkout; set FORGE_DATA to a path outside it (#622)`;
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    return null;
  // The trailing slash lets a directory pattern (`data/`) match a
  // directory that does not exist yet.
  const ignored = git(
    ["check-ignore", "-q", "--", `${rel.split(sep).join("/")}/`],
    root,
  );
  if (ignored.code === 0) return null;
  return `forge: refusing to boot: the data directory ${data} is inside the checkout ${root} and git does not ignore it; set FORGE_DATA outside it or list it in .gitignore (#622)`;
}
