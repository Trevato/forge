/**
 * `pack up`'s preparation, before the forge boots: open the data directory,
 * make the one owner account if there is none, and mint a token that expires
 * in an hour for the deploy to use. The owner's passphrase is made here, kept
 * in `<data>/owner-passphrase` (0600, under the forge's own state), and shown
 * once. Nothing is read from the pack's sources and no model credential is
 * asked for: the words below say what is left to supply.
 */

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createApp } from "../app.ts";
import { crewHasCredential } from "../core/subscriptions.ts";
import { createToken } from "../core/tokens.ts";
import { createUser, getUserByName } from "../core/users.ts";

export const OWNER = "owner";
const HOUR_MS = 3_600_000;

export interface Prepared {
  readonly token: string;
  /** The passphrase, only on the run that made the account. */
  readonly passphrase?: string;
  readonly passphraseFile: string;
  /** Whether the crew has a model credential: one stored in this data directory, or in `env`. */
  readonly credential: boolean;
}

export async function prepareOwner(dataDir: string, env: Record<string, string | undefined> = process.env): Promise<Prepared> {
  const app = createApp({ dataDir, port: 0 });
  try {
    const file = join(dataDir, "owner-passphrase");
    let user = getUserByName(app.db, OWNER);
    let passphrase: string | undefined;
    if (user === undefined) {
      passphrase = randomBytes(18).toString("base64url");
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        allowReserved: true,
        username: OWNER,
        email: "owner@forge.local",
        password: passphrase,
        adminIfFirst: true,
      });
      if (!made.ok) throw new Error(`cannot make the owner account: ${made.error}`);
      user = made.value;
      writeFileSync(file, `${passphrase}\n`, { mode: 0o600 });
      chmodSync(file, 0o600);
    }
    const { token } = createToken(app.db, user.id, "pack up", "admin", {
      expiresAt: new Date(Date.now() + HOUR_MS).toISOString(),
    });
    return { token, ...(passphrase === undefined ? {} : { passphrase }), passphraseFile: file, credential: crewHasCredential(app.db, env) };
  } finally {
    app.close();
  }
}

/** The last words: what is running, and the one thing left for the person. */
export function finishWords(url: string, credentialPresent: boolean): readonly string[] {
  return [
    `Your forge is serving ${url}/`,
    credentialPresent
      ? "The crew has a model credential and will start work."
      : `The crew is off until you add a model credential: sign in and open ${url}/settings/subscriptions (or start this command again with ANTHROPIC_API_KEY set).`,
  ];
}
