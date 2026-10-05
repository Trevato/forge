/**
 * Mail the forge sends is capped by who it goes to, not only by who asks
 * (#784). A verification link is limited per account (`core/verify.ts`),
 * but many accounts could still mail one stranger many times, or mail many
 * strangers. So every message passes two caps, counted in `mail_sent`:
 *
 * - at most `RECIPIENT_DAILY` messages to one address in a day, whatever
 *   account asks;
 * - at most `mailDailyCap` messages from the whole forge in a day
 *   (`FORGE_MAIL_DAILY`, default `FORGE_DAILY`). Past it nothing is sent,
 *   the person waiting is told plainly, and the forge's owner hears once a
 *   day (`mailCeilingLines`, read by the notifier).
 *
 * A place is held before the message goes and released if it fails, so two
 * sends at once cannot both slip past a cap.
 */

import type { App } from "../app.ts";
import {
  holdSend,
  recipientKey,
  releaseSend,
  sentSince,
} from "../core/mail_log.ts";
import type { User } from "../core/users.ts";
import type { Mail, Mailer } from "../kernel/mail.ts";

export const RECIPIENT_DAILY = 3;
export const FORGE_DAILY = 200;
const DAY_MS = 24 * 3_600_000;

/** What a person waiting for mail is told when a cap holds it back. */
export const CAPPED_WORDS =
  "the forge has sent all the mail it may for now; try again tomorrow, or ask the forge's owner to verify you";

const dayCap = (app: App): number => app.config.mailDailyCap ?? FORGE_DAILY;
const since = (now: number): string => new Date(now - DAY_MS).toISOString();

/**
 * Whether a message to `to` may go now, by the caps, without sending. A
 * refusal at the forge-wide ceiling is noted, once a day, for the owner.
 */
export function mayMail(app: App, to: string, now = Date.now()): boolean {
  const from = since(now);
  if (sentSince(app.db, from) >= dayCap(app)) {
    atCeiling(app, now);
    return false;
  }
  return sentSince(app.db, from, recipientKey(to)) < RECIPIENT_DAILY;
}

/** Send through the caps: "sent", "capped" when a cap holds it, "failed" when the mailer did. */
export async function sendCapped(
  app: App,
  mailer: Mailer,
  mail: Mail,
  now = Date.now(),
): Promise<"sent" | "capped" | "failed"> {
  if (!mayMail(app, mail.to, now)) return "capped";
  const held = holdSend(app.db, recipientKey(mail.to), new Date(now).toISOString());
  const delivered = await mailer(mail).catch(() => false);
  if (!delivered) {
    releaseSend(app.db, held);
    return "failed";
  }
  return "sent";
}

/** The first refusal at the ceiling in a day is an event: the notifier wakes for it. */
function atCeiling(app: App, now: number): void {
  const told = app.db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) AS n FROM event WHERE kind = 'mail.ceiling' AND created_at > ?1",
    )
    .get(since(now));
  if ((told?.n ?? 0) > 0) return;
  app.log.warn("the forge reached its daily mail ceiling; mail waits", {
    cap: dayCap(app),
  });
  app.bus.append({ kind: "mail.ceiling", payload: { cap: dayCap(app) } });
}

/**
 * The line an admin's phone hears when the forge is at its mail ceiling:
 * one id per UTC day, so the notifier tells them once (`crew/notify.ts`).
 */
export function mailCeilingLines(
  app: App,
  user: User,
  now = Date.now(),
): { id: string; line: string; items: readonly string[] }[] {
  if (!user.isAdmin || user.kind !== "user") return [];
  if (sentSince(app.db, since(now)) < dayCap(app)) return [];
  const id = `mail-ceiling:${new Date(now).toISOString().slice(0, 10)}`;
  return [
    {
      id,
      line: `The forge sent its ${dayCap(app)} messages for the day; verification links wait until the count eases`,
      items: [id],
    },
  ];
}
