import { clearConfig } from "../config.ts";
import { EXIT } from "../exit.ts";
import type { Command } from "./types.ts";

export const command: Command = {
  name: "logout",
  usage: { synopsis: "forge logout" },
  async run(out) {
    await clearConfig();
    out.line("signed out");
    return EXIT.ok;
  },
};
