import { ForgeApi, type Ask, type Bulk } from "../api.ts";
import { parseWish, pickAsks, type Wish } from "../decide.ts";
import { askLine, type Io } from "../io.ts";
import { parseRepoRef, type Args } from "../args.ts";
import { requireConfig } from "../context.ts";
import { EXIT } from "../exit.ts";
import { inert, type Out } from "../out.ts";
import { displayWidth, pad, truncate } from "../../tui/term/width.ts";
import type { Command } from "./types.ts";

/**
 * What waits on you, one line each, in the order the forge ranks it: kind,
 * repository, title cut to the terminal, and the address to decide it at.
 */
export async function asks(
  out: Out,
  args: Args,
  argv: readonly string[] = [],
  confirm: Confirm = confirmOn({ ask: askLine }),
): Promise<number> {
  const wish = parseWish(argv);
  if (typeof wish === "string") {
    out.err(`forge asks: ${wish}`);
    return EXIT.usage;
  }
  const only = args.value("repo");
  const ref = only === undefined ? undefined : parseRepoRef(only);
  if (only !== undefined && ref === undefined) {
    out.err("forge asks: --repo expects owner/name");
    return EXIT.usage;
  }
  const loaded = await requireConfig(out);
  if (typeof loaded === "number") return loaded;
  const api = new ForgeApi(loaded.url, loaded.token);
  const answer = await api.asks();
  if (!answer.ok) {
    out.err(`forge asks: ${answer.error.message}`);
    return answer.error.status === 401 ? EXIT.notConfigured : EXIT.failed;
  }
  const repo = ref === undefined ? undefined : `${ref.owner}/${ref.name}`;
  if (wish !== undefined && wish.action === "undo")
    return decide(out, api, wish, [], true, confirm);
  if (wish !== undefined) {
    const rows = answer.value.asks.filter(
      (a) => repo === undefined || a.repo === repo,
    );
    return decide(out, api, wish, rows, args.flag("yes"), confirm);
  }
  if (args.flag("json")) {
    const raw = answer.value.raw;
    out.line(JSON.stringify(repo === undefined ? raw : onlyRepo(raw, repo)));
    return EXIT.ok;
  }
  const rows = answer.value.asks.filter(
    (a) => repo === undefined || a.repo === repo,
  );
  if (rows.length === 0) {
    out.line("Nothing waits on you.");
    return EXIT.ok;
  }
  const numberW = String(rows.length).length;
  const lines = askLines(rows, out.width - numberW - 2, out);
  lines.forEach((line, i) =>
    out.line(`${String(i + 1).padStart(numberW)}  ${line}`),
  );
  return EXIT.ok;
}

/** A y/N from the person at the keyboard, undefined when there is none. */
const confirmOn =
  (io: Io): Confirm =>
  async (question) => {
    const line = await io.ask(question);
    return line === null ? undefined : /^\s*y(es)?\s*$/i.test(line);
  };

/** Whether to go ahead: undefined when there is no one to ask. */
export type Confirm = (question: string) => Promise<boolean | undefined>;

/**
 * Decide asks by the numbers of the list just read: the plan first, then,
 * after a yes (or `--yes`), the deed and the line that undoes it.
 */
async function decide(
  out: Out,
  api: ForgeApi,
  wish: Wish,
  rows: readonly Ask[],
  yes: boolean,
  confirm: Confirm,
): Promise<number> {
  const fail = (e: { message: string; status: number }): number => {
    out.err(`forge asks: ${e.message}`);
    return e.status === 401 ? EXIT.notConfigured : EXIT.failed;
  };
  if (wish.action === "undo") {
    const back = await api.undo(wish.numbers[0]!);
    if (!back.ok) return fail(back.error);
    printBulk(out, back.value, "undo", true);
    return EXIT.ok;
  }
  const ids = pickAsks(wish.numbers, rows);
  if (!Array.isArray(ids)) {
    out.err(`forge asks: ${ids.refused}`);
    return EXIT.usage;
  }
  const plan = await api.bulk(wish.action, ids, wish.reason, true);
  if (!plan.ok) return fail(plan.error);
  printBulk(out, plan.value, wish.action, false);
  const changes = plan.value.rows.filter((r) => r.outcome === "change").length;
  if (changes === 0) {
    out.line("Nothing would change.");
    return EXIT.ok;
  }
  if (!yes) {
    const said = await confirm("Apply? [y/N] ");
    if (said === undefined) {
      out.err("forge asks: not applied — no terminal to ask on; add --yes");
      return EXIT.usage;
    }
    if (!said) {
      out.line("Nothing applied.");
      return EXIT.ok;
    }
  }
  const done = await api.bulk(wish.action, ids, wish.reason, false);
  if (!done.ok) return fail(done.error);
  printBulk(out, done.value, wish.action, true);
  if (done.value.id !== undefined) {
    out.line(`Receipt ${inert(done.value.id)}`);
    out.line(`Undo: forge asks --undo ${inert(done.value.id)}`);
  }
  return EXIT.ok;
}

function printBulk(out: Out, bulk: Bulk, action: string, done: boolean): void {
  out.line(done ? `Applied: ${action}` : `Would ${action}:`);
  for (const r of bulk.rows) {
    const move = r.before === r.after ? "" : `  ${r.before} → ${r.after}`;
    const why = r.reason === "" ? "" : `  (${r.reason})`;
    out.line(`  ${pad(inert(r.outcome), 9)} ${inert(r.label)}${inert(move)}${inert(why)}`);
  }
  for (const s of bulk.skipped)
    out.line(`  skipped   ${inert(s.item)}  (${inert(s.reason)})`);
}

/**
 * The asks as lines no wider than `width - 1`, so none wraps on its own:
 * kind and repository padded to their widest, the address whole, and the
 * title cut to what those leave. Coloured only when `out` is given.
 */
export function askLines(
  rows: readonly Ask[],
  width: number,
  out?: Pick<Out, "paint" | "c">,
): string[] {
  const kindW = Math.max(...rows.map((a) => displayWidth(inert(a.kind))));
  const repoW = Math.max(...rows.map((a) => displayWidth(inert(a.repo))));
  return rows.map((a) => {
    const url = inert(a.url);
    // Three two-space gaps; the title gets what the other columns leave.
    const room = Math.max(1, width - 1 - kindW - repoW - displayWidth(url) - 6);
    const kind = pad(inert(a.kind), kindW);
    return [
      out === undefined ? kind : out.paint(kind, out.c.accent),
      pad(inert(a.repo), repoW),
      truncate(inert(a.title), room),
      out === undefined ? url : out.paint(url, out.c.faint),
    ].join("  ");
  });
}

/**
 * The API's answer with only one repository's rows; the forge's own needs
 * belong to none.
 */
function onlyRepo(raw: unknown, repo: string): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const body = raw as { rows?: unknown };
  return {
    ...body,
    rows: Array.isArray(body.rows)
      ? body.rows.filter((r) => (r as { repo?: unknown } | null)?.repo === repo)
      : body.rows,
    forge: [],
  };
}

export const command: Command = {
  name: "asks",
  usage: {
    synopsis: "forge asks",
    flags: "[--repo owner/name] [--json] | --ship|--close|--dismiss <n…> [--reason words] [--yes]",
  },
  run: (out, args, _help, io, argv) => asks(out, args, argv, confirmOn(io)),
};
