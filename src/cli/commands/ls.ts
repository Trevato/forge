import { ForgeApi } from "../api.ts";
import { rootDir } from "../config.ts";
import { asJson, requireConfig } from "../context.ts";
import { EXIT } from "../exit.ts";
import { cell, type Out } from "../out.ts";
import { dirtyCount, settled, since } from "../report.ts";
import { syncOnce, type RepoReport } from "../sync.ts";
import { G } from "../../tui/term/screen.ts";
import { trackText } from "../../tui/local/common.ts";
import type { Command } from "./types.ts";

function lsState(out: Out, r: RepoReport): ReturnType<typeof cell> {
  if (!r.present) return cell("not cloned", out.c.attn);
  const dirty = dirtyCount(r);
  if (dirty > 0) return cell(`${dirty} dirty`, out.c.accent);
  if (settled(r)) return cell(G.check, out.c.success);
  return cell(r.upstream === null ? "no upstream" : "", out.c.faint);
}

export const command: Command = {
  name: "ls",
  usage: { synopsis: "forge ls", flags: "[--json]" },
  async run(out, args) {
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
  },
};
