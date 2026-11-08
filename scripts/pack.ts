/**
 * `bun scripts/pack.ts <show|deploy> <pack>` — a forge pack on your machine.
 *
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

export function realHands(url: string, token: string): Hands {
  const api = new ForgeApi(url, token);
  return {
    async makeApp(name, description) {
      const made = await api.newApp({ name, description, visibility: "public" });
      if (made.ok) return { ok: true, owner: made.value.pin.owner };
      const e = made.error;
      return { ok: false, exists: e.status === 409, why: e.message };
    },
    async carryHistory(source, owner, name, branch) {
      const dir = mkdtempSync(join(tmpdir(), "pack-"));
      try {
        const bare = join(dir, "src.git");
        // Source history is fetched without hooks or templates and pushed as plain branches and tags.
        const cloned = await git(["clone", "--bare", "--quiet", ...(branch === undefined ? [] : ["--branch", branch]), source, bare], cloneEnv());
        if (cloned !== null) return { ok: false, why: cloned };
        const pushed = await git(
          ["push", "--quiet", "--force", `${url}/${owner}/${name}.git`, "refs/heads/*:refs/heads/*", "refs/tags/*:refs/tags/*"],
          pushEnv(url, token),
          bare,
        );
        return pushed === null ? { ok: true } : { ok: false, why: pushed };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    async makeAgent(a) {
      const r = await fetch(`${url}/api/v1/agents`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ username: a.username, roles: a.roles, brief: a.brief, ...(a.model ? { model: a.model } : {}), ...(a.budgetUsd !== undefined ? { budgetUsd: a.budgetUsd } : {}) }),
      }).catch(() => null);
      if (r === null) return { ok: false, exists: false, why: `cannot reach ${url}` };
      if (r.ok) return { ok: true };
      return { ok: false, exists: r.status === 409, why: `the forge answered ${r.status}` };
    },
  };
}

if (import.meta.main) {
  const [verb, which] = process.argv.slice(2);
  const pack = which === undefined ? "usage: bun scripts/pack.ts <show|deploy> <pack>" : load(which);
  if (typeof pack === "string" || (verb !== "show" && verb !== "deploy")) {
    console.error(typeof pack === "string" ? pack : "usage: bun scripts/pack.ts <show|deploy> <pack>");
    process.exit(2);
  }
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
  for (const s of steps) console.log(`${s.state === "done" ? "✓" : s.state === "kept" ? "·" : "✗"} ${s.what}${s.note ? ` — ${s.note}` : ""}`);
  const failed = steps.some((s) => s.state === "failed");
  console.log(failed ? "\nSome steps failed; run it again to finish." : `\n${pack.title} is deployed. Add your model credential in Settings to start the crew.`);
  process.exit(failed ? 1 : 0);
}
