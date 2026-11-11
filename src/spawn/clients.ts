/**
 * The client list (#776): every forge this one sent, for whom, and how it
 * is doing. The parent's ledger says what was sent; the child itself says
 * whether it was claimed and when anything last happened there, through a
 * small answer (`forgeState`, `GET /api/v1/forge`) that holds nothing else.
 * Claimed is anyone's to know; when anything last happened is the parent's
 * alone, for it tells when private work goes on: the parent shows a secret
 * kept in its ledger, and the child checks it against the hash it holds. A child that does not answer in time reads "unknown": the
 * list never waits on, or fails for, one forge that is down.
 */

import { liveChildDisk, readMountinfo, type ChildDisk } from "./disk_mount.ts";
import type { App } from "../app.ts";
import { childDirOf, listChildren, statusTokenOf, type Child } from "../actions/spawn.ts";
import { timingSafeEqual } from "node:crypto";
import { sha256 } from "../kernel/hash.ts";
import { creditView, usdWords } from "./credit.ts";
import type { ChildAppsSummary } from "./child-apps.ts";
import { childAwake, hostedChildApps } from "./host.ts";
import { hasAdmin, linkOf, spawnedOrg, type LinkInfo, type LinkState } from "./claim.ts";
import { lastHeard, type Beat } from "./heartbeat.ts";
import { reachOf, reachWords, type ChildReach } from "./reach.ts";
import type { Size } from "./sizes.ts";
import { firstScreenLine } from "../core/next-steps.ts";
import { forgeUse, type ForgeUse } from "./usage.ts";

/** What a spawned forge says about itself to anyone: nothing more. */
export interface ForgeState {
  readonly claimed: boolean;
  readonly lastActivityAt: string | null;
  /** The claim link's state; only the parent's secret unlocks it. Absent from an older child. */
  readonly link?: LinkInfo | null;
}

/** One row of the client list; `claimed` is null when the child did not answer. */
export interface ClientRow {
  readonly name: string;
  readonly url: string;
  readonly for: string | null;
  readonly apps: readonly string[];
  readonly sentAt: string | null;
  /** False while the child is still being made (a resumed spawn finishes it). */
  readonly made: boolean;
  readonly claimed: boolean | null;
  readonly lastActivityAt: string | null;
  /** Whether its process is running now; a sleeping forge costs nothing and wakes on its next request. */
  readonly awake?: boolean;
  /** The apps this parent runs for the child; null when it runs none here. */
  readonly running: ChildAppsSummary | null;
  /** What a visitor got from its public addresses when last asked (`spawn/reach.ts`); null before it was. */
  readonly reach: ChildReach | null;
  /** The claim link's state (open, used, ended) and when it was taken back; null when the child did not say. */
  readonly link: LinkInfo | null;
  /** Why this forge needs its owner now; null when it does not. */
  readonly attention: Attention | null;
  /** Where the sent link stands, in four plain states; null while it is being made or the child did not answer. */
  readonly stage: Stage | null;
  /** Dollars the child's crew spent today, from its last heartbeat; null when it has not said. */
  readonly spendTodayUsd: number | null;
  /** The child's forge cap in dollars; null when none or unsaid. */
  readonly ceilingUsd: number | null;
  /** The dollars this forge lends it on its own model credential, and what it has spent; null when none is lent. */
  readonly creditCapUsd?: number | null;
  readonly creditSpentUsd?: number | null;
  /** Its size (`spawn/sizes.ts`). */
  readonly size: Size;
  /** What it uses against that size: its cell's reading, or "shared" when it is hosted here. */
  readonly use: ForgeUse;
  /** Whether its data is a filesystem of its own, and that filesystem's size (`spawn/disk_mount.ts`). */
  readonly disk: ChildDisk;
  /** When its last heartbeat reached this forge, ISO; null when none has. */
  readonly lastHeartbeatAt: string | null;
  /** The first step its person has not taken, read from the child's heartbeat. */
  readonly nextStep: NextStep;
}

export type NextStepKey = "unreported" | "claim" | "everyday" | "tell" | "going";

export interface NextStep {
  readonly key: NextStepKey;
  readonly words: string;
  /** When the person last told the crew something; set only while going. */
  readonly lastTellAt: string | null;
}

/** The first step not yet taken, from the claim state and the child's last beat. */
export function nextStepOf(claimed: boolean | null, beat: Beat | undefined): NextStep {
  const known = beat?.claimed ?? claimed;
  if (beat === undefined || known === null || beat.everyday === undefined || beat.lastTellAt === undefined)
    return { key: "unreported", words: "has not reported yet", lastTellAt: null };
  if (!known) return { key: "claim", words: "not claimed yet", lastTellAt: null };
  if (!beat.everyday) return { key: "everyday", words: "no everyday account yet", lastTellAt: null };
  if (beat.lastTellAt === null) return { key: "tell", words: "no tell yet", lastTellAt: null };
  return { key: "going", words: `going: last tell ${beat.lastTellAt}`, lastTellAt: beat.lastTellAt };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const PROBE_MS = 2000;
/**
 * Where the parent shows its secret. Its own header, not `Authorization`:
 * a bearer there is always a forge token, and this is no account's.
 */
export const PARENT_HEADER = "x-forge-parent";
const fetchers = new WeakMap<App, FetchLike>();

/** Tests (and a placement with its own way in, one day) swap how children are reached. */
export function useChildFetch(app: App, fetcher: FetchLike): void {
  fetchers.set(app, fetcher);
}

/**
 * This forge's own answer; undefined when it was not spawned. `shown` is
 * what the caller showed: only the parent's secret unlocks the timing.
 */
export async function forgeState(
  app: App,
  shown: string | undefined,
): Promise<ForgeState | undefined> {
  const spawned = await spawnedOrg(app);
  if (spawned === undefined) return undefined;
  const claimed = hasAdmin(app.db);
  const parent =
    spawned.statusHash !== undefined &&
    shown !== undefined &&
    timingSafeEqual(Buffer.from(sha256(shown)), Buffer.from(spawned.statusHash));
  if (!parent) return { claimed, lastActivityAt: null };
  // Anything that happened: an event, a tell or a change touched, a run,
  // an account made (the claim is one).
  const last = app.db
    .query<{ at: string | null }, []>(
      `SELECT MAX(at) AS at FROM (
         SELECT MAX(created_at) AS at FROM event
         UNION ALL SELECT MAX(updated_at) FROM issue
         UNION ALL SELECT MAX(created_at) FROM run
         UNION ALL SELECT MAX(created_at) FROM user WHERE kind = 'user' AND is_agent = 0
       )`,
    )
    .get();
  return { claimed, lastActivityAt: last?.at ?? null, link: linkOf(app.db) };
}

const LINK_STATES: readonly LinkState[] = ["open", "used", "ended"];

/** The link a child reported, or null when it said nothing usable. */
function linkOfBody(v: unknown): LinkInfo | null {
  if (typeof v !== "object" || v === null) return null;
  const { state, revokedAt } = v as Record<string, unknown>;
  if (!LINK_STATES.includes(state as LinkState)) return null;
  const iso = (x: unknown): string | null => (typeof x === "string" && !Number.isNaN(Date.parse(x)) ? x : null);
  return { state: state as LinkState, revokedAt: iso(revokedAt), usedAt: iso((v as Record<string, unknown>)["usedAt"]) };
}

async function probe(app: App, child: Child): Promise<ForgeState | undefined> {
  if (!child.done) return undefined;
  const fetcher = fetchers.get(app) ?? fetch;
  const token = await statusTokenOf(app, child.name);
  try {
    const res = await fetcher(`${child.url}/api/v1/forge`, {
      ...(token === undefined ? {} : { headers: { [PARENT_HEADER]: token } }),
      signal: AbortSignal.timeout(PROBE_MS),
      redirect: "error",
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body["claimed"] !== "boolean") return undefined;
    const at = body["lastActivityAt"];
    return {
      link: linkOfBody(body["link"]),
      claimed: body["claimed"],
      lastActivityAt:
        typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : null,
    };
  } catch {
    return undefined;
  }
}

interface Heard {
  readonly state: ForgeState | undefined;
  readonly at: number;
}

/** What each child last said, so the list answers at once. */
const heard = new WeakMap<App, Map<string, Heard>>();
/** Asked again at most this often, however often the list is opened. */
const FRESH_MS = 1500;
const asking = new WeakMap<App, Map<string, Promise<ForgeState | undefined>>>();

/** Forget what a child last said, so the next list asks it again (after its link changed). */
export function forgetHeard(app: App, name: string): void {
  heard.get(app)?.delete(name);
}

function ask(app: App, child: Child): Promise<ForgeState | undefined> {
  let pending = asking.get(app);
  if (!pending) asking.set(app, (pending = new Map()));
  const already = pending.get(child.name);
  if (already) return already;
  const asked = probe(app, child).then((state) => {
    let known = heard.get(app);
    if (!known) heard.set(app, (known = new Map()));
    known.set(child.name, { state, at: Date.now() });
    pending.delete(child.name);
    return state;
  });
  pending.set(child.name, asked);
  return asked;
}

/**
 * Every child this forge sent, newest first. A child never heard from is
 * asked now (all at once, each for at most two seconds); one heard from
 * before answers from what it said, and is asked again in the background
 * when that is no longer fresh, so the list never waits on a known child.
 */
export async function clientRows(app: App): Promise<ClientRow[]> {
  const children = await listChildren(app);
  const known = heard.get(app);
  const now = Date.now();
  const states = await Promise.all(
    children.map((c) => {
      const last = known?.get(c.name);
      if (last === undefined) return ask(app, c);
      if (now - last.at > FRESH_MS) void ask(app, c);
      return last.state;
    }),
  );
  const beats = await Promise.all(children.map((c) => lastHeard(app, c.name)));
  // One read of the mount table for every row.
  const mountinfo = children.length === 0 ? "" : readMountinfo();
  return orderRows(
    children.map((c, i) => ({
      name: c.name,
      url: c.url,
      for: c.for,
      apps: c.apps,
      sentAt: c.createdAt,
      made: c.done,
      claimed: states[i]?.claimed ?? null,
      lastActivityAt: states[i]?.lastActivityAt ?? null,
      awake: childAwake(app, c.name),
      running: hostedChildApps(app, c.name) ?? null,
      reach: reachOf(app, c.name) ?? null,
      spendTodayUsd: beats[i]?.beat.spendTodayUsd ?? null,
      ceilingUsd: beats[i]?.beat.ceilingUsd ?? null,
      ...creditView(app, c.name),
      size: c.size,
      use: forgeUse(c, childDirOf(app, c.bodyId)),
      disk: liveChildDisk(app.config.dataDir, c.bodyId, mountinfo),
      lastHeartbeatAt: beats[i] === undefined ? null : new Date(beats[i]!.receivedAt).toISOString(),
      link: states[i]?.link ?? null,
      nextStep: nextStepOf(states[i]?.claimed ?? null, beats[i]?.beat),
    })),
    now,
  );
}

/** Why a row needs its owner, in the order that matters; null when it does not. */
export type Attention = "silent" | "down" | "unclaimed";

export const ATTENTION_WORDS: Record<Attention, string> = {
  silent: "Not reporting",
  down: "App down",
  unclaimed: "Unclaimed",
};

const ATTENTION_ORDER: readonly Attention[] = ["silent", "down", "unclaimed"];
const SILENT_MS = 24 * 3_600_000;
const UNCLAIMED_MS = 3 * 86_400_000;

/**
 * The first reason this row needs the owner: no word from it in 24 h (it
 * did not answer, or its last activity is older), an app not running, or
 * unclaimed three days after it was sent. A forge still being made waits.
 */
export function attentionOf(r: ClientRow, now: number): Attention | null {
  if (!r.made) return null;
  const last = r.lastActivityAt === null ? NaN : Date.parse(r.lastActivityAt);
  if (r.claimed === null || (!Number.isNaN(last) && now - last > SILENT_MS)) return "silent";
  if (r.running !== null && r.running.notRunning.length > 0) return "down";
  if (r.reach !== null && !r.reach.ok) return "down";
  const sent = r.sentAt === null ? NaN : Date.parse(r.sentAt);
  if (r.claimed === false && !Number.isNaN(sent) && now - sent > UNCLAIMED_MS) return "unclaimed";
  return null;
}

export type StageKey = "sent" | "opened" | "signedin" | "tell";

/** Where a sent link stands, the time that changed, and whether it is time to send it again. */
export interface Stage {
  readonly key: StageKey;
  /** The plain words, the same on the page, the terminal and the MCP answer. */
  readonly words: string;
  /** When it changed, ISO; null when the child did not say. */
  readonly at: string | null;
  /** True when the link has gone unopened for three days: the one action is to resend it. */
  readonly resend: boolean;
}

export const STAGE_WORDS: Record<StageKey, string> = {
  sent: "Sent",
  opened: "Opened",
  signedin: "Signed in",
  tell: "Last tell",
};

export const STALE_WORDS = "Not opened in 3 days";

/**
 * Sent, opened, signed in, told: read from what is already kept (the
 * ledger's send time, the link's spent time, the claim, the last tell in the
 * child's heartbeat). The heartbeat carries only the latest tell, so the last stage says "Last tell", never "First".
 */
export function stageOf(r: Omit<ClientRow, "attention" | "stage">, now: number): Stage | null {
  if (!r.made || r.claimed === null) return null;
  const at = (...xs: (string | null | undefined)[]): string | null => xs.find((x) => typeof x === "string") ?? null;
  const make = (key: StageKey, when: string | null, resend = false): Stage => ({
    key,
    words: resend ? STALE_WORDS : STAGE_WORDS[key],
    at: when,
    resend,
  });
  if (r.claimed) {
    return r.nextStep.lastTellAt !== null
      ? make("tell", r.nextStep.lastTellAt)
      : make("signedin", at(r.link?.usedAt));
  }
  if (r.link?.state === "used") return make("opened", at(r.link.usedAt));
  const sent = r.sentAt === null ? NaN : Date.parse(r.sentAt);
  return make("sent", r.sentAt, !Number.isNaN(sent) && now - sent > UNCLAIMED_MS);
}

/** Rows that need the owner first, by reason; then by last activity, newest first. */
export function orderRows(rows: readonly Omit<ClientRow, "attention" | "stage">[], now: number): ClientRow[] {
  const tier = (a: Attention | null) => (a === null ? ATTENTION_ORDER.length : ATTENTION_ORDER.indexOf(a));
  return rows
    .map((r) => ({ ...r, attention: attentionOf(r as ClientRow, now), stage: stageOf(r as ClientRow, now) }))
    .sort(
      (a, b) =>
        tier(a.attention) - tier(b.attention) ||
        (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") ||
        (b.sentAt ?? "").localeCompare(a.sentAt ?? "") ||
        a.name.localeCompare(b.name),
    );
}

/** A forge's claim state in words, as /forges and the terminal say it. */
export const CLAIM_WORDS: Record<"yes" | "no" | "unknown" | "making", string> = {
  yes: "Claimed",
  no: "Not claimed yet",
  unknown: "Unknown",
  making: "Still being made",
};

export function claimState(r: ClientRow): keyof typeof CLAIM_WORDS {
  if (!r.made) return "making";
  return r.claimed === null ? "unknown" : r.claimed ? "yes" : "no";
}

/** What the recipient will see first, while they have not claimed it; null once they have (the page and the terminal share it). */
export function firstScreenOf(r: ClientRow): string | null {
  return claimState(r) === "no" ? firstScreenLine(r.apps) : null;
}

/** "3 apps running", or which one is not and why; null when none are run here. */
export function runningWords(r: ClientRow): string | null {
  const unreachable = reachWords(r.reach);
  if (unreachable !== null) return unreachable;
  const a = r.running;
  if (a === null || a.total === 0) return null;
  const word = `${a.running} ${a.running === 1 ? "app" : "apps"} running`;
  if (a.notRunning.length === 0) return word;
  return `${word} · ${a.notRunning.map((n) => `${n.slug}: ${n.why}`).join("; ")}`;
}

const money = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** "$3.20 of $200 lent"; null when this forge lends the child nothing. */
export function creditWords(r: Pick<ClientRow, "creditCapUsd" | "creditSpentUsd">): string | null {
  return r.creditCapUsd === null || r.creditCapUsd === undefined ? null : `${usdWords(r.creditSpentUsd ?? 0)} of ${usdWords(r.creditCapUsd)} lent`;
}

/**
 * "$3.20 of $10 today", with "ceiling reached" at the cap; `warn` from 80%.
 * Null when the child has not reported spend.
 */
export function spendWords(r: ClientRow): { words: string; warn: boolean } | null {
  if (r.spendTodayUsd === null) return null;
  const spent = `$${r.spendTodayUsd.toFixed(2)}`;
  if (r.ceilingUsd === null) return { words: `${spent} today`, warn: false };
  const share = r.spendTodayUsd / r.ceilingUsd;
  const base = `${spent} of $${money(r.ceilingUsd)} today`;
  return share >= 1
    ? { words: `${base} · ceiling reached`, warn: true }
    : { words: base, warn: share >= 0.8 };
}
