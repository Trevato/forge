#!/usr/bin/env bun
/**
 * `forge` — the client that lives on your machine.
 *
 *   forge                     the local terminal UI over your clones
 *   forge login <url>         remember a workbench and a token
 *   forge sync                clone what is missing, fetch the rest, report
 *   forge status              the same report without touching the network
 *   forge asks                what waits on you, most important first
 *   forge asks --ship 1 3     decide asks by their numbers: planned, then a y/N
 *   forge asks --undo <id>    take back what that decided
 *   forge ship <number>       land a pull after a y/N, as its Merge button does
 *
 * Everything here is a thin shell around three modules: `api.ts` talks to the
 * workbench, `sync.ts` decides what should be on disk, `report.ts` prints it.
 * This file's whole job is to turn argv into one of those calls and to pick
 * an exit code — so a script can branch on the result without parsing text.
 */

import { parseArgs, parseDuration, parseRepoRef, type Args } from "./args.ts";
import { ForgeApi, type ApiError, type Ask, type Bulk } from "./api.ts";
import { parseWish, pickAsks, type Wish } from "./decide.ts";
import {
  clearConfig,
  configPath,
  loadConfig,
  normalizeUrl,
  PLAIN_HTTP_REFUSAL,
  plainHttpRemote,
  rootDir,
  saveConfig,
  type Config,
} from "./config.ts";
import { folderRepo } from "./folder-repo.ts";
import { systemNotifier } from "./notify.ts";
import { resolveRepo } from "./here.ts";
import { cell, createOut, inert, type Out } from "./out.ts";
import { dirtyCount, printReport, settled, since } from "./report.ts";
import {
  changesBetween,
  syncOnce,
  type RepoReport,
  type SyncReport,
} from "./sync.ts";
import { G } from "../tui/term/screen.ts";
import { trackText } from "../tui/local/common.ts";
import { displayWidth, pad, truncate } from "../tui/term/width.ts";

/**
 * The CLI's own number, kept by hand: it ships compiled, to machines no
 * release stamps. The server's comes from its build (`kernel/version.ts`).
 */
const VERSION = "0.0.1";

export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  notConfigured: 3,
  /** The run completed, but at least one repo did not. */
  partial: 4,
  /** The forge heard the request and said no: a rule, a conflict, a hold. */
  refused: 5,
} as const;

const VALUE_FLAGS = ["token", "interval", "root", "url", "limit", "repo", "reason"];

/** What the CLI needs from the person at the keyboard; a test fakes it. */
export interface Io {
  /** One answered line, or null when there is no terminal to ask. */
  ask(prompt: string): Promise<string | null>;
}

export async function main(
  argv: readonly string[],
  io: Io = { ask: askLine },
): Promise<number> {
  const args = parseArgs(argv, { values: VALUE_FLAGS });
  const out = createOut();

  if (args.flag("version") || args.flag("v")) {
    out.line(`forge ${VERSION}`);
    return EXIT.ok;
  }
  if (args.command === undefined) {
    if (args.flag("help") || args.flag("h")) {
      usage(out);
      return EXIT.ok;
    }
    return openTui(out, args);
  }
  if (args.flag("help") || args.flag("h")) {
    usage(out);
    return EXIT.ok;
  }

  switch (args.command) {
    case "help":
      usage(out);
      return EXIT.ok;
    case "login":
      return login(out, args);
    case "logout":
      return logout(out);
    case "whoami":
      return whoami(out);
    case "sync":
      return sync(out, args, true);
    case "status":
      return sync(out, args, false);
    case "ls":
      return list(out, args);
    case "pin":
      return setPin(out, args, true);
    case "unpin":
      return setPin(out, args, false);
    case "pulls":
      return pulls(out, args);
    case "open":
      return openRepo(out, args);
    case "asks":
      return asks(out, args, argv.slice(1));
    case "ship":
      return ship(out, args, io);
    case "ui":
      return openTui(out, args);
    default:
      out.err(`forge: unknown command "${args.command}"`);
      usage(out);
      return EXIT.usage;
  }
}

function usage(out: Out): void {
  const b = (text: string): string => out.paint(text, out.c.fg);
  out.line(`forge ${VERSION} — your workbench, on this machine`);
  out.line();
  out.line(b("  forge") + "                        the local terminal UI");
  out.line(b("  forge login <url>") + "            [--token T] [--insecure]");
  out.line(b("  forge logout"));
  out.line(b("  forge whoami"));
  out.line(
    b("  forge sync") +
      "                   [--watch] [--interval 5m] [--ff] [--root DIR]",
  );
  out.line(b("  forge status") + "                 [--root DIR] [--json]");
  out.line(b("  forge ls") + "                     [--json]");
  out.line(b("  forge pin <owner/name>"));
  out.line(b("  forge unpin <owner/name>"));
  out.line(b("  forge open <owner/name>") + "      [--web]");
  out.line(
    b("  forge pulls") + "                  [--repo owner/name] [--closed] [--json]",
  );
  out.line(
    b("  forge asks") + "                   [--repo owner/name] [--json]",
  );
  out.line(
    b("  forge asks --ship|--close|--dismiss <n…>") +
      "  [--reason words] [--yes]",
  );
  out.line(b("  forge ship <number>") + "          [--repo owner/name] [--yes]");
  out.line();
  out.line(
    out.paint(`  config ${configPath()}   root ${rootDir()}`, out.c.faint),
  );
  out.line(
    out.paint(
      "  FORGE_URL, FORGE_TOKEN, FORGE_ROOT and NO_COLOR are honoured.",
      out.c.faint,
    ),
  );
}

// ── account ──────────────────────────────────────────────────────────────

async function login(out: Out, args: Args): Promise<number> {
  const raw = args.positional[0] ?? args.value("url");
  if (raw === undefined) {
    out.err("forge login: which forge? e.g. forge login forge.example.com");
    return EXIT.usage;
  }
  const url = normalizeUrl(raw);
  // Before the token is asked for, let alone sent: nothing crosses the
  // network in clear unless the person said this host is one they trust.
  const insecure = args.flag("insecure");
  if (plainHttpRemote(url) && !insecure) {
    out.err(`forge login: ${PLAIN_HTTP_REFUSAL}`);
    return EXIT.usage;
  }
  const token = args.value("token") ?? (await askSecret(`Token for ${url}: `));
  if (token === "") {
    out.err("forge login: no token given");
    return EXIT.usage;
  }

  // Verify before storing: a config that does not work is worse than none.
  const api = new ForgeApi(url, token);
  const me = await api.whoami();
  if (!me.ok) {
    out.err(`forge login: ${me.error.message}`);
    return me.error.status === 401 ? EXIT.notConfigured : EXIT.failed;
  }
  const stored = await saveConfig({ url, token }, { insecure });
  out.line(
    `${out.paint(G.check, out.c.success)} signed in to ${url} as ${me.value.username}`,
  );
  out.line(
    out.paint(
      stored.keychain
        ? `  token in your login keychain; ${configPath()} holds only the URL`
        : `  token in ${configPath()} (0600)`,
      out.c.faint,
    ),
  );
  return EXIT.ok;
}

async function logout(out: Out): Promise<number> {
  await clearConfig();
  out.line("signed out");
  return EXIT.ok;
}

async function whoami(out: Out): Promise<number> {
  const loaded = await requireConfig(out);
  if (typeof loaded === "number") return loaded;
  const api = new ForgeApi(loaded.url, loaded.token);
  const me = await api.whoami();
  if (!me.ok) {
    out.err(`forge whoami: ${me.error.message}`);
    return EXIT.failed;
  }
  out.line(`${me.value.username} at ${loaded.url}`);
  return EXIT.ok;
}

// ── sync and status ──────────────────────────────────────────────────────

async function sync(out: Out, args: Args, network: boolean): Promise<number> {
  const loaded = await requireConfig(out);
  if (typeof loaded === "number") return loaded;
  const api = new ForgeApi(loaded.url, loaded.token);
  const root = rootDir(args.value("root"));
  const ff = args.flag("ff");

  const json = args.flag("json");

  const once = async (
    previous: SyncReport | null,
    quiet: boolean,
  ): Promise<SyncReport> => {
    const report = await syncOnce({
      api,
      token: loaded.token,
      root,
      fetch: network,
      ff,
      ...(quiet || json || !out.color
        ? {}
        : { onProgress: (repo, text) => status(out, `${repo}: ${text}`) }),
    });
    if (!quiet && !json && out.color) status(out, "");
    if (previous === null || !quiet) {
      if (json) out.line(JSON.stringify(asJson(report)));
      else printReport(out, report);
    }
    return report;
  };

  if (!args.flag("watch")) {
    const report = await once(null, false);
    return report.failures > 0 ? EXIT.partial : EXIT.ok;
  }

  const interval = parseDuration(args.value("interval")) ?? 300_000;
  const notify = systemNotifier();
  let previous = await once(null, false);
  if (!json) {
    out.line();
    out.line(
      out.paint(
        `watching ${previous.repos.length} repos every ${args.value("interval") ?? "5m"} — ctrl+c to stop`,
        out.c.faint,
      ),
    );
  }
  for (;;) {
    await sleep(interval);
    const report = await once(previous, true);
    const changes = changesBetween(previous, report);
    previous = report;
    // Only a real transition reaches the user; everything else is the
    // report, which is there when they choose to look at it. A watch that
    // notified on every pass would be muted within the hour.
    if (changes.length === 0) continue;
    if (json) out.line(JSON.stringify({ ...asJson(report), changes }));
    else {
      out.line();
      out.line(new Date().toLocaleTimeString());
      printReport(out, report);
    }
    await notify("forge", changes.slice(0, 4).join("\n"));
  }
}

async function list(out: Out, args: Args): Promise<number> {
  const loaded = await requireConfig(out);
  if (typeof loaded === "number") return loaded;
  // `ls` answers from disk, so it keeps working when the forge does not.
  const report = await syncOnce({
    api: new ForgeApi(loaded.url, loaded.token),
    token: loaded.token,
    root: rootDir(args.value("root")),
    fetch: false,
  });
  if (args.flag("json")) {
    out.line(JSON.stringify(asJson(report)));
    return EXIT.ok;
  }
  out.line(out.paint(report.root, out.c.faint));
  out.table(
    [
      { header: "REPO", max: 44 },
      { header: "BRANCH", max: 24 },
      { header: "SYNC", align: "right" },
      { header: "STATE", max: 28 },
      { header: "FETCHED", align: "right" },
    ],
    report.repos.map((r) => [
      cell(`${r.owner}/${r.name}`, r.present ? out.c.fg : out.c.mutedFg),
      cell(r.present ? (r.branch ?? "detached") : "—", out.c.mutedFg),
      cell(trackText(r.ahead, r.behind), out.c.attn),
      lsState(out, r),
      cell(r.present ? since(r.lastFetch) : "", out.c.faint),
    ]),
  );
  return EXIT.ok;
}

function lsState(out: Out, r: RepoReport): ReturnType<typeof cell> {
  if (!r.present) return cell("not cloned", out.c.attn);
  const dirty = dirtyCount(r);
  if (dirty > 0) return cell(`${dirty} dirty`, out.c.accent);
  if (settled(r)) return cell(G.check, out.c.success);
  return cell(r.upstream === null ? "no upstream" : "", out.c.faint);
}

/**
 * The report as data. `--json` exists so a script can branch on the same
 * facts the table shows without parsing columns — so every field the table
 * draws from is here, spelled the way the rest of the client spells it.
 */
function asJson(report: SyncReport): Record<string, unknown> {
  return {
    root: report.root,
    pinsUnavailable: report.pinsUnavailable,
    failures: report.failures,
    repos: report.repos.map((r: RepoReport) => ({
      owner: r.owner,
      name: r.name,
      path: r.dir,
      present: r.present,
      cloned: r.cloned,
      pinned: r.pinned,
      branch: r.branch,
      upstream: r.upstream,
      ahead: r.ahead,
      behind: r.behind,
      staged: r.staged,
      changed: r.changed,
      untracked: r.untracked,
      conflicted: r.conflicted,
      dirty: dirtyCount(r),
      stashes: r.stashes,
      unpushed: r.unpushed,
      fastForwarded: r.fastForwarded,
      lastFetch: r.lastFetch === null ? null : r.lastFetch.toISOString(),
      error: r.error,
    })),
  };
}

// ── pins ─────────────────────────────────────────────────────────────────

async function setPin(out: Out, args: Args, on: boolean): Promise<number> {
  const verb = on ? "pin" : "unpin";
  const ref = parseRepoRef(args.positional[0]);
  if (ref === undefined) {
    out.err(`forge ${verb}: expected owner/name`);
    return EXIT.usage;
  }
  const loaded = await requireConfig(out);
  if (typeof loaded === "number") return loaded;
  const api = new ForgeApi(loaded.url, loaded.token);
  const result = on
    ? await api.pin(ref.owner, ref.name)
    : await api.unpin(ref.owner, ref.name);
  if (!result.ok) {
    out.err(
      result.error.status === 404
        ? `forge ${verb}: this forge does not support pins yet`
        : `forge ${verb}: ${result.error.message}`,
    );
    return EXIT.failed;
  }
  out.line(
    `${out.paint(G.check, out.c.success)} ${on ? "pinned" : "unpinned"} ${ref.owner}/${ref.name}`,
  );
  if (on)
    out.line(out.paint("  run `forge sync` to bring it down", out.c.faint));
  return EXIT.ok;
}

async function openRepo(out: Out, args: Args): Promise<number> {
  const ref = parseRepoRef(args.positional[0]);
  if (ref === undefined) {
    out.err("forge open: expected owner/name");
    return EXIT.usage;
  }
  const loaded = await requireConfig(out);
  if (typeof loaded === "number") return loaded;
  const url = new ForgeApi(loaded.url, loaded.token).webUrl(
    ref.owner,
    ref.name,
  );
  out.line(url);
  if (!args.flag("web")) return EXIT.ok;
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const proc = Bun.spawn([opener, url], {
      stdout: "ignore",
      stderr: "ignore",
    });
    await proc.exited;
  } catch {
    out.err(`forge open: could not run ${opener}`);
    return EXIT.failed;
  }
  return EXIT.ok;
}

// ── pulls ────────────────────────────────────────────────────────────────

async function pulls(out: Out, args: Args): Promise<number> {
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
        ? "forge pulls: --repo expects owner/name"
        : `forge pulls: this folder is not a clone of ${loaded.url} — run it in a clone, or pass --repo owner/name`,
    );
    return EXIT.usage;
  }
  const closed = args.flag("closed");
  const got = await new ForgeApi(loaded.url, loaded.token).pulls(
    ref.owner,
    ref.name,
    closed ? "closed" : "open",
  );
  if (!got.ok) {
    out.err(`forge pulls: ${got.error.message}`);
    return EXIT.failed;
  }
  if (args.flag("json")) {
    out.line(JSON.stringify(got.value));
    return EXIT.ok;
  }
  const items = got.value.items as Record<string, unknown>[];
  if (items.length === 0) {
    out.line(closed ? "No closed pulls." : "No open pulls.");
    return EXIT.ok;
  }
  const tone = {
    green: out.c.success,
    red: out.c.danger,
    running: out.c.attn,
    none: out.c.faint,
  } as const;
  const rows = items.map((item) => ({
    number: `#${String(item["number"])}`,
    title: inert(String(item["title"] ?? "")),
    author: inert(String(item["author"] ?? "")),
    check: String(item["check"]) as keyof typeof tone,
    preview: inert(typeof item["preview"] === "string" ? item["preview"] : ""),
  }));
  const wide = (pick: (r: (typeof rows)[number]) => string): number =>
    Math.max(...rows.map((r) => displayWidth(pick(r))));
  const nW = wide((r) => r.number);
  const aW = Math.min(20, wide((r) => r.author));
  const cW = wide((r) => r.check);
  const pW = wide((r) => r.preview);
  const gaps = 2 * (pW > 0 ? 4 : 3);
  const tW = Math.max(12, out.width - nW - aW - cW - pW - gaps);
  for (const r of rows) {
    const parts = [
      pad(r.number, nW, "right"),
      pad(truncate(r.title, tW), tW),
      pad(truncate(r.author, aW), aW),
      out.paint(pad(r.check, cW), tone[r.check] ?? out.c.faint),
    ];
    if (pW > 0) parts.push(r.preview);
    out.line(parts.join("  ").replace(/\s+$/, ""));
  }
  if (got.value.next_cursor !== null)
    out.line(
      out.paint(
        `The list is cut after ${rows.length} pulls; the forge has more.`,
        out.c.faint,
      ),
    );
  return EXIT.ok;
}

// ── asks ─────────────────────────────────────────────────────────────────

/**
 * What waits on you, one line each, in the order the forge ranks it: kind,
 * repository, title cut to the terminal, and the address to decide it at.
 */
export async function asks(
  out: Out,
  args: Args,
  argv: readonly string[] = [],
  confirm: Confirm = confirmOnTty,
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

/** Whether to go ahead: undefined when there is no one to ask. */
export type Confirm = (question: string) => Promise<boolean | undefined>;

const confirmOnTty: Confirm = async (question) => {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true)
    return undefined;
  process.stdout.write(question);
  const line = await new Promise<string>((resolve) => {
    const stdin = process.stdin;
    stdin.setEncoding("utf8");
    stdin.once("data", (chunk) => {
      stdin.pause();
      resolve(String(chunk));
    });
    stdin.resume();
  });
  return /^\s*y(es)?\s*$/i.test(line);
};

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
    const room = Math.max(
      1,
      width - 1 - kindW - repoW - displayWidth(url) - 6,
    );
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
      ? body.rows.filter(
          (r) => (r as { repo?: unknown } | null)?.repo === repo,
        )
      : body.rows,
    forge: [],
  };
}

// ── landing a pull ───────────────────────────────────────────────────────

/**
 * `forge ship 12`: read the pull, show it, ask, merge. The merge route's
 * rules stay the server's — this adds none and retries nothing; a refusal
 * prints the forge's own words.
 */
async function ship(out: Out, args: Args, io: Io): Promise<number> {
  const raw = args.positional[0];
  const number = raw === undefined ? NaN : Number(raw.replace(/^#/, ""));
  if (!Number.isSafeInteger(number) || number < 1) {
    out.err("forge ship: which pull? e.g. forge ship 12");
    return EXIT.usage;
  }
  const loaded = await requireConfig(out);
  if (typeof loaded === "number") return loaded;
  const ref = await resolveRepo(args.value("repo"), loaded.url);
  if (typeof ref === "string") {
    out.err(`forge ship: ${ref}`);
    return EXIT.usage;
  }
  const api = new ForgeApi(loaded.url, loaded.token);
  const pull = await api.pull(ref.owner, ref.name, number);
  if (!pull.ok) return shipError(out, pull.error);
  const check = await api.pullCheck(ref.owner, ref.name, number);
  const p = pull.value;
  out.line(`${ref.owner}/${ref.name}#${p.number}  ${inert(p.title)}`);
  const facts = [
    `check ${check.ok ? inert(check.value) : "unknown"}`,
    p.merged
      ? "already merged"
      : p.state !== "open"
        ? p.state
        : p.mergeable === false
          ? "not mergeable"
          : p.mergeable === true
            ? "mergeable"
            : "mergeable unknown",
    ...(p.held ? ["held"] : []),
  ];
  out.line(out.paint(`  ${facts.join(" · ")}`, out.c.faint));

  if (!args.flag("yes")) {
    const answer = await io.ask(`Ship #${p.number}? [y/N] `);
    if (answer === null) {
      out.err("forge ship: not a terminal — pass --yes to ship without asking");
      return EXIT.usage;
    }
    if (answer.trim().toLowerCase() !== "y") {
      out.line("not shipped");
      return EXIT.ok;
    }
  }

  const merged = await api.merge(ref.owner, ref.name, number);
  if (!merged.ok) return shipError(out, merged.error);
  out.line(
    `${out.paint(G.check, out.c.success)} shipped #${p.number} as ${merged.value.mergeOid.slice(0, 7)}`,
  );
  out.line(api.pullUrl(ref.owner, ref.name, number));
  return EXIT.ok;
}

function shipError(out: Out, error: ApiError): number {
  out.err(`forge ship: ${inert(error.message)}`);
  if (error.status === 401) return EXIT.notConfigured;
  if (error.status === 403 || error.status === 409 || error.status === 422)
    return EXIT.refused;
  return EXIT.failed;
}

// ── the terminal UI ──────────────────────────────────────────────────────

async function openTui(out: Out, args: Args): Promise<number> {
  if (process.stdout.isTTY !== true) {
    usage(out);
    return EXIT.usage;
  }
  const loaded = await loadConfig();
  if (loaded === "plain_http") {
    out.err(`forge: ${PLAIN_HTTP_REFUSAL}`);
    return EXIT.usage;
  }
  const config = typeof loaded === "string" ? null : loaded.config;
  const { runLocalTui } = await import("../tui/local/app.ts");
  await runLocalTui({
    root: rootDir(args.value("root")),
    ...(config === null ? {} : { config }),
  });
  return EXIT.ok;
}

// ── plumbing ─────────────────────────────────────────────────────────────

async function requireConfig(out: Out): Promise<Config | number> {
  const loaded = await loadConfig();
  if (loaded === "no_config") {
    out.err("forge: not signed in — run `forge login <url>`");
    return EXIT.notConfigured;
  }
  if (loaded === "no_token") {
    out.err(`forge: ${configPath()} has no usable token — run \`forge login\``);
    return EXIT.notConfigured;
  }
  if (loaded === "plain_http") {
    out.err(`forge: ${PLAIN_HTTP_REFUSAL}`);
    return EXIT.usage;
  }
  return loaded.config;
}

/** One transient line, overwritten in place. Never printed to a pipe. */
function status(out: Out, text: string): void {
  if (!out.color) return;
  const room = Math.max(0, out.width - 1);
  process.stdout.write(`\r\x1b[K${text.slice(0, room)}`);
  if (text === "") process.stdout.write("\r");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One line from the terminal, echoed; null when stdin is not a terminal. */
async function askLine(prompt: string): Promise<string | null> {
  const stdin = process.stdin;
  if (stdin.isTTY !== true || process.stdout.isTTY !== true) return null;
  process.stdout.write(prompt);
  stdin.resume();
  return new Promise<string>((resolve) => {
    // ctrl+d or a closed terminal is an answer too, and the answer is N.
    const finish = (answer: string): void => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("close", onEnd);
      stdin.pause();
      resolve(answer);
    };
    const onData = (chunk: Buffer): void =>
      finish(chunk.toString("utf8").split("\n")[0] ?? "");
    const onEnd = (): void => {
      process.stdout.write("\n");
      finish("");
    };
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("close", onEnd);
  });
}

/**
 * A secret, read without echo. Raw mode is the only way to stop the terminal
 * printing it, and it is restored on every path — including ctrl+c, which
 * here means "no token", not "leave the tty broken".
 */
async function askSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (stdin.isTTY !== true) {
    // Piped input: read one line. `echo $TOKEN | forge login url` is a
    // legitimate way to do this from a script.
    const text = await new Response(Bun.stdin.stream()).text();
    return text.split("\n")[0]?.trim() ?? "";
  }
  process.stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise<string>((resolve) => {
    let value = "";
    const finish = (result: string): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      for (const byte of chunk) {
        if (byte === 3) return finish(""); // ctrl+c
        if (byte === 13 || byte === 10) return finish(value.trim());
        if (byte === 127 || byte === 8) {
          value = value.slice(0, -1);
          continue;
        }
        if (byte >= 0x20) value += String.fromCharCode(byte);
      }
    };
    stdin.on("data", onData);
  });
}

// `import.meta.main` is false when a test imports `main` directly, which is
// exactly the boundary we want: the tests drive the same function the shell
// does, and nothing here calls `process.exit` behind their back.
if (import.meta.main) process.exit(await main(process.argv.slice(2)));
