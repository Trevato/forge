/**
 * A display's write half: choosing its builds. `display.json` on the default
 * branch is the record, so a choice is a commit that sets its `builds` list
 * (`commitToBranch` announces the push, and the display caches drop). The
 * person must write the repository (never an agent), and every build named
 * must be a pin in a repository they read.
 */

import type { App } from "../app.ts";
import { readFileAt } from "../apps/checkout.ts";
import { canRead, getRepo, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { DISPLAY_FILE, parseBuilds, parseDisplay } from "../display/config.ts";
import { sourceRepos } from "../display/items.ts";
import { writesDisplay } from "../display/selections.ts";
import { exactRefOid } from "../git/branches.ts";
import { listBuildPins } from "../git/builds.ts";
import { isSafeOid } from "../git/guard.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { commitToBranch } from "./repos.ts";

export type ChooseError =
  | { kind: "forbidden" }
  | { kind: "no_display" }
  | { kind: "invalid"; message: string }
  | { kind: "failed"; message: string };

const splitKey = (key: string): [string, string, string] => {
  const at = key.lastIndexOf(":");
  const [owner = "", name = ""] = key.slice(0, at).split("/");
  return [owner, name, key.slice(at + 1)];
};

export interface Choice {
  readonly builds: readonly string[];
  /** The default branch's commit the chooser saw: the save is refused (409) if it has moved. */
  readonly tip?: string;
}

/** The body of a PUT, checked: `{ "builds": [owner/name:label, …], "tip"?: commit }`. */
export function parseChoice(input: unknown): Result<Choice, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return err("the body must be a JSON object");
  const keys = Object.keys(input);
  if (keys.some((k) => k !== "builds" && k !== "tip")) return err("the body may hold only builds and tip");
  const tip = (input as { tip?: unknown }).tip;
  if (tip !== undefined && (typeof tip !== "string" || !isSafeOid(tip))) return err("tip must be a full commit id");
  const builds = (input as { builds?: unknown }).builds;
  if (builds === undefined) return err("builds is required");
  const parsed = parseBuilds(builds);
  return parsed.ok ? ok({ builds: parsed.value ?? [], ...(tip === undefined ? {} : { tip }) }) : err(parsed.error);
}

/** Set the display's `builds` to `builds`, in that order. */
export async function chooseBuilds(app: App, user: User | undefined, repo: Repo, builds: readonly string[], seenTip?: string): Promise<Result<readonly string[], ChooseError>> {
  if (!writesDisplay(app, repo, user)) return err({ kind: "forbidden" });
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const tip = await exactRefOid(dir, `refs/heads/${repo.defaultBranch}`);
  const text = tip === undefined ? undefined : await readFileAt(dir, tip, DISPLAY_FILE);
  if (tip === undefined || text === undefined) return err({ kind: "no_display" });
  const config = parseDisplay(text);
  if (!config.ok) return err({ kind: "invalid", message: config.error });

  const pinsOf = new Map<string, Set<string>>();
  for (const key of builds) {
    const [owner, name, label] = splitKey(key);
    const found = getRepo(app.db, owner, name);
    // A repository the person cannot read is not there for them.
    if (found === undefined || !canRead(app.db, found, user)) return err({ kind: "invalid", message: `no build ${key}` });
    let labels = pinsOf.get(found.id);
    if (labels === undefined) {
      labels = new Set((await listBuildPins(repoDir(app.reposRoot, found.ownerName, found.name))).map((p) => p.label));
      pinsOf.set(found.id, labels);
    }
    if (!labels.has(label)) return err({ kind: "invalid", message: `no build ${key}` });
  }

  const file = { ...(JSON.parse(text) as Record<string, unknown>), builds: [...builds] };
  const made = await commitToBranch(app, user, repo, {
    message: "Choose the display's builds",
    files: [{ path: DISPLAY_FILE, content: `${JSON.stringify(file, null, 2)}\n` }],
    expectTip: seenTip ?? tip,
  });
  if (!made.ok) return err({ kind: "failed", message: "the display could not be saved; reload and try again" });
  return ok([...builds]);
}

/** Every build the person could add: the pins of the display's sources they read, plus those already chosen. */
export async function choosableBuilds(app: App, sources: Parameters<typeof sourceRepos>[1], chosen: readonly string[], user: User | undefined): Promise<string[]> {
  const out = [...chosen];
  for (const r of sourceRepos(app, sources)) {
    if (!canRead(app.db, r, user)) continue;
    for (const pin of await listBuildPins(repoDir(app.reposRoot, r.ownerName, r.name))) {
      const key = `${r.ownerName}/${r.name}:${pin.label}`;
      if (!out.includes(key)) out.push(key);
    }
  }
  return out;
}
