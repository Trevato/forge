/**
 * The start call (#10912): an agent holding only the forge's URL gets an
 * account, a public repository from the app template and its app, and a
 * token for that account, in one call. No person and no crew are in it.
 *
 * The door is open to strangers, so its limits are mechanical:
 *
 * - **The setting.** `agent_start` (`settings/agent_start.ts`): open, a
 *   code (an open invite link's token, spent with the account), or off.
 * - **Capped.** A few starts per source per hour, ten per source per day, and
 *   a few hundred a day for the whole forge, counted from the rows the starts
 *   left, so a restart forgets nothing. The counts and the insert are one
 *   transaction, so concurrent calls cannot overshoot. One source cannot take
 *   more than `PER_SOURCE_PER_DAY / PER_DAY` of the day; a forge that sees
 *   abuse from many addresses sets `agent_start` to a code or off.
 * - **Held small.** The account stays a guest (no crew, no credits), its
 *   app runs small with no host but the package registries, and it sleeps
 *   after a week unclaimed and is archived, never deleted, after a month
 *   (`core/starts.ts`, `sweepStarts`).
 * - **Shown.** The app is public under the agent's name.
 *
 * The token is returned once; the claim link is returned once and kept as a
 * hash (`actions/claim.ts` is what opens it).
 */
import type { App } from "../app.ts";
import { appsRuntime } from "../apps/runtime.ts";
import { createToken } from "../core/tokens.ts";
import { createUser, discardFreshUser } from "../core/users.ts";
import { inviteOpen, redeemInvite } from "../core/invites.ts";
import { ARCHIVE_DAYS, SLEEP_DAYS, recordStart, startsSince } from "../core/starts.ts";
import { secret } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { getAgentStart } from "../settings/agent_start.ts";
import { noEmail } from "./users.ts";
import { newApp } from "./apps.ts";

export const PER_SOURCE_PER_HOUR = 3;
export const PER_SOURCE_PER_DAY = 10;
export const PER_DAY = 2_000;
export const NAME_MAX = 40;
export const DESCRIPTION_MAX = 2000;
export const AGENT_MAX = 64;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface StartInput {
  readonly name?: unknown;
  readonly description?: unknown;
  readonly agent?: unknown;
  /** The token of an open invite link, when the forge asks for one. */
  readonly code?: unknown;
}

export type StartError =
  | "off"
  | "code_needed"
  | "invalid_name"
  | "invalid_description"
  | "invalid_agent"
  | "rate_limited"
  | "full"
  | "failed";

export type StartRefusal = { readonly error: StartError; readonly retryAfter?: number };

/** What each refusal says; the shape of the call is in `START_HINT`. */
export const START_WORDS: Readonly<Record<StartError, string>> = {
  off: "Agents cannot start here: the owner turned the start call off. A person can sign in or ask for an invitation.",
  code_needed: "This forge asks for an invite code: send it as `code`.",
  invalid_name: `name is 1-${NAME_MAX} characters with a letter or digit in it`,
  invalid_description: `description is plain text of at most ${DESCRIPTION_MAX} characters`,
  invalid_agent: `agent is a name of at most ${AGENT_MAX} letters, digits, . _ -`,
  rate_limited: "Too many starts from here; wait and send again.",
  full: "This forge has started its share of agents for today; try again tomorrow.",
  failed: "The start could not be finished; nothing was kept. Try again.",
};

export const START_HINT =
  `send JSON {name, description?, agent?}: name 1-${NAME_MAX} characters, description at most ` +
  `${DESCRIPTION_MAX}, agent your name (letters, digits, . _ -)`;

export interface Started {
  readonly user: { readonly username: string };
  /** Scoped to that account (read and write); shown once. */
  readonly token: string;
  readonly repo: string;
  readonly git: { readonly url: string; readonly push: string };
  readonly app: { readonly url: string | null };
  /** One-time link a person opens to take the account and its repositories. */
  readonly claim: { readonly url: string; readonly sleepsAfterDays: number; readonly archivedAfterDays: number };
}

/** The name as a repository and account name: lowercase letters, digits, dashes. */
export function nameSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28)
    .replace(/-+$/g, "");
}

const hex = (n: number): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");

export async function startBuilding(
  app: App,
  input: StartInput,
  source: string,
  origin: string,
  now: Date = new Date(),
): Promise<Result<Started, StartRefusal>> {
  const refuse = (error: StartError, retryAfter?: number): Result<never, StartRefusal> =>
    err(retryAfter === undefined ? { error } : { error, retryAfter });
  const mode = getAgentStart(app.db);
  if (mode === "off") return refuse("off");
  const code = typeof input.code === "string" ? input.code : "";
  if (mode === "code" && !inviteOpen(app.db, code)) return refuse("code_needed");

  const given = typeof input.name === "string" ? input.name.trim() : "";
  const base = nameSlug(given);
  if (given === "" || given.length > NAME_MAX || base === "") return refuse("invalid_name");
  const description = input.description === undefined ? "" : input.description;
  if (typeof description !== "string" || description.length > DESCRIPTION_MAX || /[\0]/.test(description))
    return refuse("invalid_description");
  const agent = input.agent === undefined ? "" : input.agent;
  if (typeof agent !== "string" || agent.length > AGENT_MAX || !/^[A-Za-z0-9._-]*$/.test(agent))
    return refuse("invalid_agent");

  const capped = (): StartRefusal | undefined => {
    if (startsSince(app.db, new Date(now.getTime() - HOUR_MS), source) >= PER_SOURCE_PER_HOUR)
      return { error: "rate_limited", retryAfter: 3600 };
    if (startsSince(app.db, new Date(now.getTime() - DAY_MS), source) >= PER_SOURCE_PER_DAY)
      return { error: "rate_limited", retryAfter: 3600 };
    if (startsSince(app.db, new Date(now.getTime() - DAY_MS)) >= PER_DAY) return { error: "full" };
    return undefined;
  };
  // Cheap early refusal; the binding count is the one inside the transaction below.
  const early = capped();
  if (early !== undefined) return err(early);

  // The account: a person-shaped one with no password, which only its token signs in.
  let username = `${base}-${hex(2)}`;
  let made = await createUser(app.db, {
    origin: "start",
    username,
    email: noEmail(username),
    displayName: agent === "" ? base : agent,
    trusted: true,
  });
  if (!made.ok && made.error === "username_taken") {
    username = `${base}-${hex(3)}`;
    made = await createUser(app.db, {
      origin: "start",
      username,
      email: noEmail(username),
      displayName: agent === "" ? base : agent,
      trusted: true,
    });
  }
  if (!made.ok) return refuse("failed");
  const user = made.value;
  const undo = (): void => discardFreshUser(app.db, user.id);

  const claimToken = `claim_${secret()}`;
  let refusal: StartRefusal | undefined;
  try {
    app.db.transaction(() => {
      refusal = capped();
      if (refusal !== undefined) throw new Error("capped");
      if (mode === "code" && !redeemInvite(app.db, code, user.id)) throw new Error("code spent");
      recordStart(app.db, user.id, claimToken, source, now);
    })();
  } catch {
    undo();
    if (refusal !== undefined) return err(refusal);
    return refuse(mode === "code" ? "code_needed" : "failed");
  }

  // The repository and its app; a taken app name gets a suffix once.
  let made2 = await newApp(app, user, { name: base, description, visibility: "public" });
  if (!made2.ok && made2.error === "slug_taken")
    made2 = await newApp(app, user, { name: `${base}-${hex(2)}`, description, visibility: "public" });
  if (!made2.ok) {
    undo();
    return refuse("failed");
  }
  const { repo, app: record } = made2.value;
  const token = createToken(app.db, user.id, "start", "rw");
  app.bus.append({ kind: "start.made", repoId: repo.id, actorId: user.id, payload: {} });
  const url = `${origin}/${user.username}/${repo.name}.git`;
  return ok({
    user: { username: user.username },
    token: token.token,
    repo: `${user.username}/${repo.name}`,
    git: { url, push: `git push ${url.replace("://", `://${user.username}:${token.token}@`)} HEAD:main` },
    app: { url: appsRuntime(app)?.urlFor(record, "production") ?? null },
    claim: { url: `${origin}/claim/start/${claimToken}`, sleepsAfterDays: SLEEP_DAYS, archivedAfterDays: ARCHIVE_DAYS },
  });
}

