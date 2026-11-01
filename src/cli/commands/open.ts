import { ForgeApi } from "../api.ts";
import { parseRepoRef } from "../args.ts";
import { requireConfig } from "../context.ts";
import { EXIT } from "../exit.ts";
import type { Command } from "./types.ts";

export const command: Command = {
  name: "open",
  usage: { synopsis: "forge open <owner/name>", flags: "[--web]" },
  async run(out, args) {
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
  },
};
