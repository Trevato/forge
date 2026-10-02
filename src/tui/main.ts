/**
 * The local dev runner: the same terminal UI, over stdio, against a data
 * directory on this machine.
 *
 *   bun run src/tui/main.ts                  # as a guest
 *   bun run src/tui/main.ts --user alice     # as alice
 *   FORGE_DATA=./data bun run src/tui/main.ts
 *
 * `--user` is a DEVELOPMENT convenience and exists only here. It is not
 * reachable over SSH: `src/tui/ssh.ts` resolves identity from the key the
 * client proved possession of and from nothing else, so no flag, env var or
 * client string can select an account there.
 */

import { createApp } from "../app.ts";
import { getUserByName } from "../core/users.ts";
import { createForgeApp } from "./forge.ts";
import { stdioTerminal } from "./term/terminal.ts";

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && process.argv[at + 1] !== undefined)
    return process.argv[at + 1];
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

const forge = createApp({
  dataDir: process.env.FORGE_DATA ?? "data",
  port: Number(process.env.PORT ?? 3000),
  ...(process.env.FORGE_HOST === undefined
    ? {}
    : { host: process.env.FORGE_HOST }),
  ...(process.env.FORGE_SSH_PORT === undefined
    ? {}
    : { sshPort: Number(process.env.FORGE_SSH_PORT) }),
});

const username = flag("user");
const user =
  username === undefined ? undefined : getUserByName(forge.db, username);
if (username !== undefined && user === undefined) {
  // CLI message on stderr for the person at the terminal.
  console.error(`forge: no such user: ${username}`);
  process.exit(1);
}

const { app } = createForgeApp(
  forge,
  {
    sshUsername: username ?? "local",
    remoteAddress: "stdio",
    ...(user === undefined ? {} : { user }),
  },
  { terminal: stdioTerminal(), exitHooks: true },
);
app.start();
