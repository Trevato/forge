/**
 * The chain of forges a spawned forge's own code descends from. Each child
 * carries `<org>/forge`, a fork of the forge it came from; `parent.json`
 * keeps where, how the owner chose to follow (`tell-me` or `take-updates`),
 * the tip it was born at, and the hops above it, copied from the parent's
 * own `parent.json` at spawn. So a grandchild reads its whole chain to the
 * root without asking anyone, and the numbers are honest: each is as of
 * the day that hop was made, except the last, which is counted here.
 *
 * A forge is sovereign: severing writes `severedAt` and nothing else. The
 * fork, its history and the record of where it came from all stay.
 */

import { join } from "node:path";
import { rename } from "node:fs/promises";
import type { App } from "../app.ts";
import { runGit } from "../git/env.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export const FOLLOW_MODES = ["tell-me", "take-updates"] as const;
export type FollowMode = (typeof FOLLOW_MODES)[number];
/** What a new forge follows with; a link on disk with no mode is read as `tell-me`, as it always was. */
export const DEFAULT_MODE: FollowMode = "take-updates";

/** One forge in the chain, as recorded when the hop below it was made. */
export interface Hop {
  /** `owner/name` of its forge repository on its own forge. */
  readonly repo: string;
  /** Its forge's address; "" when it did not say. */
  readonly forge: string;
  /** How it follows the hop above it; null for the root. */
  readonly mode: FollowMode | null;
  /** Its default branch's tip when the next hop was born. */
  readonly tip: string;
  /** Commits it had of its own then; null for the root or when unknown. */
  readonly ahead: number | null;
}

/** The `forgeCode` record in `parent.json`. */
export interface ForgeLink {
  readonly repo: string;
  readonly upstream: string;
  readonly mode: FollowMode;
  /** The upstream's tip at birth. */
  readonly tip: string;
  /** Root first, ending with the parent. */
  readonly chain: readonly Hop[];
  readonly severedAt?: string;
}

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const TIP = /^[0-9a-f]{40,64}$/;

const isMode = (v: unknown): v is FollowMode =>
  typeof v === "string" && (FOLLOW_MODES as readonly string[]).includes(v);

/** The origin of an http(s) address, or "" when it is not one; parsed once, here, so nothing downstream can throw on it. */
export function originOf(v: unknown): string {
  if (typeof v !== "string" || v.length > 200) return "";
  const u = URL.parse(v);
  return u !== null && (u.protocol === "http:" || u.protocol === "https:") ? u.origin : "";
}

function readHop(v: unknown): Hop | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const h = v as Record<string, unknown>;
  if (typeof h["repo"] !== "string" || !REPO.test(h["repo"])) return undefined;
  if (typeof h["tip"] !== "string" || !TIP.test(h["tip"])) return undefined;
  const forge = originOf(h["forge"]);
  const ahead =
    typeof h["ahead"] === "number" && Number.isSafeInteger(h["ahead"]) && h["ahead"] >= 0 ? h["ahead"] : null;
  return { repo: h["repo"], forge, mode: isMode(h["mode"]) ? h["mode"] : null, tip: h["tip"], ahead };
}

/** Everything in `parent.json`, untouched, so a rewrite keeps what it does not know. */
async function readDoc(app: App): Promise<Record<string, unknown> | undefined> {
  try {
    const doc = await Bun.file(join(app.config.dataDir, "parent.json")).json();
    return typeof doc === "object" && doc !== null && !Array.isArray(doc) ? (doc as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** This forge's link to the forge its code came from, when it has one. */
export async function forgeLinkOf(app: App): Promise<ForgeLink | undefined> {
  const doc = await readDoc(app);
  const f = doc?.["forgeCode"];
  if (typeof f !== "object" || f === null) return undefined;
  const l = f as Record<string, unknown>;
  if (typeof l["repo"] !== "string" || !REPO.test(l["repo"])) return undefined;
  if (typeof l["upstream"] !== "string" || !REPO.test(l["upstream"])) return undefined;
  const chain = Array.isArray(l["chain"])
    ? l["chain"].map(readHop).filter((h): h is Hop => h !== undefined).slice(0, 16)
    : [];
  const severedAt =
    typeof l["severedAt"] === "string" && !Number.isNaN(Date.parse(l["severedAt"])) ? l["severedAt"] : undefined;
  return {
    repo: l["repo"],
    upstream: l["upstream"],
    mode: isMode(l["mode"]) ? l["mode"] : "tell-me",
    tip: typeof l["tip"] === "string" && TIP.test(l["tip"]) ? l["tip"] : "",
    chain,
    ...(severedAt === undefined ? {} : { severedAt }),
  };
}

async function tipOf(app: App, repo: string, base?: string): Promise<{ tip: string; ahead: number | null } | undefined> {
  const [o, n] = repo.split("/") as [string, string];
  const dir = repoDir(app.reposRoot, o, n);
  const head = await runGit(["rev-parse", "--verify", "-q", "HEAD"], { cwd: dir });
  if (!head.ok) return undefined;
  const tip = head.value.trim();
  if (base === undefined || base === "") return { tip, ahead: null };
  const n2 = await runGit(["rev-list", "--count", `${base}..${tip}`], { cwd: dir });
  const count = n2.ok ? Number(n2.value.trim()) : NaN;
  return { tip, ahead: Number.isSafeInteger(count) ? count : null };
}

/**
 * The chain a child spawned from this forge is born with: this forge's own
 * ancestors, then this forge. `repo` is this forge's code repository.
 */
export async function chainForChild(
  app: App,
  repo: string,
): Promise<{ chain: Hop[]; tip: string } | undefined> {
  const link = await forgeLinkOf(app);
  const doc = await readDoc(app);
  const here = await tipOf(app, repo, link?.tip);
  if (here === undefined) return undefined;
  const url = app.config.url ?? (typeof doc?.["url"] === "string" ? doc["url"] : "");
  const me: Hop = {
    repo,
    forge: originOf(url),
    mode: link === undefined || link.severedAt !== undefined ? null : link.mode,
    tip: here.tip,
    ahead: here.ahead,
  };
  return { chain: [...(link?.chain ?? []), me], tip: here.tip };
}

export interface ChainLine {
  readonly repo: string;
  /** Its forge's host, "" when unsaid. */
  readonly host: string;
  /** How this hop follows the one above it; null for the root. */
  readonly mode: FollowMode | null;
  readonly ahead: number | null;
  readonly here: boolean;
  readonly severedAt: string | null;
}

export interface ChainView {
  readonly lines: readonly ChainLine[];
  readonly severedAt: string | null;
}

/** The chain to the root, root first, this forge last; undefined when this forge carries no fork. */
export async function chainView(app: App): Promise<ChainView | undefined> {
  const link = await forgeLinkOf(app);
  if (link === undefined) return undefined;
  const own = await tipOf(app, link.repo, link.tip);
  const lines: ChainLine[] = link.chain.map((h) => ({
    repo: h.repo,
    host: h.forge === "" ? "" : new URL(h.forge).host,
    mode: h.mode,
    ahead: h.ahead,
    here: false,
    severedAt: null,
  }));
  lines.push({
    repo: link.repo,
    host: originOf(app.config.url) === "" ? "" : new URL(originOf(app.config.url)).host,
    mode: link.severedAt === undefined ? link.mode : null,
    ahead: own?.ahead ?? null,
    here: true,
    severedAt: link.severedAt ?? null,
  });
  return { lines, severedAt: link.severedAt ?? null };
}

/** The tip of this forge's own code, for the heartbeat; null when there is none. */
export async function forgeTipOf(app: App): Promise<string | null> {
  const link = await forgeLinkOf(app);
  if (link === undefined) return null;
  return (await tipOf(app, link.repo))?.tip ?? null;
}

/**
 * Cut the upstream link. Only the record changes: the fork, its history and
 * the note of where it came from stay. Idempotent; the first date stands.
 */
export async function severChain(app: App, now = new Date()): Promise<Result<string, "not_following">> {
  const doc = await readDoc(app);
  const link = await forgeLinkOf(app);
  if (doc === undefined || link === undefined) return err("not_following");
  if (link.severedAt !== undefined) return ok(link.severedAt);
  const at = now.toISOString();
  await writeLink(app, doc, { severedAt: at });
  return ok(at);
}

/** Rewrite `forgeCode` with `patch` laid over it, atomically: the file is whole before and after. */
async function writeLink(app: App, doc: Record<string, unknown>, patch: object): Promise<void> {
  const path = join(app.config.dataDir, "parent.json");
  await Bun.write(`${path}.tmp`, JSON.stringify({ ...doc, forgeCode: { ...(doc["forgeCode"] as object), ...patch } }));
  await rename(`${path}.tmp`, path);
}

/** Record how this forge follows its parent from now on; a severed forge follows nothing, so it refuses. */
export async function setChainMode(app: App, mode: FollowMode): Promise<Result<FollowMode, "not_following" | "severed">> {
  const doc = await readDoc(app);
  const link = await forgeLinkOf(app);
  if (doc === undefined || link === undefined) return err("not_following");
  if (link.severedAt !== undefined) return err("severed");
  await writeLink(app, doc, { mode });
  return ok(mode);
}

export const isFollowMode = isMode;

/** The chain, when `repo` is this forge's own code repository; undefined for any other. */
export async function chainOfRepo(app: App, repo: { ownerName: string; name: string }): Promise<ChainView | undefined> {
  const link = await forgeLinkOf(app);
  if (link === undefined || link.repo !== `${repo.ownerName}/${repo.name}`) return undefined;
  return chainView(app);
}

/** The chain as plain lines, for a terminal: one per hop, root first. */
export function chainLines(view: ChainView): [string, string][] {
  return view.lines.map((l) => {
    const how =
      l.severedAt !== null
        ? `follows nothing since ${l.severedAt.slice(0, 10)}`
        : l.mode === null
          ? "follows nothing"
          : l.mode;
    const bits = [how, l.ahead === null ? "" : `${l.ahead} of its own`, l.host].filter((b) => b !== "");
    return [l.here ? `${l.repo} (here)` : l.repo, bits.join(" · ")];
  });
}
