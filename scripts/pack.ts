/**
 * `bun scripts/pack.ts <show|deploy|up> <pack>` — a forge pack on your machine.
 *
 *   bun scripts/pack.ts up games        # the one command: boots a forge, deploys, asks nothing
 *   bun scripts/pack.ts show games
 *   FORGE_URL=http://localhost:3000 FORGE_TOKEN=forge_… bun scripts/pack.ts deploy games
 *
 * `<pack>` is a shipped pack's name, or the path of a pack.json. `deploy` makes
 * each app in the forge at FORGE_URL (the token's owner owns them), copies the
 * source's whole history in, and adds the crew. It brings no data, secret or
 * variable, and leaves the model credential to you. Run it again to finish a
 * partial deploy: what exists is kept. Docs: docs/features/packs.md.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ForgeApi } from "../src/cli/api.ts";
import { packNamed } from "../src/packs/catalog.ts";
import { deployPack, type Hands } from "../src/packs/deploy.ts";
import { parsePack, type Pack } from "../src/packs/pack.ts";
import { finishWords, OWNER, prepareOwner } from "../src/packs/up.ts";

function load(arg: string): Pack | string {
  if (/^[a-z][a-z0-9-]*$/.test(arg) && !existsSync(arg)) return packNamed(arg) ?? `no pack named ${arg}`;
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
      const made = await api.newApp({ name, description, visibility: "public" });
      if (made.ok) return { ok: true, owner: made.value.pin.owner };
      const e = made.error;
      const exists = e.status === 409 || e.code === "name_taken";
      if (!exists) return { ok: false, exists, why: e.message };
      const me = await api.whoami();
      return me.ok && me.value.username !== "" ? { ok: false, exists, why: e.message, owner: me.value.username } : { ok: false, exists, why: e.message };
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
        const cloned = await git(["clone", "--bare", "--quiet", ...(branch === undefined ? [] : ["--branch", branch]), options.cloneFrom?.(source) ?? source, bare], cloneEnv());
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

const USAGE = "usage: bun scripts/pack.ts <show|deploy|up> <pack>";

export interface UpOptions {
  readonly port: number;
  readonly dataDir: string;
  /** Where to clone a pack's source from (a test's local repository). */
  readonly cloneFrom?: (source: string) => string;
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
    const steps = await deployPack(pack, realHands(url, prepared.token, options.cloneFrom === undefined ? {} : { cloneFrom: options.cloneFrom }));
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
  const [verb, which] = process.argv.slice(2);
  const pack = which === undefined ? USAGE : load(which);
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
    console.error("deploy needs FORGE_URL and FORGE_TOKEN: the forge to fill and a token of the account that will own the apps");
    process.exit(2);
  }
  const steps = await deployPack(pack, realHands(url, token));
  for (const s of steps) console.log(`${mark(s)} ${s.what}${s.note ? ` — ${s.note}` : ""}`);
  const failed = steps.some((s) => s.state === "failed");
  console.log(failed ? "\nSome steps failed; run it again to finish." : `\n${pack.title} is deployed. Add your model credential in Settings to start the crew.`);
  process.exit(failed ? 1 : 0);
}
