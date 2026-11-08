/**
 * What a pack's page says, in one place for the web page and the terminal
 * screen: the commands that deploy it, and what happens to a stranger's pull.
 */

import type { Pack } from "./pack.ts";

/** The commands, one per line. `origin` is the forge's configured public address, never a request's Host. */
export function deployCommands(p: Pack, origin: string | undefined): readonly string[] {
  const from = origin === undefined ? "<this forge's address>" : origin.replace(/\/+$/, "");
  return [
    `git clone ${from}/trevato/forge.git && cd forge && bun install`,
    `bun run src/main.ts            # your forge, on http://localhost:3000`,
    `# make an account there, create an access token, then:`,
    `FORGE_URL=http://localhost:3000 FORGE_TOKEN=forge_… bun scripts/pack.ts deploy ${p.name}`,
  ];
}

export const STRANGER_WORDS: readonly string[] = [
  "You can read and comment with no account. To send a change, get a guest account here, or use a forge of your own: fork an app, change it, and send a pull.",
  "A guest's pull waits for a person to review it. Any path it touches that holds secrets, credentials, permissions or release machinery is named on its page, and it cannot change them by landing.",
];

export const BRINGS_WORDS =
  "Each app comes with its history. No data, secrets or variables come with a pack, and the crew waits for the model credential you give it.";
