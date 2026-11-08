/**
 * The walls a trusted source's pull still stops at (#8937): secrets and
 * credentials, permissions and the contract's walls, release machinery.
 * Trust skips the person's review, never these. A guest's pull waits for a
 * person whatever it touches; these say on its page what that person must weigh.
 */
import type { App } from "../app.ts";
import { isContributionFork } from "../core/contribute.ts";
import { pullDir, type Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { foldsIn } from "../core/trusted_sources.ts";
import { runGitCapture } from "../git/env.ts";

/**
 * Paths a person decides on whoever wrote them: secrets and credentials,
 * who may do what, the contract's walls, the machinery that releases and
 * the machinery that enforces these very walls (fold-in, autonomy, the
 * trust list's actions and page, the auth routes, event audiences) and
 * every migration. Each rule says why in the words a person reads on the card.
 */
const WALLS: readonly { readonly test: RegExp; readonly why: string }[] = [
  { test: /(^|\/)\.env([./]|$)|(^|\/)(secrets?|credentials?)([./_-]|$)|\.(pem|key|p12|pfx)$|(^|\/)id_(rsa|ed25519|ecdsa)/i, why: "secrets or credentials" },
  { test: /^src\/(auth|origins\/credential|kernel\/secret|core\/(secret|tokens|keys|sessions|passkeys|run_token|run_grant|proposal_token))/, why: "secrets or credentials" },
  { test: /^src\/(contract|core\/(roles|access_fingerprint|pull_trust|trusted_sources|event_audience)|crew\/(fold_|autonomy|direct|finishing)|http\/(run_gate|[^/]*auth[^/]*|settings_routes|admin_gate)|actions\/(access|app_members|egress_grants|model_grant|trusted_sources|pulls|upstream_follow)|web\/pages\/trusted|tui\/screens\/trusted)/, why: "permissions or the contract's walls" },
  { test: /^(src\/(release|keeper)\/|src\/core\/migration|scripts\/(gate|check|cut-release|roll|dark-roll|rehearse-roll|roll-preflight|pin-migrations)\.ts$|Dockerfile$|charts\/|infra\/|forge\.json$|package\.json$|bun\.lock$|bunfig\.toml$|\.github\/)/, why: "release machinery" },
];

/**
 * Where a trusted source's work may land alone: the code, its tests and the
 * docs. Any other path (the repository's root files, scripts, charts) is one
 * nobody listed, and unlisted waits for a person.
 */
const ALLOWED = /^(src\/|test\/|docs\/|examples\/|README\.md$)/;

/** Why the walls hold `file`, each reason once; empty for a path no wall names. */
export function pathWalls(file: string): string[] {
  return [...new Set(WALLS.filter((w) => w.test.test(file)).map((w) => w.why))];
}

/** What the walls hold a set of files for, as plain sentences; empty when it touches none. */
export function wallsTouched(files: readonly string[], who = "a trusted source's"): string[] {
  const reasons = new Set<string>();
  for (const file of files) {
    const walled = pathWalls(file);
    for (const why of walled) reasons.add(why);
    if (walled.length === 0 && !ALLOWED.test(file)) reasons.add(`a path ${who} work may not change alone`);
  }
  return [...reasons].map((why) => `${who} pull touches ${why}`);
}

/** The files a pull changes against its base, or undefined when git could not say. */
export async function touchedFiles(dir: string, base: string, head: string): Promise<string[] | undefined> {
  const out = await runGitCapture(["diff", "--name-only", "-z", "--no-renames", `${base}...${head}`, "--"], { cwd: dir });
  if (out.code !== 0) return undefined;
  return out.stdout.split("\0").filter((f) => f !== "");
}

/**
 * What waits for a person on a trusted pull even though its source is
 * trusted, or on a pull from a guest's fork of this forge: the walls. Empty
 * for a guest from another forge (it waits for a person anyway) and for a pull
 * that touches none. A diff git cannot read is a wall too: unread is not clear.
 */
export async function foldWall(app: App, repo: Repo, pull: Pull, baseTip: string, now: Date = new Date()): Promise<string[]> {
  const guest = pull.crossRepo && isContributionFork(app.db, pull.headRepoId);
  if (!guest && !foldsIn(app.db, pull.id, now)) return [];
  const who = guest ? "a guest's" : "a trusted source's";
  const dir = await pullDir(app.db, app.reposRoot, repo, pull);
  const files = await touchedFiles(dir, baseTip, pull.headOid);
  return files === undefined ? [`${who} pull could not be read`] : wallsTouched(files, who);
}

