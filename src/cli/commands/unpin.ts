import { setPin } from "./pin.ts";
import type { Command } from "./types.ts";

export const command: Command = {
  name: "unpin",
  usage: { synopsis: "forge unpin <owner/name>" },
  run: (out, args) => setPin(out, args, false),
};
