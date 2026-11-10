/**
 * Something that newly needs you reaches your phone. A person may set one
 * HTTPS URL (an ntfy topic, or anything that takes a POST of plain text);
 * when the forge's events change what asks them — a pull the crew stopped
 * on, a green pull waiting for a look, a repository at its ceiling, and for
 * the forge's admin a person who just joined — one
 * short line and a link to the asks screen is posted there. A milestone
 * the person watches says one line too, once, when it lands, with a link to
 * the milestone; its progress never does.
 *
 * What asks a person is read the way the asks panel reads it
 * (`askLinesFor`), as that person, so nothing private leaves for someone who
 * could not read it. "New" means not in the set last seen for them. At most
 * one line per ask, at most `HOURLY` an hour per person, and a dead endpoint
 * costs a growing pause rather than a retry: a line that cannot be sent is
 * dropped, never queued. Nothing here blocks the event stream — the work
 * runs after the event, off its stack.
 *
 * The URL is a secret (an ntfy topic is a password): it lives in the user's
 * settings, is never logged, and the account page shows its host only.
 */

import { blockedLines } from "../actions/egress_refused.ts";
import { newAccountLines } from "../actions/accounts.ts";
import { mailCeilingLines } from "../actions/mail.ts";
import { forgetOnboarding, onboardedLines } from "../apps/onboarding.ts";
import type { Database } from "bun:sqlite";
import { outboundFetch } from "../kernel/outbound.ts";
import type { App } from "../app.ts";
import { isPrivateHost } from "../actions/migrate.ts";
import { getUserSetting, setUserSetting } from "../core/settings.ts";
import { getUserById, type User } from "../core/users.ts";
import { redHref, redMain, redSentence } from "../checks/red_main.ts";
import { landedLines } from "../core/watches.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { lastMirror, mirrorNeed } from "../snapshot/mirror.ts";
import { markRollbackPaged, rollbackNeed, rolledBack } from "../release/launch.ts";
import { drillNeed, firstSeen, lastVerdict } from "../snapshot/verdict.ts";
import { domainDrillNeeds } from "../kernel/domain_drill.ts";
import { DOMAINS } from "../kernel/domains.ts";
import { newestDrills } from "../core/domain_drills.ts";
import { health } from "../http/health.ts";
import { forgeVitals } from "../actions/health.ts";
import { RECOVERED, drainIncident, nextPage, observe, recoveredLine, type Watch } from "./incidents.ts";
import { firedAlarms, type FiredAlarm } from "../flow/alarms.ts";
import { reachAlarms } from "../spawn/reach.ts";
import { loadClog } from "../flow/clog_tick.ts";
import { redactSecrets } from "../kernel/log.ts";
import { forgeCeiling } from "../flow/ceiling.ts";
import { askLinesFor } from "../web/studio/asks.ts";
import { during } from "../perf/jobs.ts";

const KEY = "notify_url";
export const MAX_URL = 200;
const HOURLY = 10;
const HOUR_MS = 3_600_000;
const CLOCK_MS = 10 * 60_000;
const PAGE_MS = 60_000;
const SEND_TIMEOUT_MS = 5_000;
const BACKOFF_FIRST_MS = 60_000;
const BACKOFF_MAX_MS = HOUR_MS;

/** Events after which the set of asks may have changed. */
const WAKES = new Set([
  "clog.started",
  "run.finished",
  "app.serving",
  "pull.opened",
  "pull.pushed",
  "pull.reviewed",
  "pull.merged",
  // A new app's crew pull closed without landing: it needs its owner (`apps/onboarding.ts`).
  "pull.closed",
  "issue.closed",
  "issue.commented",
  "repo.settings_updated",
  "account.notify_set",
  "user.created",
  "mail.ceiling",
  "drill.finished",
  // An app's cell was refused a host for the first time (`apps/egress_refused.ts`).
  "app.egress.refused",
  "app.egress.ignored",
  "app.egress.allowed",
]);

export type NotifyUrlError =
  | "invalid_url"
  | "not_https"
  | "credentials"
  | "too_long"
  | "private_host";

/** The URL as it will be stored, or why it is refused. */
export function parseNotifyUrl(raw: string): Result<string, NotifyUrlError> {
  const text = raw.trim();
  if (text.length > MAX_URL) return err("too_long");
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return err("invalid_url");
  }
  if (url.protocol !== "https:") return err("not_https");
  if (url.username !== "" || url.password !== "") return err("credentials");
  const host = url.hostname.toLowerCase();
  if (
    isPrivateHost(host) ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".") || // a bare name is inside someone's network
    host.startsWith("[") // an IPv6 literal is never a topic host
  )
    return err("private_host");
  return ok(url.toString());
}

export const NOTIFY_ERRORS: Record<NotifyUrlError, string> = {
  invalid_url: "That isn't a URL.",
  not_https: "Only https: addresses are accepted.",
  credentials: "Leave the username and password out of the address.",
  too_long: `Keep it under ${MAX_URL} characters.`,
  private_host: "That address is inside a network, not on the internet.",
};

export const notifyUrlOf = (db: Database, userId: string): string | undefined =>
  getUserSetting(db, userId, KEY) || undefined;

/** Save a validated URL; an empty string clears it. */
export function setNotifyUrl(
  db: Database,
  userId: string,
  raw: string,
): Result<"set" | "cleared", NotifyUrlError> {
  if (raw.trim() === "") {
    db.query("DELETE FROM user_setting WHERE user_id = ?1 AND key = ?2").run(
      userId,
      KEY,
    );
    return ok("cleared");
  }
  const parsed = parseNotifyUrl(raw);
  if (!parsed.ok) return parsed;
  setUserSetting(db, userId, KEY, parsed.value);
  return ok("set");
}

/** What the account page may show of the URL: its host, nothing after. */
export function notifyHost(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

export type Sender = (
  url: string,
  body: string,
  headers: Record<string, string>,
) => Promise<boolean>;

/**
 * The real sender: the name is resolved and judged first, no redirect is
 * followed, and only https is spoken. A refusal or a transport error is a
 * message not sent, never a throw.
 */
export const post: Sender = async (url, body, headers) => {
  try {
    const res = await outboundFetch(url, {
      method: "POST",
      body,
      headers: { "content-type": "text/plain; charset=utf-8", ...headers },
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
};

export const TEST_LINE = "Test from the forge — notifications reach you.";
const TEST_GAP_MS = 30_000;
const lastTest = new Map<string, number>();

/** Whether this person may send a test now: one per `TEST_GAP_MS`. Claims the slot when it says yes. */
export function claimTest(userId: string, now = Date.now()): boolean {
  for (const [id, at] of lastTest) if (now - at >= TEST_GAP_MS) lastTest.delete(id);
  if (lastTest.has(userId)) return false;
  lastTest.set(userId, now);
  return true;
}

/**
 * One short line to the saved URL, to prove it works. Never throws; the
 * URL's path (it can hold a secret) is never logged.
 */
export async function sendTest(
  db: Database,
  userId: string,
  sender: Sender = post,
): Promise<"sent" | "refused" | "off"> {
  const url = notifyUrlOf(db, userId);
  if (url === undefined) return "off";
  try {
    return (await sender(url, TEST_LINE, { title: "forge" })) ? "sent" : "refused";
  } catch {
    return "refused";
  }
}

/**
 * The forge's admin hears of a red restore drill, or none in eight days,
 * once per cause: the id is the drill's own key, so a repeat tick is not news.
 */
export function drillLines(
  app: App,
  user: User,
  now = Date.now(),
): { id: string; line: string; items: readonly string[] }[] {
  if (!user.isAdmin || user.kind !== "user") return [];
  const need = drillNeed(lastVerdict(app.config.dataDir), now, () => firstSeen(app.config.dataDir));
  if (need === undefined) return [];
  const id = `drill:${need.key}`;
  return [{ id, line: need.sentence, items: [id] }];
}

/**
 * The forge's admin hears of a domain drill that is red, stale or never run,
 * with the command that runs it. The needs are the vitals' own
 * (`domainDrillNeeds`); the id is the cause and its `since`, so a repeat tick
 * is not news and a later red is.
 */
export function domainDrillLines(
  app: App,
  user: User,
  now = Date.now(),
  forgeUrl = "http://localhost",
): { id: string; line: string; items: readonly string[] }[] {
  if (!user.isAdmin || user.kind !== "user") return [];
  return domainDrillNeeds(
    newestDrills(app.db),
    now,
    firstSeen(app.config.dataDir),
    forgeUrl,
    DOMAINS,
  ).map((need) => {
    const id = `${need.cause}@${need.since}`;
    return { id, line: need.sentence, items: [id] };
  });
}

/** The admin hears of a snapshot that did not land off the box, or a stale mirror, once per cause. */
export function mirrorLines(
  app: App,
  user: User,
  now = Date.now(),
): { id: string; line: string; items: readonly string[] }[] {
  if (!user.isAdmin || user.kind !== "user") return [];
  const need = mirrorNeed(lastMirror(app.config.dataDir), now);
  if (need === undefined) return [];
  const id = `mirror:${need.key}`;
  return [{ id, line: need.sentence, items: [id] }];
}

/**
 * A person hears once when main is red in a repository they own, however
 * the check failed: the crew files nothing for another repository's red
 * main (#3992), so the owner is the one told. The id is the failing run's.
 */
export function redLines(
  app: App,
  user: User,
  _now = Date.now(),
): { id: string; line: string; items: readonly string[]; link: string }[] {
  if (user.kind !== "user") return [];
  const out: { id: string; line: string; items: readonly string[]; link: string }[] = [];
  for (const { id } of app.db
    .query<{ id: string }, [string]>("SELECT id FROM repo WHERE owner_id = ?1 AND archived_at IS NULL")
    .all(user.id)) {
    const red = redMain(app.db, id);
    if (red === undefined || red.limit) continue;
    const key = `red:${red.runId}`;
    out.push({ id: key, line: redSentence(red, 0), items: [key], link: redHref(red) });
  }
  return out;
}

/**
 * The owner hears once when a flow alarm (#5930) starts firing. The id is the
 * alarm and when it began, so a standing alarm is the same ask on every tick
 * and a later one is new. Admin only: the words name private repositories.
 */
export function alarmLines(
  app: App,
  user: User,
  now = Date.now(),
  fired?: readonly FiredAlarm[],
): { id: string; line: string; items: readonly string[]; link: string }[] {
  if (!user.isAdmin || user.kind !== "user") return [];
  const alarms = fired ?? [...firedAlarms(app.db, new Date(now), { ceilingUsd: forgeCeiling(app.config), dataDir: app.config.dataDir }), ...reachAlarms(app)];
  return alarms.map((a) => {
    const id = `alarm:${a.key}@${a.since}`;
    return { id, line: a.says, items: [id], link: a.href };
  });
}

/**
 * The owner hears once when a clog (#6524) starts: the id is the clog's own
 * start, so the one standing clog is the same ask on every tick and a later
 * one is new. The state is the database's, so a restart never says it twice.
 */
export function clogLines(
  app: App,
  user: User,
): { id: string; line: string; items: readonly string[]; link: string }[] {
  if (!user.isAdmin || user.kind !== "user") return [];
  const clog = loadClog(app.db);
  if (clog === null) return [];
  const id = `clog:${clog.since}`;
  return [{ id, line: `Clogged: ${clog.firstReasons.join("; ")}.`, items: [id], link: "/" }];
}

export interface Notifier {
  /** Resolves when the work queued so far is done. For tests and shutdown. */
  settled(): Promise<void>;
  /** Looks at the forge's own health now, as the minute's clock does. */
  tick(): Promise<void>;
  /** Stops listening and the asks' clock; the drain pager keeps watching. */
  stop(): void;
  /** Stops everything, the pager too: the last step before the process goes. */
  close(): Promise<void>;
}

export interface NotifyOptions {
  /** The forge's public address; the link goes to its asks screen. */
  forgeUrl: string;
  send?: Sender;
  now?: () => number;
  /** How often the clock wakes the notifier; ten minutes unless a test says. */
  clockMs?: number;
  /** When this process began draining; the live health unless a test says. */
  drainingSince?: () => number | null;
  /** The causes the vitals hold now; the live vitals unless a test says. */
  causes?: () => readonly { cause: string; sentence: string }[];
  /** The alarms firing now; the live four unless a test says. */
  alarms?: () => readonly FiredAlarm[];
}

/** Long enough for a domain drill line to keep every command it names. */
const LINE_MAX = 600;
const oneLine = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, LINE_MAX);

export function startNotifier(app: App, options: NotifyOptions): Notifier {
  const send = options.send ?? post;
  const now = options.now ?? Date.now;
  const link = new URL("/", options.forgeUrl).toString();
  /** Per person: the asks last seen, and so already told or deliberately skipped. */
  const seen = new Map<string, Set<string>>();
  const sent = new Map<string, number[]>();
  const pause = new Map<string, { until: number; next: number }>();
  /** Per admin: the drain last paged and not yet recovered, set only after delivery. */
  const paged = new Map<string, string | undefined>();
  /** Per admin: the owned vitals causes being watched. */
  const watching = new Map<string, Watch>();
  /** Admins this process itself paged and has not yet told Recovered. */
  const mine = new Set<string>();
  let queue: Promise<void> = Promise.resolve();
  let stopped = false;

  const people = (): string[] =>
    app.db
      .query<
        { user_id: string },
        [string]
      >("SELECT user_id FROM user_setting WHERE key = ?1 AND value <> ''")
      .all(KEY)
      .map((r) => r.user_id);

  const drainStart = (): number | null =>
    options.drainingSince
      ? options.drainingSince()
      : health.draining
        ? health.drainingSince
        : null;

  /**
   * The admin is paged once for a drain past five minutes and once when it
   * ends. The key is recorded after delivery only, so a page the cap or the
   * backoff held back is tried again next tick and its Recovered is kept.
   */
  async function page(userId: string, baseline: boolean): Promise<void> {
    const user = getUserById(app.db, userId);
    const url = notifyUrlOf(app.db, userId);
    if (user === undefined || url === undefined || !user.isAdmin || user.kind !== "user") {
      paged.delete(userId);
      watching.delete(userId);
      return;
    }
    await pageDrain(userId, url, baseline);
    await pageCauses(userId, url, baseline);
  }

  /** Sends one line under the hourly cap and the backoff; whether it was delivered. */
  async function push(userId: string, url: string, line: string): Promise<boolean> {
    const t = now();
    const recent = (sent.get(userId) ?? []).filter((s) => t - s < HOUR_MS);
    sent.set(userId, recent);
    if (recent.length >= HOURLY || t < (pause.get(userId)?.until ?? 0)) return false;
    recent.push(t);
    let delivered = false;
    try {
      delivered = await send(url, `${oneLine(line)}\n${link}`, {
        click: link,
        title: "forge",
      });
    } catch {
      delivered = false;
    }
    if (delivered) {
      pause.delete(userId);
      return true;
    }
    const wait = Math.min(pause.get(userId)?.next ?? BACKOFF_FIRST_MS, BACKOFF_MAX_MS);
    pause.set(userId, { until: now() + wait, next: wait * 2 });
    app.log.warn("notify endpoint failed; pausing", {
      host: notifyHost(url) ?? "",
      pauseMs: wait,
    });
    return false;
  }

  /** Errors, internal faults, a long queue or a full disk: paged once held, recovered once gone. */
  async function pageCauses(userId: string, url: string, baseline: boolean): Promise<void> {
    const present = options.causes ? options.causes() : forgeVitals(app).degraded;
    let watch = watching.get(userId);
    const seed = baseline || watch === undefined;
    if (watch === undefined) watching.set(userId, (watch = new Map()));
    const due = observe(watch, present, now(), seed);
    for (const key of due.pages) {
      if (!(await push(userId, url, watch.get(key)!.sentence))) return;
      watch.get(key)!.paged = true;
    }
    for (const key of due.recovered) {
      if (!(await push(userId, url, recoveredLine(key)))) return;
      watch.delete(key);
    }
  }

  /**
   * A roll the image's launcher undid (`release/launch.ts`) is news once,
   * ever: it happened before this process began, so no baseline would page
   * it. Marked on disk once it reached an admin, or when no admin can be
   * reached; a page the backoff held is tried again on the pager's tick.
   */
  async function pageRollback(): Promise<void> {
    const dataDir = app.config.dataDir;
    const need = rollbackNeed(dataDir);
    if (need === undefined || rolledBack(dataDir)?.paged !== false) return;
    let reachable = false;
    let delivered = false;
    for (const id of people()) {
      const user = getUserById(app.db, id);
      const url = notifyUrlOf(app.db, id);
      if (user === undefined || url === undefined || !user.isAdmin || user.kind !== "user") continue;
      reachable = true;
      // The sentence quotes the release's stderr: nothing credential-shaped leaves in a push.
      if (await push(id, url, redactSecrets(need.sentence))) delivered = true;
    }
    if (delivered || !reachable) markRollbackPaged(dataDir);
  }

  async function pageDrain(userId: string, url: string, baseline: boolean): Promise<void> {
    const current = drainIncident(drainStart(), now());
    if (baseline || !paged.has(userId)) {
      // A restart has paged what it paged: start from what is true now.
      paged.set(userId, current?.key);
      return;
    }
    const next = nextPage(current, paged.get(userId));
    if (next === undefined) return;
    if (!(await push(userId, url, next.line))) return;
    paged.set(userId, next.paged);
    // Only a page this process delivered is this process's to recover.
    if (next.paged === undefined) mine.delete(userId);
    else mine.add(userId);
  }

  async function tell(userId: string, baseline: boolean): Promise<void> {
    const user = getUserById(app.db, userId);
    const url = notifyUrlOf(app.db, userId);
    if (user === undefined || url === undefined) {
      seen.delete(userId);
      return;
    }
    // What asks them; for an admin, who joined (`actions/accounts.ts`); and
    // a milestone they watch that landed (`core/watches.ts`), which links
    // to itself.
    const asks: { line: string; items: readonly string[]; link?: string }[] = [
      ...askLinesFor(app.db, user).map((a) => ({ line: a.line, items: a.items })),
      ...newAccountLines(app.db, user, now()),
      ...landedLines(app.db, user, now()),
      ...mailCeilingLines(app, user, now()),
      ...drillLines(app, user, now()),
      ...domainDrillLines(app, user, now(), options.forgeUrl),
      ...mirrorLines(app, user, now()),
      ...redLines(app, user, now()),
      ...alarmLines(app, user, now(), options.alarms?.()),
      ...clogLines(app, user),
      ...onboardedLines(app.db, user, now()),
      ...blockedLines(app, user, now()),
    ];
    const before = seen.get(userId);
    // What is gone may ask again later, and then it is new again. Seen by
    // the asks a row holds, so a new one under a collapsed row is still news.
    seen.set(userId, new Set(asks.flatMap((a) => a.items)));
    if (before === undefined && !baseline) baseline = true;
    if (baseline) return;
    for (const ask of asks) {
      if (ask.items.every((id) => before!.has(id))) continue;
      const t = now();
      const recent = (sent.get(userId) ?? []).filter((s) => t - s < HOUR_MS);
      sent.set(userId, recent);
      if (recent.length >= HOURLY) return;
      if (t < (pause.get(userId)?.until ?? 0)) return;
      recent.push(t);
      let delivered = false;
      try {
        const to =
          ask.link === undefined
            ? link
            : new URL(ask.link, options.forgeUrl).toString();
        delivered = await send(url, `${oneLine(ask.line)}\n${to}`, {
          click: to,
          title: "forge",
        });
      } catch {
        delivered = false;
      }
      if (!delivered) {
        const next = Math.min(
          pause.get(userId)?.next ?? BACKOFF_FIRST_MS,
          BACKOFF_MAX_MS,
        );
        pause.set(userId, { until: now() + next, next: next * 2 });
        // The host only: the path is the secret.
        app.log.warn("notify endpoint failed; pausing", {
          host: notifyHost(url) ?? "",
          pauseMs: next,
        });
        return;
      }
      pause.delete(userId);
    }
  }

  const unsubscribe = app.bus.subscribe((event) => {
    // A run or pull moved: a new app's notice is judged afresh (`apps/onboarding.ts`).
    if (event.repoId !== null && /^(run|pull)\.|^app\.serving$/.test(event.kind)) forgetOnboarding(app.db, event.repoId);
    if (stopped || !WAKES.has(event.kind)) return;
    const own =
      event.kind === "account.notify_set" ? event.actorId : undefined;
    // Off the appender's stack, and one at a time: a slow endpoint holds up
    // only the notifier's own queue.
    queue = queue.then(async () => {
      try {
        if (own !== null && own !== undefined) await tell(own, true);
        else for (const id of people()) await tell(id, false);
      } catch (error) {
        app.log.error("notify failed", { error: String(error) });
      }
    });
  });

  // A forge that was down has told what it told: start from what asks now.
  queue = queue.then(async () => {
    for (const id of people()) {
      await tell(id, true).catch(() => undefined);
      await page(id, true).catch(() => undefined);
    }
    await pageRollback().catch(() => undefined);
  });

  // Eight days of silence is no event: the clock wakes the notifier too.
  const clock = setInterval(() => {
    queue = queue.then(() => during("notify", async () => {
      try {
        for (const id of people()) await tell(id, false);
      } catch (error) {
        app.log.error("notify failed", { error: String(error) });
      }
    }));
  }, options.clockMs ?? CLOCK_MS);
  clock.unref();

  // A drain is paged within a minute of its fifth, not within ten.
  const pageAll = (): Promise<void> => {
    queue = queue.then(async () => {
      try {
        for (const id of people()) await page(id, false);
        await pageRollback();
      } catch (error) {
        app.log.error("notify failed", { error: String(error) });
      }
    });
    return queue;
  };
  const pager = setInterval(
    () => void during("notify-page", pageAll),
    Math.min(options.clockMs ?? CLOCK_MS, PAGE_MS),
  );
  pager.unref();

  return {
    settled: () => queue,
    tick: pageAll,
    stop() {
      stopped = true;
      clearInterval(clock);
      unsubscribe();
    },
    async close() {
      this.stop();
      clearInterval(pager);
      await queue;
      // The process that paged is the one whose exit ends the drain: it says
      // Recovered itself, once, however the release was ordered. A process
      // that dies without closing says nothing.
      for (const userId of [...mine]) {
        const url = notifyUrlOf(app.db, userId);
        if (url === undefined) continue;
        try {
          if (await send(url, `${RECOVERED}\n${link}`, { click: link, title: "forge" }))
            mine.delete(userId);
        } catch {
          // a dead endpoint costs nothing more at exit
        }
      }
    },
  };
}
