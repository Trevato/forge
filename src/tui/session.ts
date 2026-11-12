/**
 * Who is at the other end of a terminal session, and the handful of things
 * every screen needs from the forge.
 *
 * The identity rule: a session acts as the account its *key* maps to, and
 * nothing else. `authorize` lets every well-formed key in — a guest browses
 * public repos exactly as an anonymous web visitor does — and signing in is
 * the act of proving a password and *linking* this key to that account, after
 * which the same connection is that user. There is no impersonation path
 * here; the dev runner has one, over stdio only, and it is not reachable over
 * SSH.
 */

import type { App } from "../app.ts";
import { addSshKey } from "../actions/users.ts";
import { setPreference } from "../actions/users.ts";
import { touchKey, type UserKey } from "../core/keys.ts";
import { getUserSetting } from "../core/settings.ts";
import { getUserById, verifyPasswordThrottled, type User } from "../core/users.ts";
import type { Repo } from "../core/repos.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { isThemeName, type ThemeName } from "../design/themes.ts";
import { GRAPHICS_KEY, ICONS_KEY } from "./term/graphics.ts";
import { readGraphicsPrefs, type GraphicsPrefs } from "./ui/image.ts";

export interface TuiIdentity {
  /** The login name the client asked for. Decorative: the key decides. */
  readonly sshUsername: string;
  readonly remoteAddress: string;
  /** The key the client authenticated with, if this is an SSH session. */
  readonly fingerprint?: string | undefined;
  /** That key as an `authorized_keys` line, for linking on sign-in. */
  readonly publicKey?: string | undefined;
  /** The registered key row this session matched, when it matched one. */
  readonly keyId?: string | undefined;
  /** The account the key resolved to. Absent means a guest. */
  readonly user?: User | undefined;
}

export type SignInError =
  | "bad_credentials"
  | "throttled"
  | "invalid_key"
  | "key_exists"
  | "unauthorized";

/**
 * One terminal session's view of the forge. Screens take this, never the raw
 * `App` plus a user — so no screen can accidentally act as someone else.
 */
export class Session {
  user: User | undefined;
  keyId: string | undefined;

  constructor(
    readonly app: App,
    readonly identity: TuiIdentity,
  ) {
    this.user = identity.user;
    this.keyId = identity.keyId;
  }

  get db(): App["db"] {
    return this.app.db;
  }

  get signedIn(): boolean {
    return this.user !== undefined;
  }

  /** The bare repo on disk. Every git read in a screen goes through this. */
  dir(repo: Repo): string {
    return repoDir(this.app.reposRoot, repo.ownerName, repo.name);
  }

  /** Re-read the account row after a profile change. */
  refresh(): void {
    if (this.user) this.user = getUserById(this.db, this.user.id) ?? this.user;
  }

  /** Is this the key the session is holding? — the "this session" marker. */
  isCurrentKey(key: UserKey): boolean {
    return key.id === this.keyId;
  }

  theme(fallback: ThemeName = "dark"): ThemeName {
    if (!this.user) return fallback;
    const stored = getUserSetting(this.db, this.user.id, "theme");
    return stored !== undefined && isThemeName(stored) ? stored : fallback;
  }

  saveTheme(name: ThemeName): void {
    setPreference(this.app, this.user, "theme", name);
  }

  /**
   * The two terminal preferences, as stored. A guest has none and gets
   * `auto` for both — the settings exist to override a guess, never to
   * enable the feature.
   */
  terminalPrefs(): GraphicsPrefs {
    return readGraphicsPrefs(this.db, this.user?.id);
  }

  savePrefs(prefs: GraphicsPrefs): void {
    setPreference(this.app, this.user, GRAPHICS_KEY, prefs.graphics);
    setPreference(this.app, this.user, ICONS_KEY, prefs.icons);
  }

  /**
   * Per-connection scratch space a screen keeps between visits — the
   * workspace's open tabs, keyed by repository.
   *
   * It hangs off the *session* and nowhere else, which is the whole security
   * property: one connection is one identity, so nothing another user opened
   * can be reached from here, and the memory dies with the connection.
   */
  readonly scratch = new Map<string, unknown>();

  /**
   * Prove a password, become that user for the rest of this connection, and
   * register the presenting key against the account so the next connection
   * needs no password. The key cannot already exist: this path only runs when
   * the fingerprint lookup missed.
   */
  async signIn(
    username: string,
    password: string,
  ): Promise<Result<User, SignInError>> {
    const verified = await verifyPasswordThrottled(this.db, {
      username,
      password,
      source: this.identity.remoteAddress,
    });
    if (!verified.ok) return err(verified.error.reason === "waiting" ? "bad_credentials" : verified.error.reason);
    return this.adopt(verified.value);
  }

  /** Take on an account and link the session's key to it. */
  adopt(user: User): Result<User, SignInError> {
    const line = this.identity.publicKey;
    if (line !== undefined && this.keyId === undefined) {
      const added = addSshKey(this.app, user, {
        name: `terminal · ${this.identity.sshUsername}@${this.identity.remoteAddress}`,
        key: line,
      });
      if (!added.ok) return added;
      this.keyId = added.value.id;
    }
    this.user = user;
    if (this.keyId !== undefined) touchKey(this.db, this.keyId);
    return ok(user);
  }
}
