/**
 * The activity feed's one job: turn an outbox row into a sentence.
 *
 * `describeEvent` is pure and takes everything it needs already resolved —
 * the actor's name, the repo it touched, the title of the issue or pull it
 * names. That split is deliberate: the naming rules are the part worth
 * testing, and they must not need a database to exercise.
 */

import type { ForgeEvent } from "../../core/events.ts";

export interface EventSubject {
  /** The actor's username, or a stand-in when the actor is gone. */
  readonly actor: string;
  /** `owner/name` of the repo the event touched, when it has one. */
  readonly repo?: string;
  /** The issue or pull title, when the event names a number. */
  readonly title?: string;
}

export interface FeedLine {
  /** Line one: who did what, in English. */
  readonly headline: string;
  /** Line two: where, and to what. Empty when the headline said it all. */
  readonly detail: string;
  /**
   * Just the object — `#4 Treat 34 knots as gale`. A narrow feed appends this
   * instead of `detail`, because at 36 columns the repo name is the half a
   * reader already knows and the title is the half they do not.
   */
  readonly subject: string;
}

/**
 * Account plumbing is not repo activity. A key rotation or a minted token is
 * a real event with real consumers (webhooks, the audit surface) — it is just
 * not something anyone reads a dashboard to find out.
 */
function isNoise(kind: string): boolean {
  return kind.startsWith("user.") || kind.startsWith("token.");
}

const THING: Record<string, string> = { issue: "issue", pull: "pull" };

function short(repo: string | undefined): string {
  if (repo === undefined) return "a repository";
  const slash = repo.lastIndexOf("/");
  return slash === -1 ? repo : repo.slice(slash + 1);
}

function text(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The branch a push landed on, when it is a single ordinary branch update. */
function pushedRef(payload: Record<string, unknown>): string | undefined {
  const updates = payload["updates"];
  if (!Array.isArray(updates) || updates.length !== 1) return undefined;
  const first: unknown = updates[0];
  if (typeof first !== "object" || first === null) return undefined;
  const ref = (first as { ref?: unknown }).ref;
  if (typeof ref !== "string") return undefined;
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

/**
 * One event as a feed item, or null when it does not belong in a feed.
 * An unrecognised kind still gets a line — a new event type should look
 * unpolished, never invisible.
 */
export function describeEvent(
  event: ForgeEvent,
  subject: EventSubject,
): FeedLine | null {
  if (isNoise(event.kind)) return null;
  const who = subject.actor;
  const payload = event.payload;
  const number = payload["number"];
  const ref = typeof number === "number" ? `#${number}` : "";
  const where = short(subject.repo);

  const object = ref === "" ? "" : `${ref} ${subject.title ?? ""}`.trim();
  // `owner/repo · #4 Treat 34 knots as gale`, minus whichever half is unknown.
  const detail = [subject.repo ?? "", object]
    .filter((part) => part !== "")
    .join(" · ");

  const [concept, verb] = split(event.kind);
  const noun = THING[concept];
  if (noun !== undefined && ref !== "") {
    const phrase =
      verb === "opened"
        ? `opened ${noun} ${ref}`
        : verb === "commented"
          ? `commented on ${noun} ${ref}`
          : verb === "labeled"
            ? `labelled ${noun} ${ref}`
            : verb === "reviewed"
              ? `reviewed ${noun} ${ref}`
              : `${verb} ${noun} ${ref}`;
    return { headline: `${who} ${phrase}`, detail, subject: object };
  }

  switch (event.kind) {
    case "push": {
      const branch = pushedRef(payload);
      return {
        headline:
          branch === undefined
            ? `${who} pushed to ${where}`
            : `${who} pushed to ${where} ${branch}`,
        detail: "",
        subject: "",
      };
    }
    case "repo.created":
      return {
        headline: `${who} created ${where}`,
        detail: "",
        subject: "",
      };
    case "repo.forked":
      return {
        headline: `${who} forked ${text(payload, "parent") ?? "a repository"}`,
        detail: "",
        subject: "",
      };
    case "repo.deleted":
      return {
        headline: `${who} deleted a repository`,
        detail: "",
        subject: "",
      };
    case "repo.settings_updated":
      return {
        headline: `${who} changed ${where} settings`,
        detail: "",
        subject: "",
      };
    case "repo.mirrored":
      return { headline: `${who} mirrored ${where}`, detail: "", subject: "" };
    case "repo.imported":
      return {
        headline: `${who} imported issues and pulls into ${where}`,
        detail: "",
        subject: "",
      };
    case "repo.pinned":
      return { headline: `${who} pinned ${where}`, detail: "", subject: "" };
    case "repo.unpinned":
      return { headline: `${who} unpinned ${where}`, detail: "", subject: "" };
    case "origin.connected":
      return {
        headline: `${who} connected an origin`,
        detail: "",
        subject: "",
      };
    case "origin.disconnected":
      return {
        headline: `${who} disconnected an origin`,
        detail: "",
        subject: "",
      };
    case "label.created":
      return {
        headline: `${who} added label ${quote(text(payload, "name"))} to ${where}`,
        detail: "",
        subject: "",
      };
    case "label.updated":
      return {
        headline: `${who} changed label ${quote(text(payload, "name"))} in ${where}`,
        detail: "",
        subject: "",
      };
    case "label.deleted":
      return {
        headline: `${who} removed a label from ${where}`,
        detail: "",
        subject: "",
      };
    case "webhook.created":
      return {
        headline: `${who} added a webhook to ${where}`,
        detail: "",
        subject: "",
      };
    case "webhook.deleted":
      return {
        headline: `${who} removed a webhook from ${where}`,
        detail: "",
        subject: "",
      };
    case "org.created":
      return {
        headline: `${who} created the org ${text(payload, "org") ?? ""}`.trim(),
        detail: "",
        subject: "",
      };
    case "team.created":
      return {
        headline: `${who} created team ${teamName(payload)}`,
        detail: "",
        subject: "",
      };
    case "team.deleted":
      return {
        headline: `${who} deleted team ${teamName(payload)}`,
        detail: "",
        subject: "",
      };
    case "team.member_added":
      return {
        headline: `${who} added ${text(payload, "user") ?? "someone"} to ${teamName(payload)}`,
        detail: "",
        subject: "",
      };
    case "team.member_removed":
      return {
        headline: `${who} removed ${text(payload, "user") ?? "someone"} from ${teamName(payload)}`,
        detail: "",
        subject: "",
      };
    default:
      return {
        headline: `${who} ${event.kind.replace(/[._]/g, " ")}${ref === "" ? "" : ` ${ref}`}`,
        detail,
        subject: object,
      };
  }
}

function split(kind: string): [string, string] {
  const dot = kind.indexOf(".");
  return dot === -1 ? [kind, ""] : [kind.slice(0, dot), kind.slice(dot + 1)];
}

function quote(name: string | undefined): string {
  return name === undefined ? "a label" : `"${name}"`;
}

function teamName(payload: Record<string, unknown>): string {
  const org = text(payload, "org");
  const name = text(payload, "name") ?? "a team";
  return org === undefined ? name : `${org}/${name}`;
}
