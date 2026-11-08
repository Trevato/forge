import { ForgeApi } from "../api.ts";
import { parseRepoRef, type Args } from "../args.ts";
import { requireConfig } from "../context.ts";
import { EXIT } from "../exit.ts";
import { folderRepo } from "../folder-repo.ts";
import { inert, type Out } from "../out.ts";
import { displayWidth, pad, truncate } from "../../tui/term/width.ts";
import type { Command } from "./types.ts";

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
  const aW = Math.min(
    20,
    wide((r) => r.author),
  );
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

export const command: Command = {
  name: "pulls",
  usage: {
    synopsis: "forge pulls",
    flags: "[--repo owner/name] [--closed] [--json]",
  },
  run: pulls,
};
