/**
 * What this forge is running: the version and commit its image was built
 * from.
 *
 * The release build stamps both into the image. The `Dockerfile` turns its
 * `VERSION` and `COMMIT` build arguments into `FORGE_VERSION` and
 * `FORGE_COMMIT`, and the release passes the tag it is building. Nothing
 * here reads a number out of a file in the repository: such a number is
 * right only while someone remembers to change it, and the health report
 * once named a release seven behind the one that was running.
 *
 * A forge run from source carries no stamp and says so: `dev`. One that
 * another forge runs as an app, a preview of a pull to the forge itself,
 * is told its commit by that forge's runtime (`FORGE_APP_COMMIT`) and
 * reports it; the stamp is not inherited (`apps/process.ts` starts every
 * child from a short, explicit environment), so a preview never passes
 * for the release that happens to run it.
 *
 * A stamp that does not look like one is treated as absent, since what is
 * read here is printed on pages and in reports.
 */

export interface Running {
  readonly version: string;
  /** The commit that is running, in full, or null when nothing says. */
  readonly commit: string | null;
}

/** What an unstamped forge calls itself; the `Dockerfile`'s own default. */
export const UNSTAMPED = "dev";

const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
const COMMIT = /^[0-9a-f]{7,64}$/;

export function running(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Running {
  // A tag is `v0.7.51`; the version is `0.7.51` however it was passed.
  const version = (env["FORGE_VERSION"] ?? "").trim().replace(/^v(?=\d)/, "");
  const commit = (env["FORGE_COMMIT"] || env["FORGE_APP_COMMIT"] || "")
    .trim()
    .toLowerCase();
  return {
    version: VERSION.test(version) ? version : UNSTAMPED,
    commit: COMMIT.test(commit) ? commit : null,
  };
}

/** The stamp in a line: `0.7.51 · a1b2c3d`, or the version alone. */
export function runningLine(r: Running = running()): string {
  return r.commit === null
    ? r.version
    : `${r.version} · ${r.commit.slice(0, 7)}`;
}
