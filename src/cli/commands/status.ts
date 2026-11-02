import { runSync } from "./sync.ts";
import type { Command } from "./types.ts";

export const command: Command = {
  name: "status",
  usage: { synopsis: "forge status", flags: "[--root DIR] [--json]" },
  run: (out, args) => runSync(out, args, false),
};
