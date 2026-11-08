import { mayView } from "../../core/sealed.ts";
import { getIssue, LIST_LIMIT_MAX } from "../../core/issues.ts";
import { canRead, canWrite, getRepo, type Repo } from "../../core/repos.ts";
import { scopeAllows } from "../../core/tokens.ts";
import { getUserByName, type User } from "../../core/users.ts";
import { applyFleetIds, previewFleetIds } from "../../actions/fleet.ts";
import { KIND_CHIPS, parseChipArgs } from "../../core/feed_chips.ts";
import type { Ctx } from "../context.ts";
import type { BoardError } from "../../actions/boards.ts";
import { BOARD_NOT_SAVED } from "../../actions/board_words.ts";
import { askedFor, fence, fenceTag, fenceUp, hold, named, readFenced } from "../../core/fence.ts";
import { appendTurn, conversationOfVia, proposalBefore } from "../../core/conversations.ts";
import { writesThisTurn } from "../../core/conversation_writes.ts";
import { asksFirst, confirmSentence, tooBigToApprove, undoableWork } from "../../crew/conversation_confirm.ts";

export type Args = Record<string, unknown>;
export type Answer =
  | { ok: true; value: unknown; card?: Record<string, unknown> }
  | { ok: false; error: string; message: string };

export const good = (value: unknown): Answer => ({ ok: true, value });
export const attachWords = (error: string): string =>
  ({
    forbidden: "attaching a look is for a person who can write this app",
    not_open: "only an open pull takes a look",
    no_app: "this repository has no app, so its pulls have no looks",
    bad_width: "width is phone or desktop",
    bad_note: "say what it shows in one line, at most 200 characters (says)",
    bad_image: "image must be a PNG or JPEG, base64, that reads",
    too_large: "the picture is over 5 MB",
  })[error] ?? "refused";

/** What an SSH key refusal says, on MCP and in the terminal. */
export const keyWords = (error: string): string =>
  ({
    invalid_key: "not a public key in authorized_keys form",
    key_exists: "that key is already registered",
    not_found: "no such key of yours",
    invalid_name: "a name is 1 to 64 printable characters",
  })[error] ?? error;

export const bad = (error: string, message: string): Answer => ({
  ok: false,
  error,
  message,
});

/** The refusal for a `limit` that is not a whole number from 1 to LIST_LIMIT_MAX, as the HTTP list routes say it; undefined when it is absent or fine. */
export const badLimit = (limit: unknown): Answer | undefined =>
  limit === undefined ||
  (typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= LIST_LIMIT_MAX)
    ? undefined
    : bad("invalid_limit", `limit is a whole number from 1 to ${LIST_LIMIT_MAX}`);

export interface Tool {
  readonly name: string;
  /** Its line in /llms.txt's `## MCP tools`: markdown, one line; absent, the line reads `description`. */
  readonly doc?: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** Whether it changes anything: `rw` scope, and said so to the client. */
  readonly writes: boolean;
  /** Listed, and callable, for a forge admin only. */
  readonly adminOnly?: true;
  /** Listed, and callable, only with a token of this scope. */
  readonly needsAdminScope?: true;
  /** With this argument (or all of these) absent the tool only reads, whatever the token. */
  readonly readsWithout?: string | readonly string[];
  /** A call this accepts only reads, whatever the token. */
  readonly readsWhen?: (args: Args) => boolean;
  /** A write that only plans (`dryRun` not false) is a read: `ro` may ask. */
  readonly dryByDefault?: true;
  run(ctx: Ctx, user: User, args: Args): Promise<Answer> | Answer;
}

/** Whether this caller is shown the tool and may call it: one rule for the manifest and dispatch. */
export const visible = (tool: Tool, ctx: Ctx, user: User): boolean =>
  (tool.adminOnly !== true || user.isAdmin) &&
  (tool.needsAdminScope !== true || scopeAllows(ctx.auth.scope ?? "ro", "admin"));

/** Whether this call only plans or reads, so a read-only token may make it. */
export const plansOnly = (tool: Tool, args: Args): boolean =>
  (tool.dryByDefault === true && args["dryRun"] !== false) ||
  (tool.readsWithout !== undefined && [tool.readsWithout].flat().every((k) => args[k] === undefined)) ||
  tool.readsWhen?.(args) === true;

/** What a held write tells the forge's agent, beside the confirm's id. */
export const NEEDS_CONFIRM =
  "this write follows text read as data and the person's newest words do not ask for it, so nothing was done. With an id in `needs_confirm`, Confirm and Cancel buttons are already in the thread: say in one sentence what it would do and point at them. With null nothing was kept: say so, and do not call it held";

/** Most undoable writes one ask lets go after fenced text; past it each is held, so a steered agent cannot run on a yes. */
export const ASKED_WRITES_MAX = 8;

/** The confirm a held call draws in the person's thread, with its buttons; its sentence. */
function drawConfirm(ctx: Ctx, user: User, via: string, confirm: string, tool: string, args: Args): string {
  const does = confirmSentence(tool, args);
  const conversation = conversationOfVia(ctx.app.db, user.id, via);
  appendTurn(ctx.app.db, user.id, conversation.id, {
    role: "confirm",
    text: JSON.stringify({ confirm, tool, does }),
  });
  return does;
}

/**
 * Undoable work in a repository the person may write, that their newest
 * words ask for or answer yes to (#9401): nothing to hold.
 */
function askedWork(ctx: Ctx, user: User, via: string, tool: Tool, args: Args, words: string): boolean {
  const work = undoableWork(tool.name, args);
  if (work === undefined) return false;
  const [owner, name, ...rest] = str(args["repo"]).split("/");
  const repo = owner && name && rest.length === 0 ? getRepo(ctx.app.db, owner, name) : undefined;
  if (repo === undefined || !canWrite(ctx.app.db, repo, user)) return false;
  if (writesThisTurn(ctx.app.db, via) >= ASKED_WRITES_MAX) return false;
  return askedFor(words, proposalBefore(ctx.app.db, user.id, via, words), work, args, user.username);
}

/**
 * The fence's hold (#7649): for the forge's own agent (a via token), a write
 * after a read of fenced text that the person's newest words neither name
 * nor ask for is kept as a confirm, drawn in their thread with its buttons,
 * and not done. Undefined: go ahead.
 */
export function heldWrite(ctx: Ctx, user: User, tool: Tool, args: Args): Record<string, unknown> | undefined {
  const via = ctx.auth.through;
  if (via === undefined || !tool.writes || plansOnly(tool, args)) return undefined;
  // An admin-only tool stays unknown to a person who is not one.
  if (tool.adminOnly === true && !user.isAdmin) return undefined;
  const words = fenceUp(ctx.app.db, via);
  if (words === undefined || named(words, tool.name, args) || askedWork(ctx, user, via, tool, args, words)) return undefined;
  if (tooBigToApprove(args)) return tooBig(tool.name);
  // Past the cap nothing more is kept, and the agent is told the same.
  const confirm = hold(ctx.app.db, via, user.id, tool.name, args);
  const does = confirm === null ? {} : { does: drawConfirm(ctx, user, via, confirm, tool.name, args) };
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ needs_confirm: confirm, tool: tool.name, ...does, says: NEEDS_CONFIRM }),
      },
    ],
    isError: true,
  };
}

/**
 * A write the cut turn already sent, as the resumed agent reads it: nothing
 * is done again, and what was answered (or that it never ended) is said.
 */
export function alreadyDone(tool: string, result: string | null): Record<string, unknown> {
  const says =
    result === null
      ? "this write was started before the forge restarted and its end was not recorded, so it was not done again: read to see whether it happened, and send it again only if it did not"
      : "this write was already done before the forge restarted, so it was not done again; its answer then is in `was`";
  return {
    content: [{ type: "text", text: JSON.stringify({ already_done: true, tool, says, ...(result === null ? {} : { was: result }) }) }],
  };
}

/** A call whose arguments a person could not read whole is refused, not kept. */
const tooBig = (tool: string): Record<string, unknown> => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({ needs_confirm: null, tool, says: "the arguments are too large for the person to read before saying yes; nothing was kept or done: ask for less, in smaller calls" }),
    },
  ],
  isError: true,
});

/** What an asked-first call tells the forge's agent, beside the confirm's id and its sentence. */
export const ASKS_FIRST =
  "this action asks the person first, so nothing was done: Confirm and Cancel buttons are already in the thread; say the sentence in `does` to them and point at the buttons; their yes, within 10 minutes, does it once";

/**
 * Asked first (#7650): for the forge's own agent, a call of a tool on the
 * list in `crew/conversation_confirm.ts` — and any call of an admin-scope
 * tool its rw token cannot reach, when the person is an admin — is kept as a
 * confirm with one sentence of what it will do, written to the person's
 * conversation as a `confirm` turn, and not done. Undefined: go on.
 */
export function askedFirst(ctx: Ctx, user: User, tool: Tool, args: Args): Record<string, unknown> | undefined {
  const via = ctx.auth.through;
  if (via === undefined) return undefined;
  // What the person may not do stays unknown to their agent.
  if ((tool.adminOnly === true || tool.needsAdminScope === true) && !user.isAdmin) return undefined;
  const short = tool.needsAdminScope === true && !scopeAllows(ctx.auth.scope ?? "ro", "admin");
  if (!short && (!tool.writes || plansOnly(tool, args) || !asksFirst(tool.name, args))) return undefined;
  if (tooBigToApprove(args)) return tooBig(tool.name);
  const confirm = hold(ctx.app.db, via, user.id, tool.name, args);
  const does = confirm === null ? "" : drawConfirm(ctx, user, via, confirm, tool.name, args);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          confirm === null
            ? { needs_confirm: null, tool: tool.name, says: "too many confirms are waiting in this conversation; nothing was kept" }
            : { needs_confirm: confirm, tool: tool.name, does, says: ASKS_FIRST },
        ),
      },
    ],
    isError: true,
  };
}

/**
 * The forge's own agent is about to read an answer (#8230): the read is
 * marked at dispatch, before the tool runs, so every later write is weighed
 * against it — whatever the answer turns out to hold (a bare key, an
 * object's key, a thrown error), and however the agent batched its calls.
 * Any other caller is not marked.
 */
export function readThrough(ctx: Ctx): void {
  if (ctx.auth.through !== undefined) readFenced(ctx.app.db, ctx.auth.through);
}

/**
 * An answer as the forge's own agent reads it: every string the forge did
 * not make inside a data block — a refusal's message too, which may echo a
 * name someone else chose. Any other caller's answer is returned as it was.
 */
export function fenceAnswer(ctx: Ctx, answer: Answer): Answer {
  if (ctx.auth.through === undefined) return answer;
  const wrapped = fence(answer.ok ? answer.value : answer.message, fenceTag(), ctx.url.origin);
  if (!wrapped.fenced) return answer;
  return answer.ok ? { ...answer, value: wrapped.value } : { ...answer, message: wrapped.value as string };
}

export const CHIP_ARGS = {
  hide_kinds: {
    type: "array",
    items: { type: "string", enum: [...KIND_CHIPS] },
    maxItems: 50,
    description: "Kinds to hide.",
  },
  hide_people: {
    type: "array",
    items: { type: "string", maxLength: 39 },
    maxItems: 50,
    description: "Usernames to hide.",
  },
} as const;

/** The filter a call names, or undefined for the viewer's saved one. */
export function chipArgs(ctx: Ctx, args: Record<string, unknown>) {
  return parseChipArgs(args, (name) => {
    const who = getUserByName(ctx.app.db, name.trim());
    return who && who.kind !== "org" ? who.id : undefined;
  });
}

export const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export const REPO_ARG = { type: "string" } as const;

/** A repository the caller may read, by `owner/name`; a wrong one is answered with that form. */
export function repoArg(ctx: Ctx, user: User, args: Args): Repo | Answer {
  const [owner, name, ...rest] = str(args["repo"]).split("/");
  const repo =
    owner && name && rest.length === 0
      ? getRepo(ctx.app.db, owner, name)
      : undefined;
  // One answer for "no such repository" and "not yours to see".
  return repo !== undefined && canRead(ctx.app.db, repo, user)
    ? repo
    : bad("not_found", "no such app or repository (owner/name)");
}

export const MAX_ARCHIVE_REPOS = 50;

/** `archive` over `repos`: the fleet's own operation, each row's outcome and the id to undo. */
export async function archiveMany(ctx: Ctx, user: User, args: Args): Promise<Answer> {
  const names = args["repos"];
  if (
    !Array.isArray(names) ||
    names.length === 0 ||
    names.length > MAX_ARCHIVE_REPOS ||
    names.some((n) => typeof n !== "string")
  )
    return bad("invalid", `\`repos\` is one to ${MAX_ARCHIVE_REPOS} names, owner/name each`);
  if (args["repo"] !== undefined)
    return bad("invalid", "give `repo` or `repos`, not both");
  if (args["archived"] !== undefined && typeof args["archived"] !== "boolean")
    return bad("invalid", "`archived` is true or false");
  const archived = args["archived"] ?? true;
  const dryRun = args["dryRun"] !== false;
  if (user.kind === "agent")
    return bad("forbidden", "archiving or waking is a person's call, not an agent's");
  if (!dryRun && !scopeAllows(ctx.auth.scope ?? "ro", "admin"))
    return bad("forbidden", "archiving or waking needs an admin token");
  const ids: string[] = [];
  const missing: string[] = [];
  for (const name of new Set(names as string[])) {
    const repo = repoArg(ctx, user, { repo: name });
    if (isAnswer(repo)) missing.push(name);
    else ids.push(repo.id);
  }
  const query = `mcp: ${ids.length + missing.length} named`;
  const action = { verb: "archive", value: archived };
  const unknown = missing.map((repo) => ({
    repo,
    outcome: "refused",
    reason: "no such app or repository (owner/name)",
  }));
  const rowsOf = (rows: readonly { label: string; outcome: string; reason: string }[]) => [
    ...rows.map((r) => ({ repo: r.label, outcome: r.outcome, reason: r.reason })),
    ...unknown,
  ];
  if (dryRun) {
    const plan = previewFleetIds(ctx.app, user, "repo", ids, query, action);
    if (!plan.ok) return bad(plan.error.code, plan.error.message);
    return good({
      dryRun: true,
      archived,
      rows: rowsOf(plan.value.rows),
      says: "This is the plan; nothing changed. Send dryRun: false to do it.",
    });
  }
  const op = await applyFleetIds(ctx.app, user, "repo", ids, query, action);
  if (!op.ok) return bad(op.error.code, op.error.message);
  return good({
    dryRun: false,
    archived,
    operation: op.value.id,
    rows: rowsOf(op.value.rows),
    says: `Done. The \`limb\` tool with action undo and operation ${op.value.id} reverts it for 24 hours.`,
  });
}

// tools/list is held under 40 KB (test/mcp-size.test.ts). The server checks
// every length and count at the boundary, so the listing leaves those hints out.
const LENGTH_HINTS = new Set(["maxLength", "minLength", "maxItems", "minItems"]);
export function lean(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(lean);
  if (schema === null || typeof schema !== "object") return schema;
  return Object.fromEntries(
    Object.entries(schema).filter(([k]) => !LENGTH_HINTS.has(k)).map(([k, v]) => [k, lean(v)]),
  );
}

export const APP_ARG = { type: "string" } as const;

// A child's claim link is a live secret: whoever holds it takes the child.
// It stays out of an agent's conversation unless asked for there on purpose
// (#839); a person admin of this forge gets a fresh one on /forges, in their
// own browser, and hands it over.
export const REVEAL_ARG = {
  type: "boolean",
  description:
    "true: show the secret link.",
} as const;
export const LINK_KEPT =
  "The claim link is a secret, so it is not in this conversation: a person admin of this forge gets a fresh one on /forges (Send a fresh link) and hands it to the child's person. Send reveal: true only to have it here on purpose.";
export const LINK_REVEALED =
  "claimUrl is a live secret, now in this conversation: whoever holds it takes the child. Hand it only to the child's person; the secret is in its #fragment, so send it whole.";

/** The app a plan tool names, under `app`, read like any repository. */
export const planRepo = (ctx: Ctx, user: User, args: Args): Repo | Answer =>
  repoArg(ctx, user, { repo: args["app"] });

/** The issue a plan tool names by number, in that repository. */
export function issueArg(ctx: Ctx, repo: Repo, args: Args, key: string) {
  const n = args[key];
  const issue =
    typeof n === "number" && Number.isInteger(n) && n > 0
      ? getIssue(ctx.app.db, repo.id, n)
      : undefined;
  // A sealed report is not there for anyone who may not see it.
  return issue !== undefined && mayView(ctx.app.db, repo, issue, ctx.auth.user)
    ? issue
    : bad("no_such_issue", `no issue #${String(n)}`);
}

export const isAnswer = (v: Repo | Answer): v is Answer => "ok" in v;

/** Boards are a forge admin's who is a person, as the API gates them: anyone else is forbidden, not told what is there. */
export const boardRefused = (): Answer => bad("forbidden", "boards are for a forge admin who is a person");
export const mayBoards = (user: User): boolean => user.isAdmin && user.kind !== "agent";
export function boardFailed(e: BoardError): Answer {
  if (e === "not_found") return bad("not_found", "no such board");
  if (typeof e === "object") return bad("refused", e.refused);
  return bad(e, BOARD_NOT_SAVED);
}

/** Orders by name's code points, never the machine's locale: the tool list reads the same everywhere. */
export const byName = (a: { readonly name: string }, b: { readonly name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
