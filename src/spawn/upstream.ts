/**
 * Looking upstream: a forge that follows fetches its parent's code into
 * `refs/upstream/*` of its own `<org>/forge` repository and keeps how far
 * behind it is in `<data>/upstream.json`. Fetching changes no branch of
 * the fork; taking the commits stays the owner's press.
 *
 * The remote is built here from two validated parts, the parent's origin
 * (`originOf`) and its repository (the `REPO` pattern in `chain.ts`), so no
 * text a person typed reaches the command line. A failure, a hang cut at
 * 60 s included, is recorded and never thrown: the scheduler cannot die of it.
 */

import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { App } from "../app.ts";
import { getAgentByName } from "../core/agents.ts";
import { createIssue, setAssignee } from "../core/issues.ts";
import { getRepo, type Repo } from "../core/repos.ts";
import { getUserById, getUserByName } from "../core/users.ts";
import { runGit } from "../git/env.ts";
import { repoDir } from "../git/repos.ts";
import { forgeLinkOf, originOf } from "./chain.ts";

export const CHECK_MS = 60 * 60_000;
export const FETCH_TIMEOUT_MS = 60_000;
const TIP = /^[0-9a-f]{40,64}$/;

export interface UpstreamState {
  /** Commits the parent has that this fork does not; null when unknown. */
  readonly behind: number | null;
  /** The parent's default branch tip as last fetched; "" when never. */
  readonly parentTip: string;
  /** ms since the epoch of the last attempt. */
  readonly checkedAt: number;
  /** One line; "" when the last attempt worked. */
  readonly error: string;
  /** The parent tip the owner was last told about; "" when never. */
  readonly toldTip: string;
}

const statePath = (app: App): string => join(app.config.dataDir, "upstream.json");

/** The last check, or undefined when none was made or the file is not one. */
export async function upstreamState(app: App): Promise<UpstreamState | undefined> {
  try {
    const d = (await Bun.file(statePath(app)).json()) as Record<string, unknown>;
    const behind = d["behind"];
    if (typeof d["checkedAt"] !== "number" || !Number.isFinite(d["checkedAt"])) return undefined;
    return {
      behind: typeof behind === "number" && Number.isSafeInteger(behind) && behind >= 0 ? behind : null,
      parentTip: typeof d["parentTip"] === "string" && TIP.test(d["parentTip"]) ? d["parentTip"] : "",
      checkedAt: d["checkedAt"],
      error: typeof d["error"] === "string" ? d["error"].slice(0, 200) : "",
      toldTip: typeof d["toldTip"] === "string" && TIP.test(d["toldTip"]) ? d["toldTip"] : "",
    };
  } catch {
    return undefined;
  }
}

async function keep(app: App, s: UpstreamState): Promise<void> {
  try {
    await Bun.write(`${statePath(app)}.tmp`, JSON.stringify(s));
    await rename(`${statePath(app)}.tmp`, statePath(app));
  } catch {
    // Nothing to keep it in: the next check tries again.
  }
}

/** The parent's code repository as a git remote, when this forge follows and has not severed. */
export async function upstreamRemote(app: App): Promise<string | undefined> {
  const link = await forgeLinkOf(app);
  if (link === undefined || link.severedAt !== undefined) return undefined;
  try {
    const doc = await Bun.file(join(app.config.dataDir, "parent.json")).json();
    const origin = originOf((doc as Record<string, unknown>)["upstream"]);
    return origin === "" ? undefined : `${origin}/${link.upstream}.git`;
  } catch {
    return undefined;
  }
}

let inFlight: Promise<UpstreamState | undefined> | undefined;

/**
 * Fetch the parent's code and record how far behind this fork is. Undefined
 * when there is nothing to follow. `remote` stands in for the parent's
 * address (tests point it at a local path); it never comes from a request.
 */
export function checkUpstream(
  app: App,
  options: { remote?: string; now?: number } = {},
): Promise<UpstreamState | undefined> {
  inFlight ??= run(app, options).finally(() => {
    inFlight = undefined;
  });
  return inFlight;
}

async function run(app: App, options: { remote?: string; now?: number }): Promise<UpstreamState | undefined> {
  try {
    const link = await forgeLinkOf(app);
    const remote = options.remote ?? (await upstreamRemote(app));
    if (link === undefined || link.severedAt !== undefined || remote === undefined) return undefined;
    const [o, n] = link.repo.split("/") as [string, string];
    const dir = repoDir(app.reposRoot, o, n);
    const checkedAt = options.now ?? Date.now();
    const fetched = await runGit(
      ["fetch", "--quiet", "--no-tags", "--prune", "--", remote, "+refs/heads/*:refs/upstream/*", "+HEAD:refs/upstream/HEAD"],
      { cwd: dir, timeoutMs: FETCH_TIMEOUT_MS },
    );
    let state: UpstreamState;
    if (!fetched.ok) {
      const line = fetched.error.stderr.split("\n").find((l) => l.trim() !== "")?.trim();
      const error = line ?? (fetched.error.code === 137 ? "the fetch timed out after 60 s" : "the fetch failed");
      const before = await upstreamState(app);
      state = { behind: before?.behind ?? null, parentTip: before?.parentTip ?? "", checkedAt, error: error.slice(0, 200), toldTip: before?.toldTip ?? "" };
    } else {
      const tip = await runGit(["rev-parse", "--verify", "-q", "refs/upstream/HEAD"], { cwd: dir });
      const count = tip.ok
        ? await runGit(["rev-list", "--count", "HEAD..refs/upstream/HEAD"], { cwd: dir })
        : undefined;
      const behind = count?.ok ? Number(count.value.trim()) : NaN;
      state = {
        behind: Number.isSafeInteger(behind) ? behind : null,
        parentTip: tip.ok && TIP.test(tip.value.trim()) ? tip.value.trim() : "",
        checkedAt,
        error: Number.isSafeInteger(behind) ? "" : "the parent has no code to compare",
        toldTip: (await upstreamState(app))?.toldTip ?? "",
      };
    }
    const repo = getRepo(app.db, o, n);
    // Remember the tip before the card, so a crash between them can lose a card but never repeat one.
    const tell = repo !== undefined && link.mode === "tell-me" && state.error === "" && state.parentTip !== "" &&
      (state.behind ?? 0) > 0 && state.parentTip !== state.toldTip;
    if (tell) state = { ...state, toldTip: state.parentTip };
    await keep(app, state);
    if (tell) tellOwner(app, repo, link.repo, state.behind!);
    // Tell an open chain page its line changed; no actor when the timer checks.
    if (repo !== undefined)
      app.bus.append({
        kind: "forge.upstream",
        repoId: repo.id,
        payload: { repo: link.repo, behind: state.behind, error: state.error },
      });
    return state;
  } catch (e) {
    return { behind: null, parentTip: "", checkedAt: Date.now(), error: e instanceof Error ? e.message.slice(0, 200) : "the check failed", toldTip: "" };
  }
}

/**
 * One inbox card for the owner: an issue on the fork assigned to them, which
 * the inbox shows as "assigned to you", and which links the chain page. The
 * sentinel files it when the forge has one, so it is not the owner's own ask.
 */
function tellOwner(app: App, repo: Repo, fork: string, behind: number): void {
  try {
    const owner = getUserById(app.db, repo.ownerId);
    if (owner === undefined) return;
    const sentinel = getAgentByName(app.db, "sentinel") === undefined ? undefined : getUserByName(app.db, "sentinel");
    const made = createIssue(app.db, {
      repoId: repo.id,
      authorId: (sentinel ?? owner).id,
      title: `Your parent forge has ${behind} new commit${behind === 1 ? "" : "s"}`,
      body: `Your parent forge's code moved. See where you stand and take it from [the chain page](/${fork}/following).`,
    });
    if (made.ok) setAssignee(app.db, made.value.id, owner.id);
  } catch {
    // The card is a courtesy; the check must not fail on it.
  }
}

/** Check at boot and every hour; returns the timer to clear. */
export function startUpstreamWatch(app: App): ReturnType<typeof setInterval> {
  void checkUpstream(app);
  return setInterval(() => void checkUpstream(app), CHECK_MS);
}

/** The state in one plain sentence, escaped by whoever renders it. */
export function upstreamWords(s: UpstreamState | undefined, now = Date.now()): string {
  if (s === undefined) return "not checked yet";
  const mins = Math.max(0, Math.floor((now - s.checkedAt) / 60_000));
  const when = mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)} h ago`;
  if (s.error !== "") return `could not check your parent: ${s.error} (${when})`;
  if (s.behind === null) return `checked ${when}`;
  if (s.behind === 0) return `up to date (checked ${when})`;
  return `your parent has ${s.behind} new commit${s.behind === 1 ? "" : "s"} (checked ${when})`;
}

/** The state as the API and MCP carry it; null before the first check. */
export async function upstreamPayload(app: App): Promise<UpstreamState | null> {
  return (await upstreamState(app)) ?? null;
}
