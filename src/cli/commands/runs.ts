import { ForgeApi, type ApiError } from "../api.ts";
import { parseRepoRef, type Args } from "../args.ts";
import { requireConfig } from "../context.ts";
import { EXIT } from "../exit.ts";
import { folderRepo } from "../folder-repo.ts";
import { inert, type Out } from "../out.ts";
import { since } from "../report.ts";
import { displayWidth, pad, truncate } from "../../tui/term/width.ts";
import type { Command } from "./types.ts";

const RUN_ROWS = 10;

/** Colour of a run's state word. */
const RUN_TONE: Record<string, "success" | "danger" | "attn" | "faint"> = {
  ok: "success",
  failed: "danger",
  running: "attn",
  queued: "faint",
  cancelled: "faint",
};

/**
 * One run as a line's parts, from the fields the runs API names (`nameRuns`):
 * `agent` (blank for a check or deploy), `number` and `title` of the pull or
 * issue (blank when it is about none). Nothing is read out of the branch.
 */
export function runParts(run: Record<string, unknown>): {
  state: string;
  agent: string;
  number: string;
  title: string;
  when: string;
  cost: string;
} {
  const text = (v: unknown): string => (typeof v === "string" ? v : "");
  const number = run["number"];
  const stamp = text(run["finishedAt"]) || text(run["startedAt"]) || text(run["createdAt"]);
  const at = Date.parse(stamp);
  const cost = typeof run["costUsd"] === "number" ? run["costUsd"] : 0;
  return {
    state: inert(text(run["state"])),
    agent: inert(text(run["agent"])),
    number: Number.isSafeInteger(number) && (number as number) > 0 ? `#${number}` : "",
    title: inert(text(run["title"]).split("\n")[0] ?? ""),
    when: Number.isNaN(at) ? "" : since(new Date(at)),
    cost: cost > 0 ? `$${cost.toFixed(2)}` : "",
  };
}

async function runs(out: Out, args: Args): Promise<number> {
  const loaded = await requireConfig(out);
  if (typeof loaded === "number") return loaded;
  const flagged = args.value("repo");
  const ref =
    flagged !== undefined
      ? parseRepoRef(flagged)
      : await folderRepo(process.cwd(), loaded.url);
  if (ref === undefined) {
    out.err(
      flagged !== undefined
        ? "forge runs: --repo expects owner/name"
        : `forge runs: this folder is not a clone of ${loaded.url} — run it in a clone, or pass --repo owner/name`,
    );
    return EXIT.usage;
  }
  const got = await new ForgeApi(loaded.url, loaded.token).runs(
    ref.owner,
    ref.name,
    RUN_ROWS,
  );
  if (!got.ok) return runsError(out, got.error);
  const listed: unknown = (got.value as { items?: unknown } | null)?.items;
  if (
    !Array.isArray(listed) ||
    listed.some((r) => typeof r !== "object" || r === null || Array.isArray(r))
  ) {
    out.err("forge runs: unexpected answer");
    return EXIT.failed;
  }
  if (args.flag("json")) {
    out.line(JSON.stringify(got.value));
    return EXIT.ok;
  }
  const rows = (listed as Record<string, unknown>[])
    .slice(0, RUN_ROWS)
    .map((r) => ({ tone: String(r["state"]), ...runParts(r) }));
  if (rows.length === 0) {
    out.line("No runs yet.");
    return EXIT.ok;
  }
  const wide = (pick: (r: (typeof rows)[number]) => string): number =>
    Math.max(...rows.map((r) => displayWidth(pick(r))));
  const sW = wide((r) => r.state);
  const aW = Math.min(16, wide((r) => r.agent));
  const nW = wide((r) => r.number);
  const wW = wide((r) => r.when);
  const cW = wide((r) => r.cost);
  const tW = Math.max(12, out.width - sW - aW - nW - wW - cW - 10);
  for (const r of rows) {
    const key = RUN_TONE[r.tone] ?? "faint";
    out.line(
      [
        out.paint(pad(r.state, sW), out.c[key]),
        pad(truncate(r.agent, aW), aW),
        pad(r.number, nW, "right"),
        pad(truncate(r.title, tW), tW),
        pad(r.when, wW, "right"),
        pad(r.cost, cW, "right"),
      ]
        .join("  ")
        .replace(/\s+$/, ""),
    );
  }
  return EXIT.ok;
}

/** The forge's words, and the exit code its status means. */
function runsError(out: Out, error: ApiError): number {
  out.err(`forge runs: ${inert(error.message)}`);
  return error.status === 401 ? EXIT.notConfigured : EXIT.failed;
}

export const command: Command = {
  name: "runs",
  usage: { synopsis: "forge runs", flags: "[--repo owner/name] [--json]" },
  run: runs,
};
