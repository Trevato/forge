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

import { newAccountLines } from "../actions/accounts.ts";
import { mailCeilingLines } from "../actions/mail.ts";
import type { Database } from "bun:sqlite";
import { lookup } from "node:dns/promises";
import type { App } from "../app.ts";
import { isPrivateHost } from "../actions/migrate.ts";
import { getUserSetting, setUserSetting } from "../core/settings.ts";
import { getUserById, type User } from "../core/users.ts";
import { landedLines } from "../core/watches.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { lastMirror, mirrorNeed } from "../snapshot/mirror.ts";
import { drillNeed, firstSeen, lastVerdict } from "../snapshot/verdict.ts";
import { askLinesFor } from "../web/studio/asks.ts";

const KEY = "notify_url";
export const MAX_URL = 200;
const HOURLY = 10;
const HOUR_MS = 3_600_000;
const CLOCK_MS = 10 * 60_000;
const SEND_TIMEOUT_MS = 5_000;
const BACKOFF_FIRST_MS = 60_000;
const BACKOFF_MAX_MS = HOUR_MS;

/** Events after which the set of asks may have changed. */
const WAKES = new Set([
  "run.finished",
  "pull.opened",
  "pull.pushed",
  "pull.reviewed",
  "pull.merged",
  "issue.closed",
  "issue.commented",
  "repo.settings_updated",
  "account.notify_set",
  "user.created",
  "mail.ceiling",
  "drill.finished",
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

/** The real sender: the name is resolved and judged first, no redirect is followed. */
const post: Sender = async (url, body, headers) => {
  const host = new URL(url).hostname;
  const found = await lookup(host, { all: true });
  if (found.length === 0 || found.some((a) => isPrivateHost(a.address)))
    return false;
  const res = await fetch(url, {
    method: "POST",
    body,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
    redirect: "manual",
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  return res.status >= 200 && res.status < 300;
};

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

export interface Notifier {
  /** Resolves when the work queued so far is done. For tests and shutdown. */
  settled(): Promise<void>;
  stop(): void;
}

export interface NotifyOptions {
  /** The forge's public address; the link goes to its asks screen. */
  forgeUrl: string;
  send?: Sender;
  now?: () => number;
  /** How often the clock wakes the notifier; ten minutes unless a test says. */
  clockMs?: number;
}

const oneLine = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 160);

export function startNotifier(app: App, options: NotifyOptions): Notifier {
  const send = options.send ?? post;
  const now = options.now ?? Date.now;
  const link = new URL("/", options.forgeUrl).toString();
  /** Per person: the asks last seen, and so already told or deliberately skipped. */
  const seen = new Map<string, Set<string>>();
  const sent = new Map<string, number[]>();
  const pause = new Map<string, { until: number; next: number }>();
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
      ...mirrorLines(app, user, now()),
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
    for (const id of people()) await tell(id, true).catch(() => undefined);
  });

  // Eight days of silence is no event: the clock wakes the notifier too.
  const clock = setInterval(() => {
    queue = queue.then(async () => {
      try {
        for (const id of people()) await tell(id, false);
      } catch (error) {
        app.log.error("notify failed", { error: String(error) });
      }
    });
  }, options.clockMs ?? CLOCK_MS);
  clock.unref();

  return {
    settled: () => queue,
    stop() {
      stopped = true;
      clearInterval(clock);
      unsubscribe();
    },
  };
}
