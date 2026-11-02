/**
 * `ssh <app>@<forge> pulls`: the app's open pulls, one plain line each —
 * `#n title · <check word>` — for a viewer the key makes. No pty, and the
 * same gate as the app's terminal (`appGate`), so a refusal is the same
 * sentence.
 */
import type { App as Forge } from "../app.ts";
import type { AppRecord } from "../core/apps.ts";
import { getRepoById } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import type { SshSession } from "../ssh/server.ts";
import { checkWord } from "./check_word.ts";
import type { EnvName } from "./data.ts";
import { openPulls } from "./door_pulls.ts";
import { appGate, ttyRefusalText } from "./tty.ts";

/** A title as one safe line: control characters (escapes, newlines) gone, bounded. */
export function plainTitle(title: string): string {
  return title
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "")
    .trim()
    .slice(0, 120);
}

export function servePulls(
  forge: Forge,
  session: SshSession,
  user: User | undefined,
  target: { app: AppRecord; env: EnvName },
): void {
  const refusal = appGate(forge, user, target);
  const repo = getRepoById(forge.db, target.app.repoId);
  if (refusal !== undefined || repo === undefined) {
    session.writeStderr(
      `forge: ${ttyRefusalText(refusal ?? "not_found", session.username)}\r\n`,
    );
    session.exit(1);
    return;
  }
  const lines = openPulls(forge.db, repo, user).map(
    (p) =>
      `#${p.number} ${plainTitle(p.title)} · ${checkWord(p.run, p.headOid)}\n`,
  );
  session.write(new TextEncoder().encode(lines.join("")));
  session.exit(0);
}
