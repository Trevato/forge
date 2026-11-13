/**
 * `bun scripts/pack.ts <show|deploy|up> <pack>` — a forge pack on your machine.
 *
 *   bun scripts/pack.ts up games        # the one command: boots a forge, deploys, asks nothing
 *   bun scripts/pack.ts show games
 *   FORGE_URL=http://localhost:3000 FORGE_TOKEN=forge_… bun scripts/pack.ts deploy games
 *   FORGE_URL=… FORGE_TOKEN=… bun scripts/pack.ts deploy games --org leagues
 *   # or set FORGE_ORG=leagues; the flag wins when both are set
 *
 * `<pack>` is the name of a pack repo (`packs/<name>` on FORGE_PACKS_FROM, default the public forge), or the path of a pack.json. `deploy` makes
 * each app in the forge at FORGE_URL (the token's account owns them, or FORGE_ORG/--org when set), copies the
 * source's whole history in, and adds the crew. It brings no data, secret or
 * variable, and leaves the model credential to you. Run it again to finish a
 * partial deploy: what exists is kept. Docs: docs/features/packs.md.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli/args.ts";
import { ForgeApi } from "../src/cli/api.ts";
import { guardSource, type SourceGuardOptions } from "../src/packs/source_guard.ts";
import { deployPack, type Hands } from "../src/packs/deploy.ts";
import { parsePack, type Pack } from "../src/packs/pack.ts";
import { finishWords, OWNER, prepareOwner } from "../src/packs/up.ts";

/** Where a pack's name is looked up: the forge whose `packs/<name>` repository holds its pack.json. */
export const PACKS_FORGE = "https://forge.open-platform.sh";

/** The pack `<name>` as published at `packs/<name>` on `origin` (its default branch, whatever it is called), or why not. */
export async function fetchPack(name: string, origin: string, get: typeof fetch = fetch): Promise<Pack | string> {
  const url = `${origin.replace(/\/+$/, "")}/packs/${name}/raw/HEAD/pack.json`;
  try {
    const res = await get(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (res.status !== 200) return `no pack named ${name} at ${url} (${res.status})`;
    const parsed = parsePack(await res.text());
    return parsed.ok ? parsed.value : `${url}: ${parsed.error}`;
  } catch {
    return `could not read ${url}`;
  }
}

async function load(arg: string): Promise<Pack | string> {
  if (/^[a-z][a-z0-9-]*$/.test(arg) && !existsSync(arg)) return fetchPack(arg, process.env.FORGE_PACKS_FROM ?? PACKS_FORGE);
  if (!existsSync(arg)) return `no such file: ${arg}`;
  const parsed = parsePack(readFileSync(arg, "utf8"));
  return parsed.ok ? parsed.value : parsed.error;
}

const baseEnv = (): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: tmpdir(),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
});

/** The environment for cloning a pack's source: a stranger's host, so no credential at all. */
export const cloneEnv = (): Record<string, string> => baseEnv();

/**
 * The address `git clone` uses for a pack source. The pack format stores the
 * repository without a `.git` suffix, which GitHub still serves, but this
 * forge only answers `git clone` at `https://host/owner/name.git`.
 */
export function cloneUrl(source: string): string {
  return source.endsWith(".git") ? source : `${source}.git`;
}

/**
 * The environment for the push: the credential is scoped to the forge's own address
 * (`http.<url>/.extraHeader`), so git sends it nowhere else. It rides in the
 * environment, never in an argument another process could list.
 */
export const pushEnv = (url: string, token: string): Record<string, string> => ({
  ...baseEnv(),
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: `http.${url.replace(/\/+$/, "")}/.extraHeader`,
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`x:${token}`)}`,
});

async function git(args: string[], env: Record<string, string>, cwd?: string): Promise<string | null> {
  const p = Bun.spawn(["git", ...args], { env, ...(cwd === undefined ? {} : { cwd }), stdout: "ignore", stderr: "pipe" });
  const [code, errText] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  return code === 0 ? null : errText.trim().split("\n").at(-1) ?? "git failed";
}

export interface HandsOptions {
  /** Where to clone a pack's source from, when not the address the pack names (a test's local repository). */
  readonly cloneFrom?: (source: string) => string;
  /** Create apps in this organization instead of the token's account. */
  readonly org?: string;
  /** How a source's host is judged (resolver, exempt addresses): a test's seam. The forge's own address is always let through. */
  readonly guard?: SourceGuardOptions;
}

/**
 * The organization `deploy` installs into, if any: `--org` wins over `FORGE_ORG`.
 * An empty value is no target. The name is handed to the forge as `owner`.
 */
export function deployOrg(flag: string | undefined, env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = (flag ?? env.FORGE_ORG ?? "").trim();
  return raw === "" ? undefined : raw;
}

async function gitOut(args: string[], env: Record<string, string>, cwd: string): Promise<string | null> {
  const p = Bun.spawn(["git", ...args], { env, cwd, stdout: "pipe", stderr: "ignore" });
  const [code, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
  return code === 0 && out.trim() !== "" ? out.trim() : null;
}

export function realHands(url: string, token: string, options: HandsOptions = {}): Hands {
  const api = new ForgeApi(url, token);
  return {
    async makeApp(name, description) {
      const made = await api.newApp({
        name,
        description,
        visibility: "public",
        ...(options.org === undefined ? {} : { owner: options.org }),
      });
      if (made.ok) return { ok: true, owner: made.value.pin.owner };
      const e = made.error;
      const exists = e.status === 409 || e.code === "name_taken";
      if (!exists) return { ok: false, exists, why: e.message };
      if (options.org !== undefined) return { ok: false, exists, why: e.message, owner: options.org };
      const me = await api.whoami();
      return me.ok && me.value.username !== "" ? { ok: false, exists, why: e.message, owner: me.value.username } : { ok: false, exists, why: e.message };
    },
    async forkFrom(source, name) {
      const r = await fetch(`${url}/api/v1/repos/${source}/forks`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }).catch(() => null);
      if (r === null) return { ok: false, exists: false, why: `cannot reach ${url}` };
      const body = (await r.json().catch(() => null)) as { ownerName?: unknown; name?: unknown; message?: unknown } | null;
      if (r.ok && typeof body?.ownerName === "string") return { ok: true, owner: body.ownerName };
      const why = typeof body?.message === "string" ? body.message : `the forge answered ${r.status}`;
      if (r.status !== 409) return { ok: false, exists: false, why };
      const me = await api.whoami();
      return me.ok && me.value.username !== "" ? { ok: false, exists: true, why, owner: me.value.username } : { ok: false, exists: true, why };
    },
    async defaultBranch(owner, name) {
      const r = await fetch(`${url}/api/v1/repos/${owner}/${name}`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
      const body = r?.ok ? ((await r.json().catch(() => null)) as { defaultBranch?: unknown } | null) : null;
      return typeof body?.defaultBranch === "string" && body.defaultBranch !== "" ? body.defaultBranch : undefined;
    },
    async carryHistory(source, owner, name, branch) {
      const dir = mkdtempSync(join(tmpdir(), "pack-"));
      try {
        const bare = join(dir, "src.git");
        // Source history is fetched without hooks or templates and pushed as plain branches and tags.
        const from = options.cloneFrom?.(source) ?? cloneUrl(source);
        // The address the pack names is judged and pinned before any connection, whatever is cloned
        // in its place: no internal host, no redirect, port 443 (#11971). A test's local clone keeps
        // git's plain environment, since the pinned one allows only http and https.
        const guarded = await guardSource(cloneUrl(source), cloneEnv(), { forge: url, ...options.guard });
        if (!guarded.ok) return { ok: false, why: guarded.error };
        const cloned = await git(["clone", "--bare", "--quiet", ...(branch === undefined ? [] : ["--branch", branch]), from, bare], options.cloneFrom === undefined ? guarded.value : cloneEnv());
        if (cloned !== null) return { ok: false, why: cloned };
        const pushed = await git(
          ["push", "--quiet", "--force", `${url}/${owner}/${name}.git`, "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"],
          pushEnv(url, token),
          bare,
        );
        if (pushed !== null) return { ok: false, why: pushed };
        const head = await gitOut(["symbolic-ref", "--short", "HEAD"], cloneEnv(), bare);
        if (head === null) return { ok: true };
        // The app's default branch is where the history is, so its page, its pulls and the drift check read the same line.
        const set = await fetch(`${url}/api/v1/repos/${owner}/${name}`, {
          method: "PATCH",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ defaultBranch: head }),
        }).catch(() => null);
        if (set === null || !set.ok) return { ok: false, why: `history carried, default branch not set to ${head}` };
        return { ok: true, branch: head };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    async follow(owner, name, source, branch) {
      if (branch === undefined) return { ok: false, why: "no branch to follow: the pack names none and the clone gave none" };
      const was = await fetch(`${url}/api/v1/repos/${owner}/${name}/upstream`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
      const seen = was?.ok ? ((await was.json().catch(() => null)) as { following?: { enabled?: boolean } | null } | null) : null;
      // Already following (an earlier run, or the person's own choice): leave it be.
      if (seen?.following?.enabled === true) return { ok: true };
      const r = await fetch(`${url}/api/v1/repos/${owner}/${name}/upstream`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ url: source, branch, enabled: true }),
      }).catch(() => null);
      if (r === null) return { ok: false, why: `cannot reach ${url}` };
      if (r.ok) return { ok: true };
      return { ok: false, why: `the forge answered ${r.status}` };
    },
    async absorb(owner, name) {
      const auth = { authorization: `Bearer ${token}` };
      const listed = await fetch(`${url}/api/v1/features`, { headers: auth }).catch(() => null);
      if (listed === null || !listed.ok) return { ok: false, why: listed === null ? `cannot reach ${url}` : `the forge answered ${listed.status}` };
      const body = (await listed.json().catch(() => null)) as { items?: { slug?: string; repo?: string }[] } | null;
      const row = body?.items?.find((f) => f.repo === `${owner}/${name}`);
      if (typeof row?.slug !== "string") return { ok: false, why: "the app declares no feature in its forge.json, so there is nothing to absorb" };
      const r = await fetch(`${url}/api/v1/features/${encodeURIComponent(row.slug)}`, { method: "PUT", headers: auth }).catch(() => null);
      if (r === null) return { ok: false, why: `cannot reach ${url}` };
      if (r.ok) return { ok: true };
      if (r.status === 403) return { ok: false, why: "the forge refused (403): absorbing needs a site admin's token with admin scope, and this token is not one" };
      return { ok: false, why: `the forge answered ${r.status}` };
    },
    async makeAgent(a) {
      const r = await fetch(`${url}/api/v1/agents`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ username: a.username, roles: a.roles, brief: a.brief, ...(a.model ? { model: a.model } : {}), ...(a.budgetUsd !== undefined ? { budgetUsd: a.budgetUsd } : {}) }),
      }).catch(() => null);
      if (r === null) return { ok: false, exists: false, why: `cannot reach ${url}` };
      if (r.ok) return { ok: true };
      if (r.status === 409) return { ok: false, exists: true, why: "exists" };
      // A taken username is refused as 422; only a crew member that is really there counts as kept.
      const there = r.status === 422 ? await fetch(`${url}/api/v1/agents/${encodeURIComponent(a.username)}`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null) : null;
      return { ok: false, exists: there?.ok === true, why: `the forge answered ${r.status}` };
    },
  };
}

const USAGE = "usage: bun scripts/pack.ts <show|deploy|up> <pack> [--org <org>]";

export interface UpOptions {
  readonly port: number;
  readonly dataDir: string;
  /** Where to clone a pack's source from (a test's local repository). */
  readonly cloneFrom?: (source: string) => string;
  /** How a source's host is judged: a test's seam, passed to the hands. */
  readonly guard?: SourceGuardOptions;
  /** Where the words go; the console by default. */
  readonly say?: (line: string) => void;
  /** Aborting stops the forge and ends `up`; Ctrl-C and SIGTERM do the same. */
  readonly signal?: AbortSignal;
  /** The environment the credential is read from and the forge is started with. */
  readonly env?: Record<string, string | undefined>;
}

const mark = (s: { state: string }): string => (s.state === "done" ? "✓" : s.state === "kept" ? "·" : "✗");

/** One command: prepare the owner, boot this tree's forge, deploy the pack into it, then stay up until stopped. */
export async function up(pack: Pack, options: UpOptions): Promise<number> {
  const say = options.say ?? ((l: string) => console.log(l));
  const env = options.env ?? process.env;
  const url = `http://localhost:${options.port}`;
  const prepared = await prepareOwner(options.dataDir, env);
  const child = Bun.spawn([process.execPath, "run", join(import.meta.dir, "..", "src", "main.ts")], {
    env: { ...env, FORGE_DATA: options.dataDir, PORT: String(options.port), FORGE_URL: url },
    stdout: "inherit",
    stderr: "inherit",
  });
  const stop = () => child.kill();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  options.signal?.addEventListener("abort", stop);
  try {
    let ready = false;
    for (let i = 0; i < 150 && !ready && child.exitCode === null; i++) {
      ready = await fetch(`${url}/healthz`).then((r) => r.ok, () => false);
      if (!ready) await Bun.sleep(200);
    }
    if (!ready) {
      say("the forge did not come up; its log is above");
      stop();
      await child.exited;
      return 1;
    }
    const steps = await deployPack(pack, realHands(url, prepared.token, {
        ...(options.cloneFrom === undefined ? {} : { cloneFrom: options.cloneFrom }),
        ...(options.guard === undefined ? {} : { guard: options.guard }),
      }));
    for (const s of steps) say(`${mark(s)} ${s.what}${s.note ? ` — ${s.note}` : ""}`);
    if (prepared.passphrase !== undefined) say(`\nSign in as "${OWNER}" with the passphrase kept in ${prepared.passphraseFile}`);
    for (const line of finishWords(url, prepared.credential)) say(line);
    if (steps.some((s) => s.state === "failed")) say("Some steps failed; run the command again to finish.");
    return await child.exited;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2), { values: ["org"] });
  const verb = args.command;
  const which = args.positional[0];
  const pack = which === undefined ? USAGE : await load(which);
  if (typeof pack === "string" || (verb !== "show" && verb !== "deploy" && verb !== "up")) {
    console.error(typeof pack === "string" ? pack : USAGE);
    process.exit(2);
  }
  if (verb === "up") process.exit(await up(pack, { port: Number(process.env.PORT ?? 3000), dataDir: process.env.FORGE_DATA ?? "forge-data" }));
  if (verb === "show") {
    console.log(`${pack.title} ${pack.version}\n${pack.description}\n`);
    for (const a of pack.apps) console.log(`  app   ${a.name.padEnd(14)} ${a.source}`);
    for (const c of pack.crew) console.log(`  crew  ${c.username.padEnd(14)} ${c.roles.join(", ")}`);
    process.exit(0);
  }
  const url = (process.env.FORGE_URL ?? "").replace(/\/+$/, "");
  const token = process.env.FORGE_TOKEN ?? "";
  if (url === "" || token === "") {
    console.error("deploy needs FORGE_URL and FORGE_TOKEN: the forge to fill and a token that can create the apps (in FORGE_ORG or --org, when set)");
    process.exit(2);
  }
  const org = deployOrg(args.value("org"));
  const steps = await deployPack(pack, realHands(url, token, org === undefined ? {} : { org }));
  for (const s of steps) console.log(`${mark(s)} ${s.what}${s.note ? ` — ${s.note}` : ""}`);
  const failed = steps.some((s) => s.state === "failed");
  console.log(failed ? "\nSome steps failed; run it again to finish." : `\n${pack.title} is deployed. Add your model credential in Settings to start the crew.`);
  process.exit(failed ? 1 : 0);
}
