import { ForgeApi } from "../api.ts";
import { parseRepoRef, type Args } from "../args.ts";
import { requireConfig } from "../context.ts";
import { EXIT } from "../exit.ts";
import { folderRepo } from "../folder-repo.ts";
import { inert, type Out } from "../out.ts";
import { mapLines } from "../plan.ts";
import type { Command } from "./types.ts";

/**
 * `forge map`: where the repository's plan stands, in a screenful — what
 * the crew is building, what is ready, and what waits on what.
 */
async function map(out: Out, args: Args): Promise<number> {
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
        ? "forge map: --repo expects owner/name"
        : `forge map: this folder is not a clone of ${loaded.url} — run it in a clone, or pass --repo owner/name`,
    );
    return EXIT.usage;
  }
  const got = await new ForgeApi(loaded.url, loaded.token).map(ref.owner, ref.name);
  if (!got.ok) {
    out.err(`forge map: ${inert(got.error.message)}`);
    if (got.error.status === 401) return EXIT.notConfigured;
    if (got.error.status === 403) return EXIT.refused;
    return EXIT.failed;
  }
  if (args.flag("json")) {
    out.line(JSON.stringify(got.value.raw));
    return EXIT.ok;
  }
  for (const line of mapLines(got.value, out.width, out)) out.line(line);
  return EXIT.ok;
}

export const command: Command = {
  name: "map",
  usage: { synopsis: "forge map", flags: "[--repo owner/name] [--json]" },
  run: map,
};
