/**
 * Where machines meet the rest of the crew (#9418): the brief names the
 * machine's tools, and a repository's machines are read at the default
 * branch's tip, never at a side branch an agent could have edited.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "../src/app.ts";
import { systemPrompt, type BriefInput } from "../src/crew/brief.ts";
import { machineFor, SECURITY, STANDARD } from "../src/crew/machines.ts";
import { repoMachines } from "../src/crew/machines_read.ts";
import type { Repo } from "../src/core/repos.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const prompt = (machine: BriefInput["machine"]) =>
  systemPrompt({
    agent: { user: { username: "bot", displayName: "" }, brief: "" },
    repo: { ownerName: "alice", name: "notes", defaultBranch: "main", autonomyDirection: "" },
    issue: { number: 7, title: "t", body: "", authorName: "alice" },
    branch: "bot/7",
    forgeUrl: "http://forge.test",
    isApp: true,
    resuming: false,
    machine,
  } as unknown as BriefInput);

test("the system prompt names a machine's tools, and the standard machine adds nothing", () => {
  expect(prompt(SECURITY)).toContain("Your shell runs in the `security` machine");
  expect(prompt(SECURITY)).toContain("gitleaks");
  expect(prompt(STANDARD)).not.toContain("Your shell runs in");
  expect(prompt(undefined)).toBe(prompt(STANDARD));
});

const env = gitClientEnv({
  GIT_AUTHOR_NAME: "A",
  GIT_AUTHOR_EMAIL: "a@forge.local",
  GIT_COMMITTER_NAME: "A",
  GIT_COMMITTER_EMAIL: "a@forge.local",
});
const roots: string[] = [];
afterAll(() => Promise.all(roots.map((d) => rm(d, { recursive: true, force: true }))));

async function git(args: string[], cwd: string): Promise<void> {
  const p = Bun.spawn(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
}

test("a repository's machines are read at the default branch's tip, not a side branch's", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-machines-"));
  roots.push(root);
  const dir = join(root, "alice", "notes.git");
  await mkdir(dir, { recursive: true });
  await git(["init", "-q", "-b", "main", dir], dir);
  // A bare repository has no work tree; build commits with plumbing.
  const commit = async (ref: string, text: string) => {
    await writeFile(join(root, "forge.json"), text);
    const blob = await hashObject(dir, join(root, "forge.json"));
    const tree = await plumb(dir, ["mktree"], `100644 blob ${blob}\tforge.json\n`);
    const oid = await plumb(dir, ["commit-tree", tree, "-m", ref], "");
    await git(["update-ref", `refs/heads/${ref}`, oid], dir);
  };
  await commit("main", JSON.stringify({ machines: { shut: { reach: [] } }, machineFor: { reviewer: "shut" } }));
  await commit("bot/7", JSON.stringify({ machines: { wide: { tools: ["nmap"] } }, machineFor: { reviewer: "wide" } }));

  const app = { reposRoot: root } as unknown as App;
  const repo = { ownerName: "alice", name: "notes", defaultBranch: "main" } as unknown as Repo;
  const config = await repoMachines(app, repo);
  expect(machineFor(config, "reviewer").name).toBe("shut");
  expect(config.machines.some((m) => m.name === "wide")).toBe(false);

  // And the default branch moving is what changes the answer.
  await git(["update-ref", "refs/heads/main", (await plumb(dir, ["rev-parse", "refs/heads/bot/7"], "")) ], dir);
  expect(machineFor(await repoMachines(app, repo), "reviewer").name).toBe("wide");
});

async function plumb(dir: string, args: string[], stdin: string): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd: dir, env, stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out.trim();
}
const hashObject = (dir: string, file: string) => plumb(dir, ["hash-object", "-w", file], "");
