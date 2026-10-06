/**
 * A repository's activity as an Atom feed: `GET /:owner/:name/activity.atom`.
 *
 * A feed reader is a system people already use, and Atom is the standard it
 * speaks, so following a repository — or a friend's fork of yours — needs no
 * account and no client of the forge's own.
 *
 * What goes in is a short list of kinds, not "whatever the outbox holds":
 * pushes, issues and pulls opening, closing and merging, and — on a fork's
 * own feed, where that event lives — that it was forked, and from what. Each
 * entry is a sentence built from facts that are already on the repository's
 * public pages — who, what, which issue by its title — and never a raw
 * payload, so a new kind of event cannot leak into a feed by existing. A
 * private repository's feed is for its readers, like its pages.
 */

import { eventActor, eventVerb } from "../design/activity.ts";
import { audienceFilter } from "../core/event_audience.ts";
import { listEvents, type ForgeEvent } from "../core/events.ts";
import { getIssuesByRef } from "../core/issues.ts";
import { canRead, forkParentFor, getRepo } from "../core/repos.ts";
import { getUsersByIds } from "../core/users.ts";
import type { Ctx } from "../http/context.ts";
import { notFound } from "../http/respond.ts";

const FEED_KINDS = new Set([
  "push",
  "issue.opened",
  "issue.closed",
  "issue.reopened",
  "pull.opened",
  "pull.merged",
  "pull.closed",
  "pull.reopened",
  "repo.forked",
]);
const FEED_ENTRIES = 40;

export function xml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === "<"
      ? "&lt;"
      : c === ">"
        ? "&gt;"
        : c === "&"
          ? "&amp;"
          : c === "'"
            ? "&apos;"
            : "&quot;",
  );
}

/** RFC 3339, which Atom requires; the outbox already stores it. */
const stamp = (iso: string): string =>
  /Z$|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`;

/** The branch a push moved, from the one payload field a push always has. */
function pushedBranch(event: ForgeEvent): string {
  const updates = event.payload["updates"];
  const ref = Array.isArray(updates)
    ? (updates[0] as { ref?: unknown } | undefined)?.ref
    : undefined;
  return typeof ref === "string" ? ref.replace(/^refs\/heads\//, "") : "";
}

export function activityAtom(ctx: Ctx): Response {
  const repo = getRepo(ctx.app.db, ctx.params["owner"]!, ctx.params["name"]!);
  if (!repo || !canRead(ctx.app.db, repo, ctx.auth.user)) return notFound();
  const origin = ctx.url.origin;
  const base = `${origin}/${repo.ownerName}/${repo.name}`;
  const events = listEvents(ctx.app.db, { repoId: repo.id, limit: 200 })
    .filter((e) => FEED_KINDS.has(e.kind))
    .filter(audienceFilter(ctx.app.db, ctx.auth.user))
    .slice(0, FEED_ENTRIES);
  const actors = getUsersByIds(
    ctx.app.db,
    events.map((e) => e.actorId ?? "").filter(Boolean),
  );
  const issues = getIssuesByRef(
    ctx.app.db,
    events
      .map((e) => e.payload["number"])
      .filter((n): n is number => typeof n === "number")
      .map((number) => ({ repoId: repo.id, number })),
  );

  const entries = events.map((event) => {
    const who = eventActor(
      event,
      event.actorId === null ? undefined : actors.get(event.actorId)?.username,
    );
    const number = event.payload["number"];
    const issue =
      typeof number === "number"
        ? issues.get(`${repo.id}#${number}`)
        : undefined;
    const isPull = event.kind.startsWith("pull.");
    const subject =
      typeof number === "number"
        ? `#${number}${issue === undefined ? "" : ` ${issue.title}`}`
        : event.kind === "push"
          ? pushedBranch(event)
          : event.kind === "repo.forked" &&
              typeof event.payload["parent"] === "string" &&
              // A parent the reader may no longer read is not named.
              forkParentFor(ctx.app.db, repo, ctx.auth.user) !== undefined
            ? event.payload["parent"]
            : "";
    const link =
      typeof number === "number"
        ? `${base}/${isPull ? "pulls" : "issues"}/${number}`
        : event.kind === "push"
          ? `${base}/commits`
          : base;
    const title = `${who} ${eventVerb(event)}${subject === "" ? "" : `: ${subject}`}`;
    return `  <entry>
    <id>urn:forge:event:${xml(event.id)}</id>
    <title>${xml(title)}</title>
    <updated>${xml(stamp(event.createdAt))}</updated>
    <author><name>${xml(who)}</name></author>
    <link rel="alternate" type="text/html" href="${xml(link)}"/>
  </entry>`;
  });

  const updated = events[0]?.createdAt ?? new Date(0).toISOString();
  const body = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${xml(base)}/activity.atom</id>
  <title>${xml(`${repo.ownerName}/${repo.name}`)}</title>
  <subtitle>${xml(repo.description === "" ? "Activity" : repo.description)}</subtitle>
  <updated>${xml(stamp(updated))}</updated>
  <link rel="self" type="application/atom+xml" href="${xml(base)}/activity.atom"/>
  <link rel="alternate" type="text/html" href="${xml(base)}"/>
  <generator>forge</generator>
${entries.join("\n")}
</feed>
`;
  return new Response(body, {
    headers: {
      "content-type": "application/atom+xml; charset=utf-8",
      // A public feed may be cached briefly by anyone; a private one by
      // nobody but the reader who asked.
      "cache-control":
        repo.visibility === "public"
          ? "public, max-age=300"
          : "private, no-store",
    },
  });
}
