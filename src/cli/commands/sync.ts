import { ForgeApi } from "../api.ts";
import { parseDuration, type Args } from "../args.ts";
import { rootDir } from "../config.ts";
import { asJson, requireConfig } from "../context.ts";
import { EXIT } from "../exit.ts";
import { systemNotifier } from "../notify.ts";
import type { Out } from "../out.ts";
import { printReport } from "../report.ts";
import { changesBetween, syncOnce, type SyncReport } from "../sync.ts";
import type { Command } from "./types.ts";

export async function runSync(
  out: Out,
  args: Args,
  network: boolean,
): Promise<number> {
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

export const command: Command = {
  name: "sync",
  usage: {
    synopsis: "forge sync",
    flags: "[--watch] [--interval 5m] [--ff] [--root DIR]",
  },
  run: (out, args) => runSync(out, args, true),
};
