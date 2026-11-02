import { ForgeApi } from "../api.ts";
import { parseRepoRef, type Args } from "../args.ts";
import { requireConfig } from "../context.ts";
import { EXIT } from "../exit.ts";
import type { Out } from "../out.ts";
import { G } from "../../tui/term/screen.ts";
import type { Command } from "./types.ts";

/** Shared by `pin` and `unpin`: the two differ only in the call and the verb. */
export async function setPin(
  out: Out,
  args: Args,
  on: boolean,
): Promise<number> {
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

export const command: Command = {
  name: "pin",
  usage: { synopsis: "forge pin <owner/name>" },
  run: (out, args) => setPin(out, args, true),
};
