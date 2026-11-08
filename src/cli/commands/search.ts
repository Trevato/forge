import { ForgeApi } from "../api.ts";
import type { Args } from "../args.ts";
import { requireConfig } from "../context.ts";
import { EXIT } from "../exit.ts";
import { printUsage } from "../help.ts";
import { inert, type Out } from "../out.ts";
import { displayWidth, pad, truncate } from "../../tui/term/width.ts";
import type { Command } from "./types.ts";

/** The forge's default and ceiling for `limit` (`src/actions/search.ts`). */
const SEARCH_API_LIMIT = 20;
const SEARCH_API_LIMIT_MAX = 100;

const SEARCH_KINDS = ["code", "issues", "pulls", "repos", "all"] as const;
export type SearchFor = (typeof SEARCH_KINDS)[number];

/**
 * `GET /api/v1/search` from a shell: every hit one line, grouped by kind.
 * The API has no `pulls` kind — its `issues` answers both — so `--kind
 * issues` and `--kind pulls` ask for `issues` at the API's ceiling and
 * keep N of the one kind (`narrowConversations`): asking for N and then
 * filtering would print fewer than N, or none.
 */
async function search(out: Out, args: Args): Promise<number> {
  const words = args.positional.join(" ").trim();
  if (words === "") {
    out.err("forge search: what for? e.g. forge search retry budget");
    printUsage(out);
    return EXIT.usage;
  }
  const kindRaw = args.value("kind");
  const kind = SEARCH_KINDS.find((k) => k === kindRaw);
  if (kindRaw !== undefined && kind === undefined) {
    out.err(`forge search: --kind is one of ${SEARCH_KINDS.join(", ")}`);
    return EXIT.usage;
  }
  const limitRaw = args.value("limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!/^\d+$/.test(limitRaw!) || limit < 1)) {
    out.err("forge search: --limit expects a whole number above 0");
    return EXIT.usage;
  }
  const loaded = await requireConfig(out);
  if (typeof loaded === "number") return loaded;
  const oneConversation = kind === "issues" || kind === "pulls";
  const answer = await new ForgeApi(loaded.url, loaded.token).search(words, {
    ...(kind === undefined ? {} : { kind: oneConversation ? "issues" : kind }),
    ...(oneConversation
      ? { limit: SEARCH_API_LIMIT_MAX }
      : limit === undefined ? {} : { limit }),
  });
  if (!answer.ok) {
    const { message, retryAfter, status } = answer.error;
    const when =
      retryAfter === undefined || new RegExp(`\\b${retryAfter}s\\b`).test(message)
        ? ""
        : ` (retry in ${retryAfter}s)`;
    out.err(`forge search: ${message}${when}`);
    if (status === 429) return EXIT.rateLimited;
    return status === 401 ? EXIT.notConfigured : EXIT.failed;
  }
  const found = oneConversation
    ? narrowConversations(answer.value, kind, limit ?? SEARCH_API_LIMIT)
    : answer.value;
  if (args.flag("json")) {
    out.line(JSON.stringify(found));
    return EXIT.ok;
  }
  const lines = searchLines(found, kind ?? "all", out.width, out);
  if (lines.length === 0) {
    out.line(`Nothing found for "${inert(words)}".`);
    return EXIT.ok;
  }
  for (const line of lines) out.line(line);
  return EXIT.ok;
}

/**
 * The answer with `issues` kept to one kind (`issue` or `pull`) and cut to
 * `limit`; `truncated.issues` is set when the cut dropped any, or when the
 * forge had already cut its own window, so `--json` and the group header
 * both say the list is not whole. Everything else passes through.
 */
export function narrowConversations(
  raw: unknown,
  kind: "issues" | "pulls",
  limit: number,
): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const body = raw as Record<string, unknown>;
  const want = kind === "pulls" ? "pull" : "issue";
  const kept = rowsOf(body["issues"]).filter((r) => r["kind"] === want);
  const truncated = (typeof body["truncated"] === "object" && body["truncated"] !== null
    ? body["truncated"]
    : {}) as Record<string, unknown>;
  return {
    ...body,
    issues: kept.slice(0, limit),
    truncated: { ...truncated, issues: truncated["issues"] === true || kept.length > limit },
  };
}

/**
 * The search answer as lines no wider than `width - 1` where the text can
 * give way: each kind headed by its name and count, then one hit a line —
 * `owner/name:path:line  text` for code, `owner/name#N  title  state` for
 * issues and pulls, `owner/name  description` for repositories. Anything
 * the answer carries that is not the expected shape is skipped, not fatal.
 */
export function searchLines(
  raw: unknown,
  kind: SearchFor,
  width: number,
  out?: Pick<Out, "paint" | "c">,
): string[] {
  const body = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const truncated = (body["truncated"] ?? {}) as Record<string, unknown>;
  const conversations = rowsOf(body["issues"]).map(conversationRow);
  const groups: { kind: SearchFor; rows: [string, string, string][]; more: boolean }[] = [
    { kind: "code", rows: rowsOf(body["code"]).map(codeRow), more: truncated["code"] === true },
    {
      kind: "issues",
      rows: conversations.filter((r) => r[0] === "issue").map((r) => r.slice(1) as [string, string, string]),
      more: truncated["issues"] === true,
    },
    {
      kind: "pulls",
      rows: conversations.filter((r) => r[0] === "pull").map((r) => r.slice(1) as [string, string, string]),
      more: truncated["issues"] === true,
    },
    { kind: "repos", rows: rowsOf(body["repos"]).map(repoRow), more: truncated["repos"] === true },
  ];
  const lines: string[] = [];
  for (const group of groups) {
    const rows = group.rows.filter((r) => r[0] !== "");
    if (rows.length === 0 || (kind !== "all" && kind !== group.kind)) continue;
    if (lines.length > 0) lines.push("");
    const head = `${group.kind} (${rows.length}${group.more ? ", more not shown" : ""})`;
    lines.push(out === undefined ? head : out.paint(head, out.c.accent));
    // Code's place differs in width line to line; the others line up.
    const leadW = group.kind === "code" ? 0 : Math.max(...rows.map((r) => displayWidth(r[0])));
    const tails = rows.some((r) => r[2] !== "");
    const tailW = tails ? Math.max(...rows.map((r) => displayWidth(r[2]))) + 2 : 0;
    const textW = Math.max(...rows.map((r) => displayWidth(r[1])));
    for (const [lead, text, tail] of rows) {
      const first = leadW === 0 ? lead : pad(lead, leadW);
      const room = Math.max(8, width - 1 - displayWidth(first) - 2 - tailW);
      const cut = truncate(text, room);
      const shown = tails ? pad(cut, Math.min(room, textW)) : cut;
      lines.push(
        [
          first,
          shown,
          ...(tail === "" ? [] : [out === undefined ? tail : out.paint(tail, out.c.faint)]),
        ].join("  ").trimEnd(),
      );
    }
    if (group.kind === "code" && (body["moreCode"] === true || body["codeSkipped"] === true)) {
      const note = "  some repositories were not searched in time; --json says which kinds are partial";
      lines.push(out === undefined ? note : out.paint(note, out.c.faint));
    }
  }
  return lines;
}

function rowsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
    : [];
}

/** `owner/name` from a local hit's `repo`, or an origin hit's `fullName`. */
function repoName(r: Record<string, unknown>): string {
  const repo = r["repo"] as Record<string, unknown> | undefined;
  if (typeof repo?.["owner"] === "string" && typeof repo["name"] === "string")
    return `${repo["owner"]}/${repo["name"]}`;
  if (typeof r["owner"] === "string" && typeof r["name"] === "string")
    return `${r["owner"]}/${r["name"]}`;
  return typeof r["fullName"] === "string" ? r["fullName"] : "";
}

function textOf(value: unknown): string {
  return typeof value === "string" ? inert(value) : "";
}

function codeRow(r: Record<string, unknown>): [string, string, string] {
  const name = repoName(r);
  const path = textOf(r["path"]);
  const line = typeof r["line"] === "number" ? r["line"] : 0;
  if (name === "" || path === "") return ["", "", ""];
  return [`${inert(name)}:${path}:${line}`, textOf(r["text"]).trim(), ""];
}

function conversationRow(r: Record<string, unknown>): [string, string, string, string] {
  const name = repoName(r);
  const n = r["number"];
  if (name === "" || typeof n !== "number") return ["", "", "", ""];
  return [textOf(r["kind"]), `${inert(name)}#${n}`, textOf(r["title"]), textOf(r["state"])];
}

function repoRow(r: Record<string, unknown>): [string, string, string] {
  const name = repoName(r);
  return [inert(name), textOf(r["description"]), r["archived"] === true ? "archived" : ""];
}


export const command: Command = {
  name: "search",
  usage: {
    synopsis: "forge search <words…>",
    flags: "[--kind code|issues|pulls|repos|all] [--limit N] [--json]",
  },
  run: search,
};
