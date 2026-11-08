/**
 * Where the client keeps the two facts it needs: which forge, and the token
 * that proves who you are.
 *
 * The token is a credential, so the file is 0600 and, on macOS, the token is
 * not in the file at all — it goes to the login keychain via the `security`
 * CLI, and the file records only that it lives there. That is the platform's
 * own store, reachable without a dependency, and it means a stolen dotfile
 * is not a stolen account. Everywhere else (and whenever the keychain is
 * unavailable or refuses) the token falls back to the 0600 file, which is
 * what every other CLI does and is honest about being.
 *
 * `FORGE_URL` / `FORGE_TOKEN` override both, so a script or a test never has
 * to write a config at all.
 *
 * Plain http to another machine is refused (#7377): every request carries
 * the token, and over http it crosses the network in clear. Loopback is
 * fine — it never leaves the machine. `forge login --insecure` is the one
 * way past it, and it is remembered with that workbench only.
 */

import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface Config {
  readonly url: string;
  readonly token: string;
}

/** The stored shape. `token` is absent when the keychain holds it. */
interface StoredConfig {
  url: string;
  token?: string;
  keychain?: boolean;
  /** `forge login --insecure`: plain http to this one workbench is allowed. */
  insecure?: boolean;
}

/** The one line every refusal of a plain-http workbench prints. */
export const PLAIN_HTTP_REFUSAL =
  "plain http sends your token in clear; use https, or --insecure for a host you trust";

/**
 * True when `url` is `http://` to a host other than this machine. Hosts are
 * compared as `URL` parses them, so `LOCALHOST` and `127.0.0.1:3000` are
 * loopback and `localhost.evil.example` is not. An address that does not
 * parse is not plain http; the request itself will say what is wrong.
 */
export function plainHttpRemote(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  return !LOOPBACK.has(parsed.hostname);
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const SERVICE = "forge-cli";

export function configDir(): string {
  const explicit = process.env["FORGE_CONFIG_DIR"];
  if (explicit !== undefined && explicit !== "") return resolve(explicit);
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base =
    xdg !== undefined && xdg !== "" ? xdg : join(homedir(), ".config");
  return join(base, "forge");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

/** Where clones live: `FORGE_ROOT`, else `~/src`. */
export function rootDir(override?: string): string {
  const chosen = override ?? process.env["FORGE_ROOT"];
  if (chosen !== undefined && chosen !== "")
    return resolve(chosen.replace(/^~(?=$|\/)/, homedir()));
  return join(homedir(), "src");
}

/**
 * The keychain is used when it is macOS, `security` is on the PATH, and the
 * user has not turned it off. A test or a CI run sets `FORGE_KEYCHAIN=0` and
 * never touches the real login keychain.
 */
export function keychainAvailable(): boolean {
  if (process.env["FORGE_KEYCHAIN"] === "0") return false;
  return process.platform === "darwin";
}

async function security(
  args: readonly string[],
  stdin?: string,
): Promise<string | null> {
  try {
    const proc = Bun.spawn(["security", ...args], {
      stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
      stdout: "pipe",
      stderr: "ignore",
    });
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    return code === 0 ? out.replace(/\n$/, "") : null;
  } catch {
    // No `security` binary: not an error, just not this machine.
    return null;
  }
}

async function keychainSet(url: string, token: string): Promise<boolean> {
  // `-U` updates in place; `-w` takes the secret. It is one argv away from
  // the process list either way, which is why the file fallback exists.
  const out = await security([
    "add-generic-password",
    "-a",
    url,
    "-s",
    SERVICE,
    "-w",
    token,
    "-U",
  ]);
  return out !== null;
}

async function keychainGet(url: string): Promise<string | null> {
  return security(["find-generic-password", "-a", url, "-s", SERVICE, "-w"]);
}

async function keychainDelete(url: string): Promise<void> {
  await security(["delete-generic-password", "-a", url, "-s", SERVICE]);
}

export type ConfigError = "no_config" | "no_token" | "plain_http";

export interface Loaded {
  readonly config: Config;
  /** True when the token came from the keychain rather than the file. */
  readonly fromKeychain: boolean;
}

/**
 * Read the config, with the environment winning over the file. A plain-http
 * remote address is refused here, before any request is made, unless the
 * stored workbench is that same address and was signed in with `--insecure`.
 */
export async function loadConfig(): Promise<Loaded | ConfigError> {
  const envUrl = process.env["FORGE_URL"];
  const envToken = process.env["FORGE_TOKEN"];
  const hasEnvUrl = envUrl !== undefined && envUrl !== "";
  const stored = await readStored();
  if (hasEnvUrl && envToken !== undefined) {
    const url = normalizeUrl(envUrl);
    if (plainHttpRemote(url) && !allowedInsecure(stored, url))
      return "plain_http";
    return { config: { url, token: envToken }, fromKeychain: false };
  }

  if (stored === null) return "no_config";
  const url = normalizeUrl(hasEnvUrl ? envUrl : stored.url);
  if (plainHttpRemote(url) && !allowedInsecure(stored, url))
    return "plain_http";

  if (envToken !== undefined && envToken !== "")
    return { config: { url, token: envToken }, fromKeychain: false };
  if (stored.keychain === true) {
    const token = await keychainGet(stored.url);
    if (token !== null && token !== "")
      return { config: { url, token }, fromKeychain: true };
    return "no_token";
  }
  if (stored.token === undefined || stored.token === "") return "no_token";
  return { config: { url, token: stored.token }, fromKeychain: false };
}

function allowedInsecure(stored: StoredConfig | null, url: string): boolean {
  return (
    stored !== null &&
    stored.insecure === true &&
    normalizeUrl(stored.url) === url
  );
}

async function readStored(): Promise<StoredConfig | null> {
  const file = Bun.file(configPath());
  if (!(await file.exists())) return null;
  try {
    const parsed: unknown = JSON.parse(await file.text());
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record["url"] !== "string") return null;
    const out: StoredConfig = { url: record["url"] };
    if (typeof record["token"] === "string") out.token = record["token"];
    if (record["keychain"] === true) out.keychain = true;
    if (record["insecure"] === true) out.insecure = true;
    return out;
  } catch {
    return null;
  }
}

/**
 * Write the config, putting the token in the keychain where there is one.
 * `insecure` is stored only for a plain-http remote, the one place it means
 * anything, so the file never claims an exception it does not need.
 */
export async function saveConfig(
  config: Config,
  opts: { insecure?: boolean } = {},
): Promise<{ keychain: boolean }> {
  const url = normalizeUrl(config.url);
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const keychain =
    keychainAvailable() && (await keychainSet(url, config.token));
  const stored: StoredConfig = keychain
    ? { url, keychain: true }
    : { url, token: config.token };
  if (opts.insecure === true && plainHttpRemote(url)) stored.insecure = true;
  // Create the file before the secret goes in it: a chmod after the write is
  // a window, however short, where the token is world-readable.
  await writeFile(path, "", { mode: 0o600 });
  await chmod(path, 0o600);
  await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`, {
    mode: 0o600,
  });
  return { keychain };
}

export async function clearConfig(): Promise<void> {
  const stored = await readStored();
  if (stored !== null && stored.keychain === true)
    await keychainDelete(stored.url);
  await rm(configPath(), { force: true });
}

/** No trailing slash, and a bare host becomes http on localhost, else https. */
export function normalizeUrl(input: string): string {
  let text = input.trim();
  if (!/^https?:\/\//.test(text)) {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(text);
    text = `${local ? "http" : "https"}://${text}`;
  }
  return text.replace(/\/+$/, "");
}

/**
 * The directory name a forge gets under the root. A port is part of the
 * identity — two forges on one host must not share a tree — but a colon is
 * a poor path component, so it becomes an underscore.
 */
export function hostDir(url: string): string {
  const parsed = new URL(url);
  return parsed.port === ""
    ? parsed.hostname
    : `${parsed.hostname}_${parsed.port}`;
}
