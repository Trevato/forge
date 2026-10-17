/**
 * `bun src/main.ts --first-admin [--child <name>] [--url <origin>]`: mint a
 * first-admin code (`core/first_admin.ts`) and print it to this terminal,
 * the only place it is ever shown. Operator access is the gate: this runs
 * the forge's code against its data directory, beside the running forge,
 * and opens no socket. Nothing is migrated: a database the forge has not
 * made yet is refused, so a newer tree never moves a live schema.
 *
 * `--child <name>` mints for a child this forge hosts (`<data>/children/…`,
 * found through the spawn ledger), so the operator of the parent can hand
 * a child its first admin without its claim link.
 *
 * On a forge whose admins all lost their way in (`adminCanSignIn` is false:
 * typically a headless first admin whose token lapsed) it mints a recovery
 * code instead, for the one stranded admin or the one `--user <name>` names,
 * redeemed at `POST /api/v1/first-admin/recover` for a new expiring token.
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyPragmas } from "../kernel/db.ts";
import { dataDirOf } from "../kernel/preflight.ts";
import { CHILD_NAME } from "../spawn/placement.ts";
import { hasAdmin } from "../spawn/claim.ts";
import {
  adminCanSignIn,
  FIRST_ADMIN_TTL_MS,
  firstAdminLink,
  mintFirstAdmin,
  mintFirstAdminRecovery,
  strandedAdmins,
} from "./first_admin.ts";

export interface CliAnswer {
  readonly exit: number;
  /** For stdout: the code, and how to use it. */
  readonly out: readonly string[];
  /** For stderr: refusals and warnings. */
  readonly err: readonly string[];
}

const USAGE =
  "usage: bun src/main.ts --first-admin [--child <name>] [--url <https://forge.example>] [--user <stranded admin>]";
const LIFETIME_HINT = '"expiresIn": 86400}  (seconds, optional: a day by default, at most 30 days)';

const readJson = (path: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

const originOf = (raw: unknown): string | undefined => {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const url = URL.parse(raw.trim());
  return url && (url.protocol === "https:" || url.protocol === "http:") ? url.origin : undefined;
};

export function firstAdminCli(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  now = Date.now(),
): CliAnswer {
  const refuse = (line: string): CliAnswer => ({ exit: 1, out: [], err: [line] });
  let child: string | undefined;
  let url: string | undefined;
  let user: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag === "--child" || flag === "--url" || flag === "--user") && value !== undefined && !value.startsWith("--")) {
      if (flag === "--child") child = value;
      else if (flag === "--url") url = value;
      else user = value;
      i++;
    } else return refuse(USAGE);
  }
  if (url !== undefined && originOf(url) === undefined) return refuse(`--url: an http(s) address, not ${JSON.stringify(url.slice(0, 80))}`);

  let dir = dataDirOf(env);
  if (child !== undefined) {
    if (!CHILD_NAME.test(child)) return refuse(`--child: a child's name, lowercase letters, digits and dashes, not ${JSON.stringify(child.slice(0, 40))}`);
    const bodyId = readJson(join(dir, "spawn", `${child}.json`))?.bodyId;
    if (typeof bodyId !== "string" || !/^[A-Za-z0-9-]+$/.test(bodyId)) return refuse(`no child named ${child} in ${join(dir, "spawn")}`);
    dir = join(dir, "children", bodyId);
  }
  const file = join(dir, "forge.db");
  if (!existsSync(file)) return refuse(`no forge database at ${file}: start the forge once, then run this`);

  const db = new Database(file, { readwrite: true, strict: true });
  let minted: { code: string; expiresAt: string } | undefined;
  let recovering: string | undefined;
  try {
    applyPragmas(db);
    if (!hasAdmin(db)) {
      if (user !== undefined) return refuse(`--user recovers a stranded admin, and ${dir} has no admin: leave it out to make the first one.`);
      minted = mintFirstAdmin(db, now);
    } else if (adminCanSignIn(db, now)) {
      return refuse(`${dir} already has an admin who can sign in: no code was made. They can make accounts and tokens from Settings.`);
    } else {
      const stranded = strandedAdmins(db);
      const target = user === undefined ? (stranded.length === 1 ? stranded[0] : undefined) : stranded.find((a) => a.username === user);
      if (target === undefined)
        return refuse(
          user !== undefined
            ? `--user: ${JSON.stringify(user.slice(0, 40))} is not an active admin of ${dir}`
            : stranded.length === 0
              ? `${dir} has admins but none active to recover: no code was made.`
              : `no admin of ${dir} can sign in; name the one to recover with --user <name>: ${stranded.map((a) => a.username).join(", ")}`,
        );
      recovering = target.username;
      minted = mintFirstAdminRecovery(db, target.id, now);
    }
  } finally {
    db.close();
  }
  if (minted === undefined) return refuse(`${dir}: no code was made.`);

  const base =
    originOf(url) ??
    originOf(readJson(join(dir, "parent.json"))?.url) ??
    (child === undefined ? (originOf(env.FORGE_APP_URL) ?? originOf(env.FORGE_URL)) : undefined) ??
    `http://localhost:${env.PORT ?? 3000}`;
  const minutes = Math.round(FIRST_ADMIN_TTL_MS / 60_000);
  if (recovering !== undefined)
    return {
      exit: 0,
      out: [
        `Recovery code for ${dir}: no admin can sign in, so this buys ${recovering} a new expiring token. Works once, until ${minted.expiresAt} (${minutes} minutes), and not once any admin can sign in.`,
        "Shown only here; the forge keeps its hash. Running this again replaces it. It makes no account.",
        `  an agent, for a token:     POST ${base}/api/v1/first-admin/recover  {"code": "${minted.code}", "scope": "ro|rw|admin", ${LIFETIME_HINT}`,
      ],
      err: [],
    };
  return {
    exit: 0,
    out: [
      `First-admin code for ${dir}: works once, until ${minted.expiresAt} (${minutes} minutes), and not once anyone is admin.`,
      "Shown only here; the forge keeps its hash. Running this again replaces it.",
      `  a person, with a passkey:  ${firstAdminLink(base, minted.code)}`,
      `  an agent, for a token:     POST ${base}/api/v1/first-admin  {"code": "<the part after #>", "username": "…", "email": "…", "scope": "ro|rw|admin", ${LIFETIME_HINT}`,
    ],
    err: [],
  };
}
