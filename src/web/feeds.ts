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

import { plainTitle } from "../story/gather.ts";
import { eventActor, eventVerb } from "../design/activity.ts";
import { audienceFilter } from "../core/event_audience.ts";
import { listEvents, type ForgeEvent } from "../core/events.ts";
import { getIssuesByRef } from "../core/issues.ts";
import { canRead, forkParentFor, getRepo } from "../core/repos.ts";
import { getUsersByIds } from "../core/users.ts";
import { shippedAnswer } from "../release/answer.ts";
import { notePhase, takeSessionTime, timePhase, timePhaseAsync } from "../core/route_timing.ts";
import type { Ctx } from "../http/context.ts";
import { notFound } from "../http/respond.ts";
import { STARTED } from "./started.ts";

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

// eslint-disable-next-line no-control-regex
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;

/** Escapes for XML text and attributes; characters XML 1.0 forbids are dropped. */
export function xml(s: string): string {
  return s.replace(NOT_XML, "").replace(/[<>&'"]/g, (c) =>
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
export const stamp = (iso: string): string =>
  /Z$|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`;

/** The branch a push moved, from the one payload field a push always has. */
export function pushedBranch(event: ForgeEvent): string {
  const updates = event.payload["updates"];
  const ref = Array.isArray(updates)
    ? (updates[0] as { ref?: unknown } | undefined)?.ref
    : undefined;
  return typeof ref === "string" ? ref.replace(/^refs\/heads\//, "") : "";
}

/** Does an `If-None-Match` header name this tag (weakly, or as `*`)? */
export function holds(header: string | null, etag: string): boolean {
  if (header === null) return false;
  return header
    .split(",")
    .map((t) => t.trim().replace(/^W\//, ""))
    .some((t) => t === "*" || t === etag.replace(/^W\//, ""));
}

export function activityAtom(ctx: Ctx): Response {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const repo = getRepo(ctx.app.db, ctx.params["owner"]!, ctx.params["name"]!);
  if (!repo || !canRead(ctx.app.db, repo, ctx.auth.user)) return notFound();
  const origin = ctx.url.origin;
  const base = `${origin}/${repo.ownerName}/${repo.name}`;
  const events = timePhase(ctx.request, "events", () =>
    listEvents(ctx.app.db, { repoId: repo.id, limit: 200 })
      .filter((e) => FEED_KINDS.has(e.kind))
      .filter(audienceFilter(ctx.app.db, ctx.auth.user))
      .slice(0, FEED_ENTRIES),
  );
  const { actors, issues } = timePhase(ctx.request, "people", () => ({
    actors: getUsersByIds(
      ctx.app.db,
      events.map((e) => e.actorId ?? "").filter(Boolean),
    ),
    issues: getIssuesByRef(
      ctx.app.db,
      events
        .map((e) => e.payload["number"])
        .filter((n): n is number => typeof n === "number")
        .map((number) => ({ repoId: repo.id, number })),
    ),
  }));
  // The newest event the reader may see, who the reader is (a writer and a
  // stranger see different lists), and the names and titles the body will
  // print, which can change with no event.
  const shown = Bun.hash(
    JSON.stringify([
      repo.ownerName,
      repo.name,
      repo.description,
      [...actors.values()].map((u) => [u.id, u.username]),
      [...issues.values()].map((i) => [i.number, i.title]),
    ]),
  ).toString(36);
  const etag = `W/"${events[0]?.id ?? "none"}.${ctx.auth.user?.id ?? "anon"}.${shown}"`;
  const cacheControl =
    repo.visibility === "public" ? "public, max-age=300" : "private, no-store";
  // The body differs by who asks, so a shared cache must key on them.
  const vary = "authorization, cookie";
  if (holds(ctx.request.headers.get("if-none-match"), etag))
    return new Response(null, {
      status: 304,
      headers: { etag, "cache-control": cacheControl, vary },
    });
  const renderStart = performance.now();

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

  const updated = events[0]?.createdAt ?? STARTED;
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
  notePhase(ctx.request, "render", performance.now() - renderStart);
  return new Response(body, {
    headers: {
      "content-type": "application/atom+xml; charset=utf-8",
      // A public feed may be cached briefly by anyone; a private one by
      // nobody but the reader who asked.
      "cache-control": cacheControl,
      etag,
      vary,
    },
  });
}

const CHANGELOG_ENTRIES = 30;

/**
 * The weak tag of a changelog answer: the live version, the rows' repo,
 * number, title and time, and `scope` (the chosen repo, the viewer when the
 * answer depends on who asks). The Atom feed and the JSON share it, so the
 * two cannot drift; with no scope the tag is the Atom's own, unchanged.
 */
export function changelogTag(
  version: string,
  rows: readonly { repo: string; number: number; title: string; at: string }[],
  scope: readonly unknown[] = [],
): string {
  const key = [version, rows.map((l) => [l.repo, l.number, l.title, l.at]), ...scope];
  return `W/"${Bun.hash(JSON.stringify(key)).toString(36)}"`;
}

/**
 * `GET /changelog.atom`: what went live, as /changelog lists it (the forge's
 * own repository, public pulls only). Landed-but-not-shipped is left out.
 */
export async function changelogAtom(ctx: Ctx): Promise<Response> {
  notePhase(ctx.request, "session", takeSessionTime(ctx.request));
  const answer = await timePhaseAsync(ctx.request, "releases", () => shippedAnswer(ctx.app));
  const origin = ctx.url.origin;
  const live = answer.live.slice(0, CHANGELOG_ENTRIES);
  const etag = changelogTag(answer.version, live);
  const headers = { etag, "cache-control": "public, max-age=300" };
  if (holds(ctx.request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  const entries = live.map((l) => {
    const link = `${origin}/${l.repo}/pulls/${l.number}`;
    return `  <entry>
    <id>urn:forge:landing:${xml(l.repo)}#${l.number}</id>
    <title>${xml(`Went live: ${plainTitle(l.title)}`)}</title>
    <updated>${xml(stamp(l.at))}</updated>
    <link rel="alternate" type="text/html" href="${xml(link)}"/>
  </entry>`;
  });
  const updated = live[0]?.at ?? STARTED;
  const body = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${xml(origin)}/changelog.atom</id>
  <title>Changelog</title>
  <subtitle>What went live</subtitle>
  <author><name>forge</name></author>
  <updated>${xml(stamp(updated))}</updated>
  <link rel="self" type="application/atom+xml" href="${xml(origin)}/changelog.atom"/>
  <link rel="alternate" type="text/html" href="${xml(origin)}/changelog"/>
  <generator>forge</generator>
${entries.join("\n")}
</feed>
`;
  return new Response(body, { headers: { ...headers, "content-type": "application/atom+xml; charset=utf-8" } });
}
