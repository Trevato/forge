#!/usr/bin/env bun
/**
 * `forge` — the client that lives on your machine.
 *
 *   forge                     the local terminal UI over your clones
 *   forge login <url>         remember a workbench and a token
 *   forge sync                clone what is missing, fetch the rest, report
 *   forge status              the same report without touching the network
 *
 * Everything here is a thin shell around three modules: `api.ts` talks to the
 * workbench, `sync.ts` decides what should be on disk, `report.ts` prints it.
 * This file's whole job is to turn argv into one of those calls and to pick
 * an exit code — so a script can branch on the result without parsing text.
 */

import { parseArgs, parseDuration, parseRepoRef, type Args } from "./args.ts";
import { ForgeApi } from "./api.ts";
import {
  clearConfig,
  configPath,
  loadConfig,
  normalizeUrl,
  rootDir,
  saveConfig,
  type Config,
} from "./config.ts";
import { systemNotifier } from "./notify.ts";
import { createOut, type Out } from "./out.ts";
import { printReport, since } from "./report.ts";
import { changesBetween, syncOnce, type SyncReport } from "./sync.ts";
import { G } from "../tui/term/screen.ts";

/** Kept in step with package.json by hand; the CLI ships compiled. */
const VERSION = "0.0.1";

export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  notConfigured: 3,
  /** The run completed, but at least one repo did not. */
  partial: 4,
} as const;

const VALUE_FLAGS = ["token", "interval", "root", "url", "limit"];

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
      return list(out);
    case "pin":
      return setPin(out, args, true);
    case "unpin":
      return setPin(out, args, false);
    case "open":
      return openRepo(out, args);
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
  out.line(b("  forge login <url>") + "            [--token T]");
  out.line(b("  forge logout"));
  out.line(b("  forge whoami"));
  out.line(
    b("  forge sync") +
      "                   [--watch] [--interval 5m] [--ff] [--root DIR]",
  );
  out.line(b("  forge status") + "                 [--root DIR]");
  out.line(b("  forge ls"));
  out.line(b("  forge pin <owner/name>"));
  out.line(b("  forge unpin <owner/name>"));
  out.line(b("  forge open <owner/name>") + "      [--web]");
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
  const stored = await saveConfig({ url, token });
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
      ...(quiet || !out.color
        ? {}
        : { onProgress: (repo, text) => status(out, `${repo}: ${text}`) }),
    });
    if (!quiet && out.color) status(out, "");
    if (previous === null || !quiet) printReport(out, report);
    return report;
  };

  if (!args.flag("watch")) {
    const report = await once(null, false);
    return report.failures > 0 ? EXIT.partial : EXIT.ok;
  }

  const interval = parseDuration(args.value("interval")) ?? 300_000;
  const notify = systemNotifier();
  let previous = await once(null, false);
  out.line();
  out.line(
    out.paint(
      `watching ${previous.repos.length} repos every ${args.value("interval") ?? "5m"} — ctrl+c to stop`,
      out.c.faint,
    ),
  );
  for (;;) {
    await sleep(interval);
    const report = await once(previous, true);
    const changes = changesBetween(previous, report);
    previous = report;
    if (changes.length === 0) continue;
    // Only a real transition reaches the user; everything else is the
    // report, which is there when they choose to look at it.
    out.line();
    out.line(new Date().toLocaleTimeString());
    printReport(out, report);
    await notify("forge", changes.slice(0, 4).join("\n"));
  }
}

async function list(out: Out): Promise<number> {
  const loaded = await requireConfig(out);
  if (typeof loaded === "number") return loaded;
  // `ls` answers from disk, so it keeps working when the forge does not.
  const report = await syncOnce({
    api: new ForgeApi(loaded.url, loaded.token),
    token: loaded.token,
    root: rootDir(),
    fetch: false,
  });
  out.line(out.paint(report.root, out.c.faint));
  for (const repo of report.repos)
    out.line(
      `  ${repo.owner}/${repo.name}` +
        out.paint(
          repo.present ? `  ${since(repo.lastFetch)}` : "  not cloned",
          out.c.faint,
        ),
    );
  return EXIT.ok;
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

// ── the terminal UI ──────────────────────────────────────────────────────

async function openTui(out: Out, args: Args): Promise<number> {
  if (process.stdout.isTTY !== true) {
    usage(out);
    return EXIT.usage;
  }
  const loaded = await loadConfig();
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
