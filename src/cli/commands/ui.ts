import { loadConfig, PLAIN_HTTP_REFUSAL, rootDir } from "../config.ts";
import { EXIT } from "../exit.ts";
import type { Command } from "./types.ts";

export const command: Command = {
  name: "ui",
  usage: { synopsis: "forge", flags: "the local terminal UI" },
  async run(out, args, help) {
    if (process.stdout.isTTY !== true) {
      help(out);
      return EXIT.usage;
    }
    const loaded = await loadConfig();
    if (loaded === "plain_http") {
      out.err(`forge: ${PLAIN_HTTP_REFUSAL}`);
      return EXIT.usage;
    }
    const config = typeof loaded === "string" ? null : loaded.config;
    const { runLocalTui } = await import("../../tui/local/app.ts");
    await runLocalTui({
      root: rootDir(args.value("root")),
      ...(config === null ? {} : { config }),
    });
    return EXIT.ok;
  },
};
