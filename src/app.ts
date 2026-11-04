/**
 * The composition root. Everything a forge instance is — index, repos,
 * events, socket — lives under one data directory. `createApp` is cheap and
 * side-effect-contained, so tests boot real forges by the dozen.
 */

import { commitIdentity } from "./core/commit_identity.ts";
import { getUserById } from "./core/users.ts";
import type { MailConfig, Mailer } from "./kernel/mail.ts";
import type { Database } from "bun:sqlite";
import type { Decider } from "./crew/decide.ts";
import type { VerifyHuman } from "./core/turnstile.ts";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { migrationFiles } from "./core/schema.ts";
import { dropLegacyNewAccountGuards } from "./core/schema.ts";
import { EventBus } from "./core/events.ts";
import { follow } from "./core/following.ts";
import { enqueueForEvent } from "./core/webhooks.ts";
import { seedSignup } from "./settings/signup.ts";
import { openDb } from "./kernel/db.ts";
import { id } from "./kernel/id.ts";
import {
  createLog,
  forgeErrorLedger,
  releaseErrorLedger,
  type ErrorLedger,
  type Log,
} from "./kernel/log.ts";
import { RefusedLedger } from "./kernel/internal_refused.ts";
import { closeReadersUnder } from "./git/read.ts";

export interface ForgeConfig {
  /** Everything lives here: index db, bare repos, the internal socket. */
  dataDir: string;
  /**
   * A database made by this call starts with signup = invite (`seedSignup`);
   * one that already exists is left as it is. Off by default so a test's
   * forge reads the setting's `open`; `main.ts` turns it on.
   */
  seedSignup?: boolean;
  /** The disk probe vitals reads; the volume under `dataDir` when unset. Tests give it a reading. */
  disk?: (dir: string) => { freeBytes: number; totalBytes: number };
  /** How long the search page's first code search may keep starting greps, in ms. @default 30 (CODE_BUDGET_MS) */
  codeBudgetMs?: number;
  /** @default 3000 */
  port?: number;
  /** The hostname clone URLs are built from. @default "localhost" */
  host?: string;
  /**
   * The canonical public origin, when the forge is served through a proxy
   * that terminates TLS. Inside the deployment a request arrives as plain
   * HTTP on an internal name, but the browser sent its Origin for THIS
   * address, cookies need `Secure` here, and every URL shown to a person
   * must point here — so each request's URL is rebuilt on it. Undefined
   * means the request's own scheme and host are the truth.
   */
  url?: string;
  /**
   * The secret a platform edge in front of the forge sends with every
   * request it authenticated (`X-Plat-Edge-Token`), alongside the person's
   * name (`X-Plat-User`). Set, it makes such a request that person, signed
   * in by the platform. Unset, those headers are a claim and are ignored.
   */
  edgeToken?: string;
  /**
   * In a preview of this forge run as another's app, the key the parent
   * signs its visitors' identity with (`FORGE_APP_IDENTITY_KEY`): set, a
   * visitor it names as an admin is the preview admin
   * (`spawn/preview-owner.ts`). Never set in production.
   */
  previewIdentityKey?: string;
  /**
   * Let anyone, not only an admin, migrate from a host inside the network
   * (loopback, private ranges): a forge run for one person on one machine.
   */
  migrateFromPrivateHosts?: boolean;
  /**
   * What the platform edge is called where a person signs in — the name on
   * the button that sends them to it. Unset, it is "the platform".
   */
  edgeName?: string;
  /**
   * What answers the forge's fixed-choice questions — which builder, how
   * big, whose fault — better than its rules do (`crew/decide.ts`). None
   * means the rules answer.
   */
  decider?: Decider;
  /**
   * The SSH host key's fingerprint, once the listener is up — what a person
   * compares against the one their client prints on first connect. Written
   * back by `serveForgeSsh` beside `sshPort`.
   */
  sshHostKey?: string;
  /**
   * The most the crew may spend across every repository in one UTC day.
   * Each repository has its own ceiling; this one is the forge's, so a
   * person raising three ceilings cannot raise the bill past the one they
   * meant. Undefined is no forge-wide ceiling.
   */
  crewCeilingUsd?: number;
  /**
   * How many runs one issue may start in a day before the crew parks it
   * and asks a person (`crew/guard.ts`). Undefined is `ISSUE_RUN_CAP`.
   */
  issueRunCap?: number;
  /**
   * How many planning passes the direction issue may start in a day
   * (`crew/guard.ts`). Undefined is `DIRECTION_RUN_CAP`.
   */
  directionRunCap?: number;
  /**
   * Where mail goes out: SMTP submission (`FORGE_SMTP_URL`, `FORGE_MAIL_FROM`).
   * Undefined is a forge that sends no mail; a newcomer's email then waits
   * for the owner's word.
   */
  mail?: MailConfig;
  /**
   * The most messages the forge sends in a day, to everyone together
   * (`actions/mail.ts`). Undefined is `FORGE_DAILY`.
   */
  mailDailyCap?: number;
  /** Stand-in for `mail` in tests: receives each message instead of SMTP. */
  mailer?: Mailer;
  /**
   * Proxies whose forwarded headers say who the client is
   * (\`FORGE_TRUSTED_PROXIES\`, CIDR ranges). Empty or absent, only this
   * machine is trusted to say so (\`http/peer.ts\`).
   */
  trustedProxies?: readonly string[];
  /** A header a trusted edge sets to the client's address (\`FORGE_CLIENT_IP_HEADER\`). */
  clientIpHeader?: string;
  /**
   * How often this process holds what it has open against each account's
   * standing in the database (\`http/caller.ts\`), so a suspension made by
   * another process — a roll's other half — reaches it too.
   * @default 5000
   */
  standingSweepMs?: number;
  /**
   * The SSH listener's port, once it is up — `serveForgeSsh` writes the real
   * one back here when it was asked for an ephemeral port. Every surface that
   * shows an `ssh://` clone URL reads it from here, so there is one answer.
   * Undefined means the forge is running without SSH.
   */
  sshPort?: number;
  /**
   * Refuse every sign-up that would make an account with only a password:
   * the web form, `POST /api/v1/users` and the terminal answer in words,
   * and `signUpWithPasskey` is the one way in. An operator's choice, off
   * by default: a username and a password sign up (#2923).
   */
  passkeyOnlySignup?: boolean;
  /**
   * The Turnstile secret (`FORGE_TURNSTILE_SECRET`). Set, signup refuses a
   * missing or bad token before it hashes a password or makes an account.
   * Unset, signup is open as before.
   */
  turnstileSecret?: string;
  /**
   * The Turnstile site key (`FORGE_TURNSTILE_SITEKEY`): public, it names the
   * widget `/signup` renders. The secret is only honoured with it, so signup
   * cannot be locked behind a widget the page never shows.
   */
  turnstileSiteKey?: string;
  /**
   * Stand-in for Cloudflare's siteverify in tests: with a secret set, asked
   * instead of the network. Without a secret it is never asked.
   */
  verifyHuman?: VerifyHuman;
  /**
   * The exact command the host forge gave this one to reach its terminal
   * (`FORGE_APP_SSH`), when it runs as an app of another forge (a spawned
   * child). Printed verbatim wherever the forge says how to connect.
   */
  appSsh?: string;
  /**
   * The rolling intent doc a person's build note is copied into, once,
   * under "## Iterator notes" (`core/intent_notes.ts`). Unset copies none.
   */
  notesIntent?: string;
  /**
   * The repository holding this forge's own code, as `owner/name`
   * (`FORGE_REPO`, e.g. `trevato-apps/forge`). A spawned child forks it,
   * so every child starts from the forge's code and can follow its
   * parent's updates. Unset, children are spawned without the fork.
   * It also marks the repository whose landings are checked out into
   * `releases/<sha>/` and preflighted (`release/`, #1662).
   */
  forgeRepo?: string;
  /**
   * The forge this one was spawned from (`FORGE_PARENT_URL`): https, no
   * credentials. Its `/releases.json` is read for the following page.
   */
  parentUrl?: string;
  /** Lets `parentUrl` be plain http. Tests only; boot never sets it. */
  parentLoopback?: boolean;
  /** How many `releases/<sha>/` checkouts to keep (`FORGE_RELEASES_KEEP`). @default 5 */
  releasesKeep?: number;
  /**
   * A green release of the forge's own code takes over the port instead of
   * waiting for a restart (`FORGE_SELF_SWAP=1`; `release/swap.ts`, #1663).
   * The listener is bound with SO_REUSEPORT so the new process can share it.
   */
  selfSwap?: boolean;
  /** How long a swapped-in release has to read healthy (`FORGE_SWAP_BUDGET_S`). @default 60000 */
  swapBudgetMs?: number;
}

export interface App {
  readonly config: ForgeConfig;
  readonly db: Database;
  readonly bus: EventBus;
  readonly log: Log;
  readonly reposRoot: string;
  readonly socketPath: string;
  /** Where the internal listener answers: `socketPath`, or a loopback port (`git/hook-address.ts`). */
  readonly hookAddress: { current: string };
  /** Per-boot secret every internal request must carry (`FORGE_HOOK_SECRET` in a hook's env). */
  readonly hookSecret: string;
  /** Aborted by `close()`: background pollers stop on it and write nothing after. */
  readonly closing: AbortController;
  /** What `vitals` turns into needs: this forge's own, not the process's. */
  readonly signals: { errors: ErrorLedger; refused: RefusedLedger };
  close(): void;
}

export function createApp(config: ForgeConfig): App {
  // Resolve to an absolute path up front. The socket path in particular must
  // be absolute: git runs hooks with the working directory set to the bare
  // repo, and the hook relays to this socket — a relative path (the default
  // FORGE_DATA=data) would resolve against the repo dir and never connect.
  const dataDir = resolve(config.dataDir);
  const reposRoot = join(dataDir, "repos");
  mkdirSync(reposRoot, { recursive: true });
  const socketPath = join(dataDir, `forge-${id()}.sock`);

  const dbPath = join(dataDir, "forge.db");
  const fresh = !existsSync(dbPath);
  const db = openDb(dbPath, migrationFiles);
  if (config.seedSignup === true) seedSignup(db, fresh);
  // Hand-installed new-account guards become the `guard_new_accounts`
  // setting (default off): drop the legacy triggers once, here, on boot.
  // Idempotent — a forge without them changes nothing.
  dropLegacyNewAccountGuards(db);
  const bus = new EventBus(db);
  const closing = new AbortController();

  // Every event durably enqueues webhook deliveries; the worker (main.ts)
  // sends them. Listener throws are swallowed by the bus, so this can never
  // break the action that produced the event.
  bus.subscribe((event) => enqueueForEvent(db, event));
  // What a push moves besides its own branch: the pulls it heads elsewhere,
  // and the forks whose default branch is still a copy of this one's.
  follow({
    db,
    reposRoot,
    bus,
    authorOf: (userId) => {
      const who = getUserById(db, userId);
      return who === undefined ? undefined : { id: who.id, ...commitIdentity(config, who) };
    },
  });

  const owner = id();
  const errors = forgeErrorLedger(owner);
  return {
    config: { ...config, dataDir },
    db,
    bus,
    log: createLog("forge", owner),
    signals: { errors, refused: new RefusedLedger() },
    reposRoot,
    // This process's own: two forges share a data directory for the length
    // of a release, and each spawns git with its own socket in the env.
    socketPath,
    hookAddress: { current: socketPath },
    hookSecret: randomBytes(32).toString("hex"),
    closing,
    close: () => {
      closing.abort();
      // The pooled `cat-file` readers for this forge's repos are processes,
      // and processes outlive a closed database unless somebody says
      // otherwise. One data dir is one forge, so closing the forge is where
      // that is said.
      releaseErrorLedger(errors);
      closeReadersUnder(reposRoot);
      db.close();
    },
  };
}
