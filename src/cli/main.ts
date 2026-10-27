#!/usr/bin/env bun
/**
 * `forge` — the client that lives on your machine.
 *
 *   forge                     the local terminal UI over your clones
 *   forge login <url>         remember a workbench and a token
 *   forge sync                clone what is missing, fetch the rest, report
 *   forge status              the same report without touching the network
 *   forge asks                what waits on you, most important first
 *
 * Everything here is a thin shell around three modules: `api.ts` talks to the
 * workbench, `sync.ts` decides what should be on disk, `report.ts` prints it.
 * This file's whole job is to turn argv into one of those calls and to pick
 * an exit code — so a script can branch on the result without parsing text.
 */

import { parseArgs, parseDuration, parseRepoRef, type Args } from "./args.ts";
import { ForgeApi, type Ask } from "./api.ts";
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
import { systemNotifier } from "./notify.ts";
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
} as const;

const VALUE_FLAGS = ["token", "interval", "root", "url", "limit", "repo"];

export async function main(argv: readonly string[]): Promise<number> {
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
    case "open":
      return openRepo(out, args);
    case "asks":
      return asks(out, args);
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
    b("  forge asks") + "                   [--repo owner/name] [--json]",
  );
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

// ── asks ─────────────────────────────────────────────────────────────────

/**
 * What waits on you, one line each, in the order the forge ranks it: kind,
 * repository, title cut to the terminal, and the address to decide it at.
 */
async function asks(out: Out, args: Args): Promise<number> {
  const only = args.value("repo");
  const ref = only === undefined ? undefined : parseRepoRef(only);
  if (only !== undefined && ref === undefined) {
    out.err("forge asks: --repo expects owner/name");
    return EXIT.usage;
  }
  const loaded = await requireConfig(out);
  if (typeof loaded === "number") return loaded;
  const answer = await new ForgeApi(loaded.url, loaded.token).asks();
  if (!answer.ok) {
    out.err(`forge asks: ${answer.error.message}`);
    return answer.error.status === 401 ? EXIT.notConfigured : EXIT.failed;
  }
  const repo = ref === undefined ? undefined : `${ref.owner}/${ref.name}`;
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
  for (const line of askLines(rows, out.width, out)) out.line(line);
  return EXIT.ok;
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
      8,
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
