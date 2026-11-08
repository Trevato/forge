import { ForgeApi } from "../api.ts";
import { requireConfig } from "../context.ts";
import { EXIT } from "../exit.ts";
import type { Command } from "./types.ts";

export const command: Command = {
  name: "whoami",
  usage: { synopsis: "forge whoami" },
  async run(out) {
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
  },
};
